"""Reporte HTML autocontenido de la ficha, para que el ortesista la revise de un vistazo."""
from __future__ import annotations

import html
import json


def _e(x) -> str:
    return html.escape("—" if x is None or x == "" else str(x))


def _svg_pie(lado: str, d: dict | None) -> str:
    if not d or not d.get("contorno_pie_mm"):
        return f'<div class="sinsvg">Pie {lado}: sin contorno medido</div>'
    pts = d["contorno_pie_mm"]
    largo = d["largo_pie_mm"]
    esc = 1.4
    xs = [p[0] for p in pts]
    xmin, xmax = min(xs) - 20, max(xs) + 20
    W, H = (xmax - xmin) * esc, (largo + 30) * esc
    # x medial positivo; para el pie derecho visto desde arriba, el lado medial queda a la izquierda.
    def X(x):
        return ((-x if lado == "derecho" else x) - (-xmax if lado == "derecho" else xmin)) * esc
    def Y(y):
        return (largo + 15 - y) * esc
    poly = " ".join(f"{X(x):.1f},{Y(y):.1f}" for x, y in pts)
    partes = [f'<polygon points="{poly}" class="pie"/>']
    lm = d["linea_metatarsal_pct"] * largo
    partes.append(f'<line x1="0" x2="{W:.0f}" y1="{Y(lm):.1f}" y2="{Y(lm):.1f}" class="guia"/><text x="4" y="{Y(lm) - 4:.1f}" class="t">línea metatarsal</text>')
    pa = d["pico_arco_pct"] * largo
    mediales = [pt for pt in pts if pt[0] > 0] or pts
    xa = min(mediales, key=lambda pt: abs(pt[1] - pa))[0] - 8
    partes.append(f'<circle cx="{X(xa):.1f}" cy="{Y(pa):.1f}" r="{4 + d["altura_arco_mm"] / 3:.1f}" class="arco"/><text x="{X(xa) + (-46 if lado == "derecho" else 8):.1f}" y="{Y(pa) + 4:.1f}" class="t">arco {d["altura_arco_mm"]} mm</text>')
    a = d.get("almohadilla_metatarsal")
    if a:
        cy = Y(a["centro_desde_talon_mm"])
        partes.append(f'<ellipse cx="{X(0):.1f}" cy="{cy:.1f}" rx="{a["ancho_mm"] / 2 * esc:.1f}" ry="{a["largo_mm"] / 2 * esc:.1f}" class="pad"/>')
    partes.append(f'<rect x="0" y="{Y(40):.1f}" width="{W:.0f}" height="{40 * esc:.1f}" class="talon"/><text x="4" y="{Y(2):.1f}" class="t">copa talón {d["copa_talon_mm"]} mm</text>')
    return f'<figure><svg viewBox="0 0 {W:.0f} {H:.0f}" width="{W:.0f}" height="{H:.0f}">{"".join(partes)}</svg><figcaption>Pie {lado}: {d["largo_pie_mm"]} × {_e(d["ancho_antepie_mm"])} mm</figcaption></figure>'


def generar(ficha: dict) -> str:
    p, pa, cl = ficha["pedido"], ficha["paciente"], ficha["clinica"]
    ds = ficha["diseno_sugerido"]
    filas_pies = "".join(
        f"<tr><th>{lado}</th><td>{_e(x.get('largo_mm'))}</td><td>{_e(x.get('ancho_mm'))}</td><td>{_e(x.get('ancho_talon_mm'))} (est.)</td>"
        f"<td>{_e(x.get('mtp1_pct'))}</td><td>{_e(x.get('mtp5_pct'))}</td><td>{_e(x.get('fuente'))} · {_e(x.get('confianza'))} · hoja {_e(x.get('hoja'))}</td></tr>"
        for lado, x in ficha["pies"].items())
    filas_dis = ""
    for lado, d in (ds["por_pie"] or {}).items():
        if not d:
            filas_dis += f"<tr><th>{lado}</th><td colspan='7'>Sin datos suficientes</td></tr>"
            continue
        a = d.get("almohadilla_metatarsal")
        filas_dis += (f"<tr><th>{lado}</th><td>{d['largo_plantilla_mm']}</td><td>{d['altura_arco_mm']}</td><td>{d['copa_talon_mm']}</td>"
                      f"<td>{d['poste_medial_retropie_grados']}°</td><td>{(str(a['centro_desde_talon_mm']) + ' mm') if a else 'no'}</td>"
                      f"<td>{'sí' if d['talon_suave'] else 'no'}</td><td>{d['espesor_base_mm']}</td></tr>")
    banderas = "".join(f"<li class='{'b' if b['bloquea'] else 'i'}'>{'⛔' if b['bloquea'] else 'ℹ️'} {_e(b['mensaje'])}</li>" for b in ficha["banderas"]) or "<li>Sin banderas.</li>"
    dolor = ", ".join(f"{d.get('zona')} {d.get('intensidad')}/10" for d in (cl["dolor"] or [])) or "sin dolor"
    marcha = []
    for k, nombre in (("marcha-lateral", "Marcha lateral"), ("marcha", "Marcha frontal"), ("sentadilla", "Sentadilla")):
        m = (ficha["marcha"] or {}).get(k)
        if not m:
            marcha.append(f"<tr><th>{nombre}</th><td>sin analizar</td></tr>")
            continue
        txt = m.get("error") or json.dumps(m.get("metricas"), ensure_ascii=False)
        marcha.append(f"<tr><th>{nombre}</th><td><code>{_e(txt)}</code><br><small>{_e(m.get('nota'))} Calidad: {_e(json.dumps(m.get('calidad'), ensure_ascii=False))}</small></td></tr>")
    imp = ds["impresion"]
    return f"""<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ficha {_e(p.get('folio'))}</title><style>
body{{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#23253A;background:#fff;max-width:1000px}}
h1{{margin:0 0 4px}} h2{{margin:28px 0 8px;font-size:1.15rem}} table{{border-collapse:collapse;width:100%;font-size:.92rem}}
th,td{{border:1px solid #DCE9E9;padding:6px 8px;text-align:left;vertical-align:top}} thead th{{background:#EAF4F4}}
.estado{{display:inline-block;padding:6px 12px;border-radius:99px;font-weight:800;background:{'#FDECEC' if ficha['requiere_revision'] else '#EAF4F4'};color:{'#7C1F1F' if ficha['requiere_revision'] else '#0E7C7B'}}}
li.b{{color:#7C1F1F;font-weight:600}} li{{margin:4px 0}} .pies{{display:flex;gap:24px;flex-wrap:wrap}} figure{{margin:0}}
svg .pie{{fill:#F4E1D6;stroke:#B07A5A;stroke-width:1.5}} svg .guia{{stroke:#0E7C7B;stroke-dasharray:4 3}} svg .arco{{fill:rgba(14,124,123,.35)}}
svg .pad{{fill:rgba(255,176,32,.55)}} svg .talon{{fill:rgba(43,45,66,.08)}} svg .t{{font-size:10px;fill:#4B4E63}} .sinsvg{{padding:20px;border:1px dashed #ccc}}
small{{color:#4B4E63}} code{{white-space:pre-wrap;word-break:break-word}}
</style></head><body>
<h1>Ficha de diseño · {_e(p.get('folio'))}</h1>
<p>{_e(p.get('producto'))} · color {_e(p.get('color'))} · talla MX {_e(p.get('talla_mx'))} · generada {_e(ficha['generada'])}</p>
<p class="estado">{'Requiere revisión del ortesista' if ficha['requiere_revision'] else 'Lista para diseñar'}</p>
<h2>Banderas</h2><ul>{banderas}</ul>
<h2>Paciente</h2><p>{_e(pa.get('edad'))} años · {_e(pa.get('sexo'))} · {_e(pa.get('peso_kg'))} kg · {_e(pa.get('estatura_cm'))} cm · uso: {_e(pa.get('uso'))} {_e(pa.get('deporte') or '')} · calzado: {_e(pa.get('calzado'))}</p>
<p>Arco autodeclarado: {_e(cl.get('arco_autodeclarado'))} · condiciones: {_e(', '.join(cl.get('condiciones') or []) or 'ninguna')} · dolor: {_e(dolor)}</p>
<p>Objetivo: {_e(cl.get('objetivo'))}</p>
<h2>Medidas de los pies (mm)</h2><table><thead><tr><th></th><th>Largo</th><th>Ancho antepié</th><th>Ancho talón</th><th>1.ª MTF (% largo)</th><th>5.ª MTF (% largo)</th><th>Fuente</th></tr></thead><tbody>{filas_pies}</tbody></table>
<h2>Diseño sugerido</h2><div class="pies">{_svg_pie('derecho', (ds['por_pie'] or {}).get('derecho'))}{_svg_pie('izquierdo', (ds['por_pie'] or {}).get('izquierdo'))}</div>
<table><thead><tr><th></th><th>Largo plantilla</th><th>Arco (mm)</th><th>Copa talón (mm)</th><th>Poste medial</th><th>Almohadilla MT</th><th>Talón suave</th><th>Espesor base</th></tr></thead><tbody>{filas_dis}</tbody></table>
<p><small>{_e(' '.join(ds['justificacion']))} {_e(ds['nota'])}</small></p>
<p>Impresión: {_e(imp['material'])}, {_e(imp['patron_relleno'])} {_e(imp['relleno_pct'])} %{(' (talón ' + str(imp['relleno_zona_talon_pct']) + ' %)') if imp.get('relleno_zona_talon_pct') else ''}, {imp['perimetros']} perímetros.</p>
<h2>Marcha y movimiento (tamizaje 2D)</h2><table><tbody>{''.join(marcha)}</tbody></table>
</body></html>"""
