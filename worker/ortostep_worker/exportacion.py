"""Exportación para el sistema de diseño de plantillas (formato acordado con ese proyecto).

Produce, por pedido:
- para_diseno.json: JSON estable con datos medidos, autodeclarados (bloque SEPARADO, nunca
  en notas), marcha, banderas y rutas de archivos.
- medidas.json: {"left": {...}, "right": {...}} con footLength, footWidth y heelWidth en mm,
  el formato opcional que ese sistema ya lee de escaneo/medidas.json.

No llama a ningún servidor: el transporte y el importador los decide el usuario.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

VERSION = 1
HORMAS = {"clasica": "CLASICA", "deportiva": "DEPORTIVA"}


def _fecha_mx(iso: str | None) -> str:
    try:
        dt = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.now(timezone.utc)
    return (dt.astimezone(timezone(timedelta(hours=-6)))).date().isoformat()


def _contorno_desde_talon(contorno: list | None) -> list | None:
    """Origen en el punto más posterior del talón: y hacia los dedos, x hacia el lado interno."""
    if not contorno:
        return None
    y0 = min(p[1] for p in contorno)
    base = [p for p in contorno if p[1] - y0 < 1.0]
    x0 = sum(p[0] for p in base) / len(base)
    return [[round(p[0] - x0, 1), round(p[1] - y0, 1)] for p in contorno]


def para_diseno(pedido: dict, ficha: dict) -> dict:
    datos = pedido.get("datos") or {}
    prod = datos.get("producto") or pedido.get("producto")
    talla = (datos.get("medidas") or {}).get("talla_mx")
    try:
        talla_cm = float(talla) if talla not in (None, "", "Otra") else None
    except ValueError:
        talla_cm = None
    pies = {}
    for lado in ("izquierdo", "derecho"):
        p = ficha["pies"][lado]
        pies[lado] = {
            "largo_mm": p.get("largo_mm"),
            "ancho_antepie_mm": p.get("ancho_mm"),
            "ancho_talon_mm": p.get("ancho_talon_mm"),
            "ancho_talon_es_estimado": p.get("ancho_talon_es_estimado", True),
            "mtf1_pct": p.get("mtp1_pct"),
            "mtf5_pct": p.get("mtp5_pct"),
            "contorno_mm": _contorno_desde_talon(p.get("contorno_mm")),
            "fuente": p.get("fuente"),
            "confianza": p.get("confianza"),
            "hoja": p.get("hoja"),
        }
    act = datos.get("actividad") or {}
    sugerida = ficha.get("diseno_sugerido", {})
    out = {
        "version": VERSION,
        "unidades": {"longitudes": "mm", "mtf1_pct_mtf5_pct": "fraccion del largo del pie desde el talon (0 a 1)",
                     "contorno_mm": "[x, y] mm; origen talon, y hacia dedos, x hacia lado interno"},
        "id_pedido": pedido.get("id"),
        "folio": pedido.get("folio"),
        "fecha": _fecha_mx(pedido.get("creado")),
        "cliente": {
            "nombre": datos.get("nombre"),
            "edad": datos.get("edad"),
            "sexo": datos.get("sexo"),
            "peso_kg": datos.get("peso_kg"),
            "estatura_cm": datos.get("estatura_cm"),
        },
        "producto": {
            "tipo": HORMAS.get(prod, (prod or "").upper()),
            "soportado_por_sistema_de_diseno": prod in HORMAS,
            "talla_cm": talla_cm,
            "color": datos.get("color"),
        },
        "pies": pies,
        # Lo que el cliente dijo de sí mismo. Bloque separado a propósito: NO debe ir a «notas».
        "autodeclarado": {
            "arco": (datos.get("medidas") or {}).get("arco"),
            "ancho": act.get("ancho"),
            "uso": act.get("uso"),
            "deporte": act.get("deporte"),
            "frecuencia_deporte": act.get("frecuencia"),
            "horas_de_pie": act.get("horas_de_pie"),
            "calzado": act.get("calzado"),
            "marca_modelo": act.get("marca_modelo"),
            "dolor": datos.get("dolor") if isinstance(datos.get("dolor"), list) else [],
            "condiciones": [c for c in (datos.get("salud") or []) if c != "Ninguna de las anteriores"],
            "nota_salud": datos.get("salud_nota"),
            "objetivo": datos.get("objetivo"),
        },
        "marcha": {k: {"metricas": v.get("metricas"), "calidad": v.get("calidad"), "error": v.get("error"), "nota": v.get("nota")}
                   for k, v in (ficha.get("marcha") or {}).items()},
        "banderas": ficha.get("banderas", []),
        "requiere_revision": ficha.get("requiere_revision", True),
        # Sugerencias de reglas de ORTOSTEP (configurables). El sistema de diseño decide si las usa.
        "sugerencias_ortostep": {
            "densidad_sugerida": _densidad(prod, ficha),
            "por_pie": {lado: _sin_contorno(v) for lado, v in (sugerida.get("por_pie") or {}).items()},
            "justificacion": sugerida.get("justificacion", []),
        },
        "archivos": pedido.get("archivos") or {},
    }
    return out


def _sin_contorno(d: dict | None) -> dict | None:
    if not d:
        return d
    return {k: v for k, v in d.items() if k != "contorno_pie_mm"}


def _densidad(prod: str | None, ficha: dict) -> dict:
    """Sugerencia, no decisión: SUAVE / INTERMEDIA / RIGIDA / DEPORTIVA (vocabulario del sistema de diseño)."""
    cond = ficha.get("clinica", {}).get("condiciones") or []
    peso = (ficha.get("paciente") or {}).get("peso_kg") or 0
    if "Diabetes" in cond:
        return {"valor": "SUAVE", "motivo": "diabetes (capa suave, requiere revisión)"}
    if prod == "deportiva":
        return {"valor": "DEPORTIVA", "motivo": "producto deportivo"}
    if peso and peso >= 100:
        return {"valor": "RIGIDA", "motivo": f"peso {peso} kg"}
    return {"valor": "INTERMEDIA", "motivo": "por defecto"}


def medidas_json(ficha: dict) -> dict | None:
    """Formato escaneo/medidas.json del sistema de diseño (mm). Solo pies con medición por foto."""
    out = {}
    for lado, clave in (("izquierdo", "left"), ("derecho", "right")):
        p = ficha["pies"][lado]
        if p.get("fuente") == "foto_sobre_hoja" and p.get("largo_mm"):
            # heelWidth se omite: en la foto el talón queda tapado y solo tenemos una estimación,
            # que no debe pasar por medición en un sistema calibrado con escáner 3D.
            out[clave] = {"footLength": p["largo_mm"], "footWidth": p.get("ancho_mm")}
    return out or None
