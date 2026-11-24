"""Ficha de diseño: une el expediente del pedido con las métricas de video y produce
las entradas normalizadas, las banderas de revisión y un diseño sugerido por pie.

La ficha es el contrato entre la página y el sistema de diseño de plantillas:
todo en milímetros, grados y porcentajes del largo del pie (desde el talón).
"""
from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone

VERSION_FICHA = 1
AQUI = os.path.dirname(os.path.abspath(__file__))

ZONA_TALON = "Talón"
ZONA_ANTEPIE = "Parte delantera de la planta"
ZONA_ARCO = "Arco"
ZONAS_DORSALES = {"Dedos (dorso)", "Empeine", "Tobillo"}


def cargar_reglas(ruta_extra: str | None = None) -> dict:
    with open(os.path.join(AQUI, "reglas_default.json"), encoding="utf-8") as f:
        reglas = json.load(f)
    for ruta in [ruta_extra, os.path.join(os.getcwd(), "reglas.json")]:
        if ruta and os.path.exists(ruta):
            with open(ruta, encoding="utf-8") as f:
                _mezclar(reglas, json.load(f))
    return reglas


def _mezclar(base: dict, extra: dict) -> None:
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _mezclar(base[k], v)
        else:
            base[k] = v


def _num(x) -> float | None:
    try:
        return float(x) if x not in (None, "", "Otra") else None
    except (TypeError, ValueError):
        return None


def _escalon(tabla: list[dict], valor: float, campo: str) -> float:
    elegido = tabla[0][campo]
    for fila in tabla:
        if valor >= fila["desde_kg"]:
            elegido = fila[campo]
    return elegido


def _pie_desde_datos(datos: dict, lado: str, reglas: dict) -> dict:
    m = ((datos.get("medicion_pie") or {}).get(lado)) or {}
    largo_manual = (datos.get("medidas") or {}).get("largo_pie_cm")
    if m.get("ok"):
        pie = {
            "fuente": "foto_sobre_hoja",
            "confianza": m.get("confianza"),
            "hoja": m.get("hoja"),
            "largo_mm": m.get("largo_mm"),
            "ancho_mm": m.get("ancho_mm"),
            "mtp1_pct": m.get("mtp1_pct"),
            "mtp5_pct": m.get("mtp5_pct"),
            "bola_pct": m.get("bola_pct"),
            "contorno_mm": m.get("contorno_mm"),
            "avisos": m.get("avisos") or [],
        }
    else:
        largo = round(float(largo_manual) * 10) if largo_manual else None
        pie = {
            "fuente": "largo_escrito_por_cliente" if largo else "sin_medicion",
            "confianza": "baja",
            "largo_mm": largo,
            # Ancho estimado: 0.38 del largo (aprox. medio en adultos); solo como respaldo.
            "ancho_mm": round(largo * 0.38) if largo else None,
            "mtp1_pct": None, "mtp5_pct": None, "bola_pct": None, "contorno_mm": None,
            "avisos": [m.get("motivo")] if m.get("motivo") else [],
        }
    if pie["ancho_mm"]:
        pie["ancho_talon_mm"] = round(pie["ancho_mm"] * reglas["ancho_talon_proporcion_del_antepie"])
        pie["ancho_talon_es_estimado"] = True
    return pie


def construir_ficha(pedido: dict, metricas: dict | None = None, reglas: dict | None = None) -> dict:
    """pedido: fila de la tabla `pedidos` (con `datos`), metricas: {'marcha': .., 'marcha-lateral': .., 'sentadilla': ..}."""
    reglas = reglas or cargar_reglas()
    datos = pedido.get("datos") or {}
    metricas = metricas or {}
    producto = datos.get("producto") or pedido.get("producto")
    peso = float(datos.get("peso_kg") or 0)
    edad = float(datos.get("edad") or 0)
    act = datos.get("actividad") or {}
    salud = [c for c in (datos.get("salud") or []) if c != "Ninguna de las anteriores"]
    dolor = datos.get("dolor") if isinstance(datos.get("dolor"), list) else []
    zonas = {d.get("zona"): d for d in dolor}
    arco = (datos.get("medidas") or {}).get("arco") or "No sé"

    pies = {lado: _pie_desde_datos(datos, lado, reglas) for lado in ("derecho", "izquierdo")}

    # ---------- banderas ----------
    b = reglas["bloqueos"]
    banderas: list[dict] = []

    def bandera(codigo: str, mensaje: str, bloquea: bool) -> None:
        banderas.append({"codigo": codigo, "mensaje": mensaje, "bloquea": bloquea})

    if b.get("diabetes") and "Diabetes" in salud:
        bandera("diabetes", "Diabetes: revisión obligatoria (IWGDF). Confirmar sensibilidad, circulación, úlceras previas y deformidades; diseño de contacto total con capa superior suave.", True)
    max_dolor = max([int(d.get("intensidad") or 0) for d in dolor] or [0])
    if max_dolor >= b.get("dolor_maximo_igual_o_mayor", 99):
        bandera("dolor_intenso", f"Dolor de {max_dolor}/10: valorar si requiere atención médica antes de la plantilla.", True)
    if edad and edad < b.get("edad_menor_a", 0):
        bandera("menor", f"Paciente de {int(edad)} años: diseño pediátrico a criterio del ortesista.", True)
    if b.get("cirugia_previa") and any(c.startswith("Cirugías") for c in salud):
        bandera("cirugia", "Cirugías o lesiones previas: revisar la nota del cliente.", True)
    if b.get("dolor_dorsal_o_tobillo") and ZONAS_DORSALES & set(zonas):
        bandera("dolor_dorsal", "Dolor en dorso, empeine o tobillo: una plantilla puede no resolverlo; revisar.", True)
    if b.get("medicion_faltante_o_baja_confianza"):
        for lado, p in pies.items():
            if p["fuente"] != "foto_sobre_hoja" or p.get("confianza") == "baja":
                bandera(f"medicion_{lado}", f"Medición del pie {lado} faltante o de baja confianza ({p['fuente']}). Verificar con las fotos.", True)
    l1, l2 = pies["derecho"].get("largo_mm"), pies["izquierdo"].get("largo_mm")
    if l1 and l2 and abs(l1 - l2) > b.get("diferencia_largo_pies_mm", 99):
        bandera("asimetria_largo", f"Diferencia de largo entre pies de {abs(l1 - l2)} mm: verificar fotos (posible error de toma o asimetría real).", True)
    talla_cm = _num((datos.get("medidas") or {}).get("talla_mx"))
    lmin, lmax = reglas.get("rango_talla_menos_pie_mm", [5, 22])
    for lado, p in pies.items():
        if talla_cm and p.get("largo_mm") and p["fuente"] == "foto_sobre_hoja":
            dif = talla_cm * 10 - p["largo_mm"]
            if dif < lmin:
                bandera(f"talla_corta_{lado}", f"Talla {talla_cm:g} contra pie {lado} de {p['largo_mm']} mm (diferencia {dif:.0f} mm): la talla parece corta; lo usual es {lmin} a {lmax} mm por encima del pie. Confirmar talla con el cliente.", True)
            elif dif > lmax:
                bandera(f"talla_larga_{lado}", f"Talla {talla_cm:g} contra pie {lado} de {p['largo_mm']} mm (diferencia {dif:.0f} mm): la talla parece grande para el pie. Confirmar talla o medición.", True)
    if "Juanetes" in salud:
        bandera("juanetes", "Juanetes: considerar alivio bajo la 1.ª cabeza metatarsal y calzado con espacio; las revisiones favorecen separadores de dedos.", False)
    if "Tendinitis" in salud:
        bandera("tendinitis", "Tendinitis: confirmar cuál tendón (Aquiles, tibial posterior, peroneos) para decidir talonera o soporte.", False)

    # ---------- métricas útiles para el diseño ----------
    fppa = {}
    sent = (metricas.get("sentadilla") or {}).get("metricas") or {}
    for lado in ("derecho", "izquierdo"):
        if lado in sent:
            fppa[lado] = sent[lado].get("fppa_grados")
    lat = (metricas.get("marcha-lateral") or {}).get("metricas") or {}
    if lat.get("asimetria_tiempo_paso_pct") and lat["asimetria_tiempo_paso_pct"] > 10:
        bandera("asimetria_marcha", f"Asimetría de tiempo de paso de {lat['asimetria_tiempo_paso_pct']} % (vista lateral): revisar video.", False)

    # ---------- diseño sugerido por pie ----------
    dolor_talon = ZONA_TALON in zonas or "Fascitis plantar" in salud or "Espolón calcáneo" in salud
    dolor_antepie = ZONA_ANTEPIE in zonas or "Dolor en la parte delantera del pie" in salud
    plano = "Pie plano" in salud or arco == "Bajo o plano"
    cavo = "Pie cavo" in salud or arco == "Alto"
    diabetes = "Diabetes" in salud

    por_pie = {}
    justif: list[str] = []
    for lado, p in pies.items():
        largo = p.get("largo_mm")
        if not largo:
            por_pie[lado] = None
            continue
        arco_mm = reglas["altura_arco_mm"].get(arco, 13) + _escalon(reglas["ajuste_arco_por_peso"], peso, "mm")
        if cavo:
            arco_mm = max(arco_mm, reglas["altura_arco_mm"]["Alto"])
        arco_mm = min(arco_mm, reglas["altura_arco_max_mm"])
        copa = reglas["copa_talon_mm"]["base"]
        if producto == "deportiva":
            copa = max(copa, reglas["copa_talon_mm"]["deportiva"])
        if dolor_talon:
            copa = max(copa, reglas["copa_talon_mm"]["dolor_talon"])
        poste = 0
        if plano:
            poste = max(poste, reglas["poste_medial_retropie_grados"]["pie_plano"])
        if fppa.get(lado) is not None and fppa[lado] > reglas["umbral_fppa_valgo_grados"]:
            poste = max(poste, reglas["poste_medial_retropie_grados"]["fppa_valgo"])
        poste = min(poste, reglas["poste_medial_retropie_grados"]["maximo"])
        linea_mt = None
        if p.get("mtp1_pct") and p.get("mtp5_pct"):
            linea_mt = (p["mtp1_pct"] + p["mtp5_pct"]) / 2
        linea_mt = linea_mt or reglas["linea_metatarsal_pct_por_defecto"]
        almohadilla = None
        if dolor_antepie and not diabetes:
            a = reglas["almohadilla_metatarsal"]
            centro_mm = linea_mt * largo - reglas["posicion_almohadilla_metatarsal_mm_antes_de_cabezas"] - a["largo_mm"] / 2
            almohadilla = {"centro_desde_talon_mm": round(centro_mm), "centro_pct": round(centro_mm / largo, 3),
                           "altura_mm": a["altura_mm"], "largo_mm": a["largo_mm"], "ancho_mm": a["ancho_mm"]}
        if diabetes:
            poste = 0
            arco_mm = min(arco_mm, reglas["altura_arco_mm"]["Medio"])
        largo_plantilla = (round(talla_cm * 10 + reglas["largo_plantilla_desde_talla_mm"]) if talla_cm
                           else largo + reglas["largo_plantilla_sin_talla_extra_mm"])
        por_pie[lado] = {
            "largo_plantilla_mm": largo_plantilla,
            "largo_plantilla_desde": "talla" if talla_cm else "largo_del_pie",
            "largo_pie_mm": largo,
            "ancho_antepie_mm": p.get("ancho_mm"),
            "ancho_talon_mm": p.get("ancho_talon_mm"),
            "linea_metatarsal_pct": round(linea_mt, 3),
            "altura_arco_mm": arco_mm,
            "pico_arco_pct": reglas.get("pico_arco_pct", 0.42),
            "copa_talon_mm": copa,
            "poste_medial_retropie_grados": poste,
            "almohadilla_metatarsal": almohadilla,
            "talon_suave": bool(dolor_talon),
            "soporte_lateral": bool(cavo),
            "espesor_base_mm": reglas["espesor_base_mm"].get(producto, 3.0),
            "contorno_pie_mm": p.get("contorno_mm"),
        }
    if plano:
        justif.append("Arco bajo o pie plano: poste medial de retropié.")
    if cavo:
        justif.append("Arco alto o pie cavo: arco relleno y soporte lateral; más amortiguación.")
    if dolor_talon:
        justif.append("Dolor de talón, fascitis o espolón: copa de talón más profunda y zona de talón más suave. Nota: la guía JOSPT 2023 no recomienda la plantilla como tratamiento aislado de la fascitis.")
    if dolor_antepie and not diabetes:
        justif.append("Dolor en antepié: almohadilla metatarsal unos 8 mm antes de la línea de cabezas metatarsales.")
    if any(v is not None and v > reglas["umbral_fppa_valgo_grados"] for v in fppa.values()):
        justif.append(f"FPPA de rodilla mayor a {reglas['umbral_fppa_valgo_grados']}° en la sentadilla: poste medial leve (tamizaje 2D).")
    if diabetes:
        justif.append("Diabetes: sin postes ni almohadilla automática; contacto total y capa superior suave; requiere revisión.")

    relleno = _escalon(reglas["relleno_tpu_pct"], peso, "pct")
    if producto == "deportiva":
        relleno += reglas["relleno_extra_deportiva_pct"]
    if cavo:
        relleno -= 5
    impresion = {
        "material": "TPU 95A",
        "patron_relleno": "giroide",
        "relleno_pct": relleno,
        "relleno_zona_talon_pct": reglas["relleno_zona_talon_suave_pct"] if dolor_talon else None,
        "perimetros": 2, "capa_superior_inferior_mm": 0.6, "altura_capa_mm": 0.2,
    }

    bloquea = any(x["bloquea"] for x in banderas)
    return {
        "version_ficha": VERSION_FICHA,
        "generada": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pedido": {
            "id": pedido.get("id"), "folio": pedido.get("folio"), "producto": producto,
            "color": datos.get("color"), "talla_mx": (datos.get("medidas") or {}).get("talla_mx"),
        },
        "paciente": {
            "edad": edad or None, "sexo": datos.get("sexo"), "peso_kg": peso or None, "estatura_cm": datos.get("estatura_cm"),
            "uso": act.get("uso"), "deporte": act.get("deporte"), "frecuencia": act.get("frecuencia"),
            "horas_de_pie": act.get("horas_de_pie"), "calzado": act.get("calzado"), "ancho_autodeclarado": act.get("ancho"),
        },
        "pies": pies,
        "clinica": {"arco_autodeclarado": arco, "condiciones": salud, "dolor": dolor, "nota_salud": datos.get("salud_nota"), "objetivo": datos.get("objetivo")},
        "marcha": metricas,
        "banderas": banderas,
        "requiere_revision": bloquea,
        "estado_sugerido": "requiere_revision" if bloquea else "listo_para_disenar",
        "diseno_sugerido": {
            "por_pie": por_pie,
            "impresion": impresion,
            "justificacion": justif,
            "nota": "Parámetros por defecto configurables (reglas.json), basados en opinión experta y evidencia limitada. El ortesista decide.",
        },
    }


def ficha_sin_contornos(ficha: dict) -> dict:
    """Copia ligera para guardar en la base de datos (sin los contornos en mm)."""
    f = copy.deepcopy(ficha)
    for p in f["pies"].values():
        p.pop("contorno_mm", None)
    for p in (f["diseno_sugerido"]["por_pie"] or {}).values():
        if p:
            p.pop("contorno_pie_mm", None)
    return f
