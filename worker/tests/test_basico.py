"""Pruebas sin video real: series de puntos sintéticas con cadencia conocida y una ficha de ejemplo.
Ejecutar:  .venv\\Scripts\\python -m pytest -q   (o)   .venv\\Scripts\\python tests\\test_basico.py
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ortostep_worker import ficha, marcha, reporte  # noqa: E402

AQUI = os.path.dirname(os.path.abspath(__file__))


def serie_caminando(cadencia=108.0, fps=30.0, dur=12.0, ancho=1920, alto=1080, asim=0.0):
    """Persona caminando de izquierda a derecha y regresando (vista lateral)."""
    t = np.arange(0, dur, 1 / fps)
    n = len(t)
    xy = np.full((n, 33, 2), np.nan)
    f_zancada = cadencia / 120.0  # zancadas por segundo
    # Cadera: va y viene (dos tramos), coordenadas normalizadas.
    ida = t < dur / 2
    cx = np.where(ida, 0.15 + 0.7 * (t / (dur / 2)), 0.85 - 0.7 * ((t - dur / 2) / (dur / 2)))
    direc = np.where(ida, 1.0, -1.0)
    fase = 2 * math.pi * f_zancada * t
    amp = 0.06
    for lado, desfase in ((0, 0.0), (1, math.pi + asim)):
        osc = amp * np.sin(fase + desfase)
        tal = cx + direc * osc
        pun = tal + direc * 0.03
        k_tal, k_pun, k_tob = (29, 31, 27) if lado == 0 else (30, 32, 28)
        xy[:, k_tal] = np.stack([tal, np.full(n, 0.9)], 1)
        xy[:, k_pun] = np.stack([pun, np.full(n, 0.9)], 1)
        xy[:, k_tob] = np.stack([tal + direc * 0.01, np.full(n, 0.87)], 1)
    for k, y in ((23, 0.5), (24, 0.5), (25, 0.68), (26, 0.68), (0, 0.15), (11, 0.28), (12, 0.28)):
        xy[:, k] = np.stack([cx, np.full(n, y)], 1)
    vis = np.ones((n, 33))
    return marcha.Serie(t, xy, vis, fps, ancho, alto, n)


def test_cadencia_lateral():
    r = marcha.marcha_lateral(serie_caminando(cadencia=108), estatura_cm=165)
    c = r["metricas"]["cadencia_pasos_min"]
    assert abs(c - 108) < 6, r


def test_cadencia_frontal():
    s = serie_caminando(cadencia=100)
    # En vista frontal, la diferencia vertical entre tobillos oscila con cada paso.
    fase = 2 * math.pi * (100 / 120.0) * s.t
    s.xy[:, 27, 1] = 0.85 + 0.02 * np.sin(fase)
    s.xy[:, 28, 1] = 0.85 - 0.02 * np.sin(fase)
    r = marcha.marcha_frontal(s)
    assert abs(r["metricas"]["cadencia_pasos_min"] - 100) < 6, r


def pedido_ejemplo():
    with open(os.path.join(AQUI, "pedido_ejemplo.json"), encoding="utf-8") as f:
        return json.load(f)


def test_ficha_y_reporte():
    p = pedido_ejemplo()
    f = ficha.construir_ficha(p, {"sentadilla": {"metricas": {"derecho": {"fppa_grados": 14.0}, "izquierdo": {"fppa_grados": 4.0}}}})
    d = f["diseno_sugerido"]["por_pie"]["derecho"]
    assert d["largo_plantilla_mm"] == 265                  # talla 26.5 -> 265 mm (tabla del sistema de diseño)
    assert d["poste_medial_retropie_grados"] >= 2          # FPPA 14° > umbral
    assert d["almohadilla_metatarsal"] is not None          # dolor en antepié
    assert d["copa_talon_mm"] == 15                         # fascitis
    assert not f["requiere_revision"], f["banderas"]
    html = reporte.generar(f)
    assert "Ficha de diseño" in html and "<svg" in html
    # Exportación para el sistema de diseño (formato acordado)
    import copy
    from ortostep_worker import exportacion
    e = exportacion.para_diseno(p, f)
    assert e["producto"]["tipo"] == "DEPORTIVA" and e["producto"]["talla_cm"] == 26.5
    assert e["pies"]["derecho"]["mtf1_pct"] == 0.716
    c = e["pies"]["derecho"]["contorno_mm"]
    assert min(pt[1] for pt in c) == 0 and abs(sum(pt[0] for pt in c if pt[1] == 0)) < 1e-6  # origen en el talón
    assert "Fascitis plantar" in e["autodeclarado"]["condiciones"]
    assert "notas" not in e                                   # lo autodeclarado nunca va a notas
    assert e["producto"]["horma_para_diseno"] == "DEPORTIVA" and e["sucursal"] == "ORTOSTEP"
    assert e["politica_autodeclarado"] == "solo_informativo"
    ps = copy.deepcopy(p); ps["datos"]["producto"] = "sandalia"
    es = exportacion.para_diseno(ps, ficha.construir_ficha(ps))
    assert es["producto"]["tipo"] == "SANDALIA" and es["producto"]["horma_para_diseno"] == "CLASICA" and es["producto"]["soportado_por_sistema_de_diseno"]
    m = exportacion.medidas_json(f)
    assert m["right"] == {"footLength": 250, "footWidth": 96}
    # Talla corta para el pie medido: bandera que obliga a revisión.
    import copy
    p3 = copy.deepcopy(p); p3["datos"]["medidas"]["talla_mx"] = "25"
    f3 = ficha.construir_ficha(p3)
    tc = [b for b in f3["banderas"] if b["codigo"].startswith("talla_corta")]
    assert tc and not tc[0]["bloquea"] and not f3["requiere_revision"]   # se informa, no detiene
    # Si se vuelve a configurar como bloqueante, sí detiene.
    r3 = ficha.cargar_reglas(); r3["banderas_que_bloquean"] = ["sin_talla", "talla_corta"]
    assert ficha.construir_ficha(p3, reglas=r3)["requiere_revision"]
    # Con diabetes se bloquea y no se ponen postes automáticos.
    p["datos"]["salud"].append("Diabetes")
    f2 = ficha.construir_ficha(p)
    dia = [b for b in f2["banderas"] if b["codigo"] == "diabetes"]
    assert dia and not dia[0]["bloquea"] and not f2["requiere_revision"]   # visible para la diseñadora, no detiene
    assert f2["diseno_sugerido"]["por_pie"]["derecho"]["poste_medial_retropie_grados"] == 0


class SupabaseFalso:
    """Simula Supabase para probar el flujo de procesar_pedido sin red."""
    def __init__(self, ultimo=None):
        self.ultimo, self.subidos, self.filas, self.estados = ultimo, {}, [], []
    def descargar(self, ruta, destino):
        raise AssertionError("no debería descargar sin videos")
    def subir(self, ruta, contenido, tipo):
        self.subidos[ruta] = len(contenido); return ruta
    def ultimo_diseno(self, pedido_id):
        return self.ultimo
    def guardar_diseno(self, fila):
        self.filas.append(fila)
    def marcar_pedido(self, pedido_id, estado):
        self.estados.append(estado)


def test_versiones_al_reprocesar():
    from ortostep_worker.__main__ import procesar_pedido
    reglas = ficha.cargar_reglas()
    p = pedido_ejemplo()
    sb = SupabaseFalso(None)
    r = procesar_pedido(sb, p, reglas)
    assert r["version"] == 1 and r["estado"] == "ficha_lista"
    assert f"{p['id']}/v1/para_diseno.json" in sb.subidos and f"{p['id']}/v1/medidas.json" in sb.subidos
    # Ficha aún no tomada: se reescribe la misma versión.
    sb = SupabaseFalso({"version": 1, "estado": "ficha_lista"})
    assert procesar_pedido(sb, p, reglas)["version"] == 1
    # Ya tomada o validada por el sistema de plantillas: versión nueva, nunca se pisa.
    for estado in ("en_cola_diseno", "stl_validado", "rechazado"):
        sb = SupabaseFalso({"version": 1, "estado": estado})
        assert procesar_pedido(sb, p, reglas)["version"] == 2
        assert f"{p['id']}/v2/para_diseno.json" in sb.subidos and sb.filas[0]["version"] == 2
    # Sin talla: bandera que bloquea.
    import copy
    p2 = copy.deepcopy(p); p2["datos"]["medidas"]["talla_mx"] = "Otra"
    f2 = ficha.construir_ficha(p2)
    assert any(b["codigo"] == "sin_talla" for b in f2["banderas"]) and f2["requiere_revision"]


if __name__ == "__main__":
    test_cadencia_lateral(); test_cadencia_frontal(); test_ficha_y_reporte(); test_versiones_al_reprocesar()
    print("OK")
