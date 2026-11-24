"""Programa de extracción de ORTOSTEP.

Uso:
  python -m ortostep_worker vigilar            Revisa Supabase cada minuto y procesa pedidos nuevos.
  python -m ortostep_worker procesar OS-...     Procesa un pedido por folio o id.
  python -m ortostep_worker local CARPETA       Procesa una carpeta local (pedido.json + videos) sin Supabase.

Por cada pedido: descarga los videos de movimiento, calcula métricas de marcha y sentadilla,
arma la ficha de diseño (medidas, banderas, diseño sugerido) y la sube junto con un reporte HTML.
Si DISENO_CMD está configurado, llama al sistema de diseño de plantillas con la ficha.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

from . import exportacion
from . import ficha as ficha_mod
from . import marcha, reporte

VIDEOS_MOVIMIENTO = ("marcha-lateral", "marcha", "sentadilla")
# Estados de disenos que ya no se pisan: el sistema de plantillas los tomó, validó o rechazó.
ESTADOS_TOMADOS = {"en_cola_diseno", "stl_validado", "rechazado"}
EXTENSIONES = (".mp4", ".mov", ".webm", ".m4v", ".3gp", ".mkv", ".avi")


def cargar_env(ruta: str = ".env") -> None:
    if not os.path.exists(ruta):
        return
    with open(ruta, encoding="utf-8") as f:
        for linea in f:
            linea = linea.strip()
            if not linea or linea.startswith("#") or "=" not in linea:
                continue
            k, v = linea.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def cache_dir() -> str:
    return os.environ.get("ORTOSTEP_CACHE", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache"))


def analizar_videos(rutas: dict[str, str], estatura: float | None) -> dict:
    if not rutas:
        return {}
    modelo = marcha.ruta_modelo(cache_dir())
    out = {}
    for tipo in VIDEOS_MOVIMIENTO:
        ruta = rutas.get(tipo)
        if not ruta:
            continue
        try:
            t0 = time.time()
            out[tipo] = marcha.analizar(ruta, tipo, modelo, estatura)
            out[tipo]["segundos_proceso"] = round(time.time() - t0, 1)
        except Exception as e:  # un video malo no detiene el pedido
            out[tipo] = {"error": f"No se pudo analizar: {e}"}
    return out


def llamar_diseno(ruta_ficha: str, carpeta_salida: str, ruta_para_diseno: str = "") -> dict | None:
    """Puente con el sistema de diseño de plantillas (configurable con DISENO_CMD).
    El comando recibe {para_diseno} (formato acordado), {ficha} y {salida}; debe dejar sus
    archivos (STL, etc.) en {salida}."""
    cmd = os.environ.get("DISENO_CMD")
    if not cmd:
        return None
    os.makedirs(carpeta_salida, exist_ok=True)
    linea = cmd.format(ficha=ruta_ficha, salida=carpeta_salida, para_diseno=ruta_para_diseno)
    r = subprocess.run(linea, shell=True, capture_output=True, text=True, timeout=int(os.environ.get("DISENO_TIMEOUT", "900")))
    return {"comando": linea, "codigo": r.returncode, "salida": r.stdout[-4000:], "errores": r.stderr[-4000:],
            "archivos": sorted(os.listdir(carpeta_salida))}


def procesar_pedido(sb, pedido: dict, reglas: dict) -> dict:
    trabajo = tempfile.mkdtemp(prefix="ortostep_")
    try:
        archivos = pedido.get("archivos") or {}
        rutas = {}
        for tipo in VIDEOS_MOVIMIENTO:
            if archivos.get(tipo):
                ext = os.path.splitext(archivos[tipo])[1] or ".mp4"
                rutas[tipo] = sb.descargar(archivos[tipo], os.path.join(trabajo, tipo + ext))
        estatura = (pedido.get("datos") or {}).get("estatura_cm")
        metricas = analizar_videos(rutas, estatura)
        f = ficha_mod.construir_ficha(pedido, metricas, reglas)
        # Versión: si la última ficha ya la tomó el sistema de plantillas (o ya tiene STL o fue
        # rechazada), un reproceso crea una versión nueva en lugar de pisarla.
        ultimo = sb.ultimo_diseno(pedido["id"])
        version = 1
        if ultimo:
            version = ultimo["version"] + (1 if ultimo["estado"] in ESTADOS_TOMADOS else 0)
        f["pedido"]["version_diseno"] = version
        base = f"{pedido['id']}/v{version}"
        ruta_ficha = os.path.join(trabajo, "ficha.json")
        with open(ruta_ficha, "w", encoding="utf-8") as fh:
            json.dump(f, fh, ensure_ascii=False, indent=2)
        exp = exportacion.para_diseno(pedido, f)
        exp["version_diseno"] = version
        ruta_exp = os.path.join(trabajo, "para_diseno.json")
        with open(ruta_exp, "w", encoding="utf-8") as fh:
            json.dump(exp, fh, ensure_ascii=False, indent=2)
        subidos = {
            "ficha": sb.subir(f"{base}/ficha.json", json.dumps(f, ensure_ascii=False, indent=2).encode("utf-8"), "application/json"),
            "reporte": sb.subir(f"{base}/reporte.html", reporte.generar(f).encode("utf-8"), "text/html"),
            "para_diseno": sb.subir(f"{base}/para_diseno.json", json.dumps(exp, ensure_ascii=False, indent=2).encode("utf-8"), "application/json"),
        }
        med = exportacion.medidas_json(f)
        if med:
            subidos["medidas"] = sb.subir(f"{base}/medidas.json", json.dumps(med, indent=2).encode("utf-8"), "application/json")
        diseno = None
        if not f["requiere_revision"]:
            diseno = llamar_diseno(ruta_ficha, os.path.join(trabajo, "diseno"), ruta_exp)
            if diseno and diseno["codigo"] == 0:
                for nombre in diseno["archivos"]:
                    ruta = os.path.join(trabajo, "diseno", nombre)
                    with open(ruta, "rb") as fh:
                        tipo = "model/stl" if nombre.lower().endswith(".stl") else "application/octet-stream"
                        subidos[nombre] = sb.subir(f"{base}/{nombre}", fh.read(), tipo)
        estado = "requiere_revision" if f["requiere_revision"] else ("disenado" if diseno and diseno["codigo"] == 0 else "ficha_lista")
        sb.guardar_diseno({
            "pedido": pedido["id"], "version": version, "estado": estado,
            "requiere_revision": f["requiere_revision"], "banderas": f["banderas"],
            "ficha": ficha_mod.ficha_sin_contornos(f), "archivos": subidos, "diseno_log": diseno,
        })
        sb.marcar_pedido(pedido["id"], estado)
        return {"folio": pedido.get("folio"), "version": version, "estado": estado, "banderas": len(f["banderas"])}
    finally:
        # Los videos son datos de salud: no se quedan en la computadora.
        shutil.rmtree(trabajo, ignore_errors=True)


def procesar_local(carpeta: str, reglas: dict) -> str:
    with open(os.path.join(carpeta, "pedido.json"), encoding="utf-8") as fh:
        pedido = json.load(fh)
    if "datos" not in pedido:
        pedido = {"id": "local", "folio": "LOCAL", "datos": pedido}
    rutas = {}
    for nombre in os.listdir(carpeta):
        base, ext = os.path.splitext(nombre)
        if base in VIDEOS_MOVIMIENTO and ext.lower() in EXTENSIONES:
            rutas[base] = os.path.join(carpeta, nombre)
    metricas = analizar_videos(rutas, (pedido.get("datos") or {}).get("estatura_cm"))
    f = ficha_mod.construir_ficha(pedido, metricas, reglas)
    salida = os.path.join(carpeta, "salida")
    os.makedirs(salida, exist_ok=True)
    ruta_ficha = os.path.join(salida, "ficha.json")
    with open(ruta_ficha, "w", encoding="utf-8") as fh:
        json.dump(f, fh, ensure_ascii=False, indent=2)
    with open(os.path.join(salida, "reporte.html"), "w", encoding="utf-8") as fh:
        fh.write(reporte.generar(f))
    ruta_exp = os.path.join(salida, "para_diseno.json")
    with open(ruta_exp, "w", encoding="utf-8") as fh:
        json.dump(exportacion.para_diseno(pedido, f), fh, ensure_ascii=False, indent=2)
    med = exportacion.medidas_json(f)
    if med:
        with open(os.path.join(salida, "medidas.json"), "w", encoding="utf-8") as fh:
            json.dump(med, fh, indent=2)
    if not f["requiere_revision"]:
        d = llamar_diseno(ruta_ficha, os.path.join(salida, "diseno"), ruta_exp)
        if d:
            print("Diseño:", json.dumps(d, ensure_ascii=False)[:800])
    return salida


def main(argv: list[str]) -> int:
    cargar_env()
    if len(argv) < 2 or argv[1] not in ("vigilar", "procesar", "local"):
        print(__doc__)
        return 1
    reglas = ficha_mod.cargar_reglas(os.environ.get("REGLAS"))
    if argv[1] == "local":
        print("Listo:", procesar_local(argv[2], reglas))
        return 0
    from .supabase_api import Supabase
    sb = Supabase(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SECRET_KEY", ""))
    if argv[1] == "procesar":
        p = sb.pedido(argv[2])
        if not p:
            print("No encontré ese pedido.")
            return 1
        print(procesar_pedido(sb, p, reglas))
        return 0
    intervalo = int(os.environ.get("INTERVALO_SEGUNDOS", "60"))
    print(f"Vigilando pedidos nuevos cada {intervalo} s. Ctrl+C para salir.")
    while True:
        try:
            for p in sb.pedidos_pendientes():
                print(time.strftime("%H:%M:%S"), "Procesando", p.get("folio"))
                try:
                    print("   ", procesar_pedido(sb, p, reglas))
                except Exception:
                    traceback.print_exc()
                    try:
                        sb.marcar_pedido(p["id"], "error_ficha")
                    except Exception:
                        pass
        except Exception as e:
            print("Error consultando Supabase:", e)
        time.sleep(intervalo)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
