"""Métricas de marcha y sentadilla a partir de video con MediaPipe Pose (Apache-2.0).

Todo es 2D y de tamizaje: sirve para orientar al ortesista, no para diagnosticar.
Evidencia en la que se basa (ver informe de investigación):
- Vista lateral: eventos de marcha por el método de Zeni (pie más adelantado / más atrasado
  respecto a la pelvis); cadencia, % de apoyo y tiempo de paso son lo más confiable.
- Vista frontal: solo cadencia y tiempo de paso tienen respaldo.
- Sentadilla a una pierna: ángulo de proyección en el plano frontal (FPPA) de la rodilla.
"""
from __future__ import annotations

import math
import os
import urllib.request
from dataclasses import dataclass

import numpy as np

MODELO_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task"

# Índices de MediaPipe Pose
NARIZ, HOM_I, HOM_D, CAD_I, CAD_D, ROD_I, ROD_D, TOB_I, TOB_D, TAL_I, TAL_D, PUN_I, PUN_D = 0, 11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32


def ruta_modelo(cache_dir: str) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    ruta = os.path.join(cache_dir, "pose_landmarker_full.task")
    if not os.path.exists(ruta):
        tmp = ruta + ".part"
        urllib.request.urlretrieve(MODELO_URL, tmp)
        os.replace(tmp, ruta)
    return ruta


@dataclass
class Serie:
    """Puntos por cuadro: t (s), xy normalizados (N, 33, 2), visibilidad (N, 33)."""
    t: np.ndarray
    xy: np.ndarray
    vis: np.ndarray
    fps: float
    ancho: int
    alto: int
    cuadros_totales: int


def extraer_poses(video: str, modelo: str, fps_max: float = 30.0) -> Serie:
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise RuntimeError(f"No se pudo abrir el video: {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if not (5 <= fps <= 240):
        fps = 30.0
    paso = max(1, round(fps / fps_max))
    opciones = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=modelo),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    ts, puntos, visib = [], [], []
    i = 0
    ancho = alto = 0
    with vision.PoseLandmarker.create_from_options(opciones) as det:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if i % paso == 0:
                alto, ancho = frame.shape[:2]
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                t_ms = int(round(i * 1000.0 / fps))
                res = det.detect_for_video(img, t_ms)
                ts.append(i / fps)
                if res.pose_landmarks:
                    lm = res.pose_landmarks[0]
                    puntos.append([[p.x, p.y] for p in lm])
                    visib.append([p.visibility if p.visibility is not None else 1.0 for p in lm])
                else:
                    puntos.append([[np.nan, np.nan]] * 33)
                    visib.append([0.0] * 33)
            i += 1
    cap.release()
    return Serie(np.array(ts), np.array(puntos, dtype=float), np.array(visib, dtype=float), fps / paso, ancho, alto, i)


# ---------- utilidades ----------
def suavizar(x: np.ndarray, ventana: int = 5) -> np.ndarray:
    """Media móvil que respeta huecos (NaN) rellenándolos por interpolación lineal."""
    x = np.asarray(x, dtype=float).copy()
    idx = np.arange(len(x))
    ok = ~np.isnan(x)
    if ok.sum() < 2:
        return x
    x[~ok] = np.interp(idx[~ok], idx[ok], x[ok])
    if ventana <= 1:
        return x
    k = np.ones(ventana) / ventana
    pad = ventana // 2
    xp = np.pad(x, pad, mode="edge")
    return np.convolve(xp, k, mode="valid")[: len(x)]


def picos(x: np.ndarray, separacion: int, prominencia: float) -> list[int]:
    """Máximos locales separados al menos `separacion` muestras y con prominencia mínima."""
    out: list[int] = []
    n = len(x)
    for i in range(1, n - 1):
        if not (x[i] >= x[i - 1] and x[i] > x[i + 1]):
            continue
        a, b = max(0, i - separacion), min(n, i + separacion + 1)
        if x[i] < np.nanmax(x[a:b]):
            continue
        if x[i] - np.nanmin(x[a:b]) < prominencia:
            continue
        if out and i - out[-1] < separacion:
            if x[i] > x[out[-1]]:
                out[-1] = i
            continue
        out.append(i)
    return out


def angulo(a, b, c) -> float:
    """Ángulo en b (grados) entre los segmentos b→a y b→c."""
    v1, v2 = np.asarray(a) - np.asarray(b), np.asarray(c) - np.asarray(b)
    n = np.linalg.norm(v1) * np.linalg.norm(v2)
    if n == 0 or np.isnan(n):
        return float("nan")
    return float(np.degrees(np.arccos(np.clip(np.dot(v1, v2) / n, -1, 1))))


def calidad(s: Serie, indices=(TOB_I, TOB_D, TAL_I, TAL_D, PUN_I, PUN_D)) -> dict:
    det = ~np.isnan(s.xy[:, CAD_I, 0])
    pies = det & (s.vis[:, list(indices)] > 0.5).all(axis=1)
    return {
        "cuadros_analizados": int(len(s.t)),
        "fps_analisis": round(s.fps, 1),
        "persona_pct": round(float(det.mean()) if len(det) else 0, 2),
        "pies_visibles_pct": round(float(pies.mean()) if len(pies) else 0, 2),
        "resolucion": f"{s.ancho}x{s.alto}",
    }


def _px(s: Serie, k: int) -> np.ndarray:
    """Coordenadas en píxeles (para que los ángulos no se deformen por la proporción)."""
    return s.xy[:, k, :] * np.array([s.ancho, s.alto])


def escala_px_por_m(s: Serie, estatura_cm: float | None) -> float | None:
    """Píxeles por metro estimados con la estatura: de la nariz al talón ≈ 0.91 de la estatura."""
    if not estatura_cm:
        return None
    nariz = _px(s, NARIZ)[:, 1]
    tal = np.nanmean(np.stack([_px(s, TAL_I)[:, 1], _px(s, TAL_D)[:, 1]]), axis=0)
    alto = tal - nariz
    alto = alto[~np.isnan(alto)]
    if len(alto) < 5:
        return None
    return float(np.percentile(alto, 75) / (0.91 * estatura_cm / 100.0))


# ---------- marcha lateral ----------
def marcha_lateral(s: Serie, estatura_cm: float | None = None) -> dict:
    out = {"vista": "lateral", "calidad": calidad(s), "nota": "Tamizaje 2D. Lo más confiable de esta vista: cadencia, tiempos de paso y % de apoyo."}
    if out["calidad"]["persona_pct"] < 0.5:
        out["error"] = "No se detectó a la persona en suficientes cuadros."
        return out
    fs = s.fps
    cad = (_px(s, CAD_I) + _px(s, CAD_D)) / 2
    cx = suavizar(cad[:, 0], 7)
    vel = np.gradient(cx) * fs
    direccion = np.sign(suavizar(vel, 15))
    # Solo tramos caminando (no vueltas): velocidad horizontal apreciable.
    umbral = 0.15 * np.nanpercentile(np.abs(vel), 90)
    caminando = np.abs(suavizar(vel, 15)) > umbral
    eventos = {}
    sep = max(3, int(0.35 * fs))
    # Largo de pierna en px (cadera a tobillo): los pasos reales mueven el talón una fracción
    # apreciable de la pierna; el temblor de los puntos no.
    pierna = np.nanmedian(np.linalg.norm(_px(s, CAD_I) - _px(s, TOB_I), axis=1))
    pierna = pierna if pierna == pierna and pierna > 0 else 0.3 * s.alto
    for lado, tal, pun in (("izquierdo", TAL_I, PUN_I), ("derecho", TAL_D, PUN_D)):
        th = suavizar(_px(s, tal)[:, 0], 5)
        tp = suavizar(_px(s, pun)[:, 0], 5)
        rel_hs = (th - cx) * direccion
        rel_to = (tp - cx) * direccion
        rango = np.nanpercentile(rel_hs[caminando], 95) - np.nanpercentile(rel_hs[caminando], 5) if caminando.any() else 0
        if rango < 0.35 * pierna:
            eventos[lado] = {"hs": [], "to": []}
            continue
        prom = max(0.25 * rango, 0.12 * pierna)
        hs = [i for i in picos(rel_hs, sep, prom) if caminando[i]]
        to = [i for i in picos(-rel_to, sep, prom) if caminando[i]]
        eventos[lado] = {"hs": hs, "to": to}
    if not any(eventos[l]["hs"] for l in eventos):
        out["metricas"] = {"eventos_detectados": {k: {"apoyos": 0, "despegues": 0} for k in eventos}}
        out["error"] = "No se detectaron pasos: revisa que la persona camine de perfil cruzando el cuadro."
        return out
    todos_hs = sorted(eventos["izquierdo"]["hs"] + eventos["derecho"]["hs"])
    t_caminando = float(caminando.sum() / fs)
    res: dict = {}
    if len(todos_hs) >= 3 and t_caminando > 2:
        pasos = np.diff([s.t[i] for i in todos_hs])
        pasos = pasos[(pasos > 0.25) & (pasos < 1.2)]
        if len(pasos):
            res["cadencia_pasos_min"] = round(60.0 / float(np.median(pasos)), 1)
            res["tiempo_paso_s"] = round(float(np.median(pasos)), 3)
    apoyo = {}
    for lado in ("izquierdo", "derecho"):
        hs, to = eventos[lado]["hs"], eventos[lado]["to"]
        ciclos = []
        for a, b in zip(hs, hs[1:]):
            dur = s.t[b] - s.t[a]
            if not 0.6 < dur < 2.2:
                continue
            tos = [k for k in to if a < k < b]
            if tos:
                ciclos.append((s.t[tos[0]] - s.t[a]) / dur)
        if ciclos:
            apoyo[lado] = round(100 * float(np.median(ciclos)), 1)
    if apoyo:
        res["apoyo_pct"] = apoyo
    # Tiempo de paso por lado y asimetría
    t_lado = {}
    for lado, otro in (("izquierdo", "derecho"), ("derecho", "izquierdo")):
        dt = []
        for i in eventos[lado]["hs"]:
            prev = [k for k in eventos[otro]["hs"] if k < i]
            if prev:
                d = s.t[i] - s.t[prev[-1]]
                if 0.25 < d < 1.2:
                    dt.append(d)
        if dt:
            t_lado[lado] = float(np.median(dt))
    if len(t_lado) == 2:
        m = (t_lado["izquierdo"] + t_lado["derecho"]) / 2
        res["asimetria_tiempo_paso_pct"] = round(100 * abs(t_lado["izquierdo"] - t_lado["derecho"]) / m, 1)
    # Longitud de paso aproximada (escala por estatura)
    ppm = escala_px_por_m(s, estatura_cm)
    if ppm and len(todos_hs) >= 3:
        largos = []
        for i in todos_hs:
            d = abs(_px(s, TAL_I)[i, 0] - _px(s, TAL_D)[i, 0]) / ppm
            if 0.2 < d < 1.2:
                largos.append(d)
        if largos:
            res["longitud_paso_m_aprox"] = round(float(np.median(largos)), 2)
    # Rango de flexión de rodilla (sagital)
    for lado, c, r, t in (("izquierdo", CAD_I, ROD_I, TOB_I), ("derecho", CAD_D, ROD_D, TOB_D)):
        ang = np.array([180 - angulo(_px(s, c)[i], _px(s, r)[i], _px(s, t)[i]) for i in range(len(s.t))])
        ang = ang[caminando & ~np.isnan(ang)]
        if len(ang) > 10:
            res.setdefault("flexion_rodilla_max_grados", {})[lado] = round(float(np.percentile(ang, 95)), 1)
    res["eventos_detectados"] = {k: {"apoyos": len(v["hs"]), "despegues": len(v["to"])} for k, v in eventos.items()}
    out["metricas"] = res
    return out


# ---------- marcha frontal ----------
def marcha_frontal(s: Serie) -> dict:
    out = {"vista": "frontal", "calidad": calidad(s), "nota": "Tamizaje 2D. En vista frontal solo la cadencia y el tiempo de paso tienen respaldo; la longitud de paso no es confiable."}
    if out["calidad"]["persona_pct"] < 0.5:
        out["error"] = "No se detectó a la persona en suficientes cuadros."
        return out
    fs = s.fps
    d = suavizar(_px(s, TOB_I)[:, 1] - _px(s, TOB_D)[:, 1], 5)
    sep = max(3, int(0.3 * fs))
    rango = np.nanpercentile(np.abs(d), 90)
    pierna = np.nanmedian(np.linalg.norm(_px(s, CAD_I) - _px(s, TOB_I), axis=1))
    pierna = pierna if pierna == pierna and pierna > 0 else 0.3 * s.alto
    res: dict = {}
    if rango < 0.04 * pierna:
        out["metricas"] = res
        out["error"] = "No se detectaron pasos: revisa que la persona camine hacia la cámara y de regreso."
        return out
    ev = sorted(picos(d, sep, max(0.3 * rango, 0.02 * pierna)) + picos(-d, sep, max(0.3 * rango, 0.02 * pierna)))
    if len(ev) >= 4:
        pasos = np.diff(s.t[ev])
        pasos = pasos[(pasos > 0.25) & (pasos < 1.2)]
        if len(pasos) >= 3:
            res["cadencia_pasos_min"] = round(60.0 / float(np.median(pasos)), 1)
            pares, impares = pasos[0::2], pasos[1::2]
            if len(pares) and len(impares):
                a, b = float(np.median(pares)), float(np.median(impares))
                res["asimetria_tiempo_paso_pct"] = round(100 * abs(a - b) / ((a + b) / 2), 1)
    if not res:
        out["error"] = "No se detectaron pasos: revisa que la persona camine hacia la cámara y de regreso."
    out["metricas"] = res
    return out


# ---------- sentadilla a una pierna (vista frontal) ----------
def sentadilla(s: Serie) -> dict:
    out = {"vista": "frontal", "calidad": calidad(s, (CAD_I, CAD_D, ROD_I, ROD_D, TOB_I, TOB_D)),
           "nota": "FPPA 2D: útil para detectar desalineación de rodilla (tamizaje); no equivale al valgo 3D."}
    if out["calidad"]["persona_pct"] < 0.5:
        out["error"] = "No se detectó a la persona en suficientes cuadros."
        return out
    ti, td = _px(s, TOB_I), _px(s, TOB_D)
    # Pierna de apoyo: el otro tobillo está claramente más arriba (pie levantado).
    alto_cuerpo = np.nanmedian(np.abs(_px(s, NARIZ)[:, 1] - (ti[:, 1] + td[:, 1]) / 2))
    umbral = 0.04 * alto_cuerpo if alto_cuerpo == alto_cuerpo else 20
    dif = suavizar(ti[:, 1] - td[:, 1], 5)  # positivo: tobillo izquierdo más abajo → apoyo izquierdo
    cad_y = suavizar(((_px(s, CAD_I) + _px(s, CAD_D)) / 2)[:, 1], 5)
    res: dict = {}
    for lado, signo, C, R, T, Cot in (("izquierdo", 1, CAD_I, ROD_I, TOB_I, CAD_D), ("derecho", -1, CAD_D, ROD_D, TOB_D, CAD_I)):
        apoyo = signo * dif > umbral
        if apoyo.sum() < max(5, int(0.5 * s.fps)):
            continue
        idx = np.where(apoyo)[0]
        # Profundidad: cuadros con la cadera más baja (y mayor) dentro del apoyo de esta pierna.
        prof = cad_y[idx]
        hondos = idx[prof >= np.percentile(prof, 80)]
        fppa, caida, tronco = [], [], []
        mid = (_px(s, CAD_I) + _px(s, CAD_D)) / 2
        hombros = (_px(s, HOM_I) + _px(s, HOM_D)) / 2
        for i in hondos:
            c, r, t = _px(s, C)[i], _px(s, R)[i], _px(s, T)[i]
            if np.isnan(c).any() or np.isnan(r).any() or np.isnan(t).any():
                continue
            # Desviación de la rodilla respecto a la línea cadera-tobillo, positiva hacia la línea media (valgo).
            linea = t - c
            perp = np.array([-linea[1], linea[0]])
            perp /= np.linalg.norm(perp) + 1e-9
            hacia_medio = mid[i] - c
            sentido = 1 if np.dot(perp, hacia_medio) > 0 else -1
            desv = np.dot(r - c, perp) * sentido
            a = 180 - angulo(c, r, t)
            fppa.append(a if desv > 0 else -a)
            cot = _px(s, Cot)[i]
            caida.append(math.degrees(math.atan2(cot[1] - c[1], abs(cot[0] - c[0]) + 1e-9)))  # + si cae la cadera contraria
            dv = hombros[i] - mid[i]
            tronco.append(math.degrees(math.atan2(abs(dv[0]), abs(dv[1]) + 1e-9)))
        if fppa:
            res[lado] = {
                "fppa_grados": round(float(np.median(fppa)), 1),
                "caida_pelvis_grados": round(float(np.median(caida)), 1),
                "inclinacion_tronco_grados": round(float(np.median(tronco)), 1),
                "cuadros": len(fppa),
            }
    out["metricas"] = res
    return out


def analizar(video: str, tipo: str, modelo: str, estatura_cm: float | None = None) -> dict:
    s = extraer_poses(video, modelo)
    if tipo == "marcha-lateral":
        return marcha_lateral(s, estatura_cm)
    if tipo == "marcha":
        return marcha_frontal(s)
    if tipo == "sentadilla":
        return sentadilla(s)
    raise ValueError(tipo)
