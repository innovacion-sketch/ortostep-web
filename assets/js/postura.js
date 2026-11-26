/* ==========================================================
   ORTOSTEP — revisión de los videos de movimiento en el navegador.
   Usa MediaPipe Pose Landmarker (Apache-2.0). El video no sale del
   celular para esta revisión.

   Para cada video comprueba lo que hace falta para que el análisis
   de marcha sirva, y devuelve datos con los que la página le dice al
   cliente qué corregir:
   - todos: que se vea a la persona, sus pies y su cuerpo completo,
     a buena distancia y sin otra persona;
   - de lado: que camine de perfil, cruzando el cuadro, con suficientes pasos;
   - de frente: que camine hacia la cámara y de regreso, con suficientes pasos;
   - sentadilla: de frente, sobre cada pierna, flexionando la rodilla.
   Además genera una imagen con el esqueleto detectado.
   ========================================================== */
(function () {
  'use strict';

  var VERSION = '1.2.2';
  var BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION;
  var MODELO = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  var cargador = null;

  // Índices de MediaPipe Pose
  var NAR = 0, HI = 11, HD = 12, CI = 23, CD = 24, RI = 25, RD = 26, TI = 27, TD = 28, TALI = 29, TALD = 30, PI = 31, PD = 32;
  var HUESOS = [[HI, HD], [HI, CI], [HD, CD], [CI, CD], [CI, RI], [RI, TI], [CD, RD], [RD, TD], [TI, TALI], [TALI, PI], [TI, PI], [TD, TALD], [TALD, PD], [TD, PD], [HI, 13], [13, 15], [HD, 14], [14, 16]];

  function cargar() {
    if (!cargador) {
      cargador = import(BASE + '/vision_bundle.mjs').then(function (m) {
        return m.FilesetResolver.forVisionTasks(BASE + '/wasm').then(function (fs) {
          function opciones(delegado) {
            return {
              baseOptions: { modelAssetPath: MODELO, delegate: delegado },
              runningMode: 'IMAGE', numPoses: 2,
              minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5
            };
          }
          return m.PoseLandmarker.createFromOptions(fs, opciones('GPU'))
            .catch(function () { return m.PoseLandmarker.createFromOptions(fs, opciones('CPU')); });
        });
      });
      cargador.catch(function () { cargador = null; });
    }
    return cargador;
  }

  function esperar(el, evento, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { limpiar(); rej(new Error('tiempo')); }, ms);
      function ok() { limpiar(); res(); }
      function mal() { limpiar(); rej(new Error('video')); }
      function limpiar() { clearTimeout(t); el.removeEventListener(evento, ok); el.removeEventListener('error', mal); }
      el.addEventListener(evento, ok); el.addEventListener('error', mal);
    });
  }

  function visible(l) { return l && (l.visibility == null || l.visibility > 0.5); }
  function dentro(l) { return visible(l) && l.x > 0.01 && l.x < 0.99 && l.y > 0.01 && l.y < 0.99; }
  function caja(lms) {
    var x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    lms.forEach(function (l) { x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x); y0 = Math.min(y0, l.y); y1 = Math.max(y1, l.y); });
    return { area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0), alto: Math.max(0, y1 - y0) };
  }
  function mediana(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }
  function suavizar(a, v) {
    var out = [];
    for (var i = 0; i < a.length; i++) {
      var s = 0, n = 0;
      for (var j = Math.max(0, i - v); j <= Math.min(a.length - 1, i + v); j++) if (a[j] != null) { s += a[j]; n++; }
      out.push(n ? s / n : null);
    }
    return out;
  }
  // Cuenta máximos locales con separación mínima (muestras) y prominencia mínima.
  function contarPicos(a, sep, prom) {
    var n = 0, ult = -1e9;
    for (var i = 1; i < a.length - 1; i++) {
      if (a[i] == null || a[i - 1] == null || a[i + 1] == null) continue;
      if (!(a[i] >= a[i - 1] && a[i] > a[i + 1])) continue;
      var lo = Infinity, hi = -Infinity;
      for (var j = Math.max(0, i - sep); j <= Math.min(a.length - 1, i + sep); j++) if (a[j] != null) { lo = Math.min(lo, a[j]); hi = Math.max(hi, a[j]); }
      if (a[i] < hi || a[i] - lo < prom || i - ult < sep) continue;
      n++; ult = i;
    }
    return n;
  }
  function angulo(a, b, c) {
    var v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
    var d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!d) return null;
    return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
  }

  /**
   * Revisa un video. tipo: 'lado' | 'frente' | 'sentadilla'.
   * alProgresar(fraccion) se llama mientras avanza.
   */
  function revisar(blob, duracionConocida, tipo, alProgresar) {
    return cargar().then(function (detector) {
      var url = URL.createObjectURL(blob), v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
      v.src = url;
      var fr = [];            // por cuadro: {t, p: puntos de la persona principal | null, otra: bool}
      var vista = null, mejorDist = Infinity;
      return esperar(v, 'loadeddata', 20000).then(function () {
        var d = isFinite(v.duration) && v.duration > 0 ? v.duration : (duracionConocida || 0);
        if (!d) throw new Error('sin duración');
        var fps = tipo === 'sentadilla' ? 5 : 8;
        var N = Math.max(24, Math.min(180, Math.round(d * fps)));
        var vw = v.videoWidth || 640, vh = v.videoHeight || 360;
        var cv = document.createElement('canvas'), escala = 360 / Math.max(vw, vh);
        cv.width = Math.round(vw * escala); cv.height = Math.round(vh * escala);
        var i = 0;
        function siguiente() {
          if (i >= N) return Promise.resolve({ d: d, vw: vw, vh: vh, cv: cv });
          var t = Math.min(d - 0.05, d * (i + 0.5) / N), k = i; i++;
          var p = esperar(v, 'seeked', 5000);
          v.currentTime = Math.max(0, t);
          return p.then(function () {
            var res = detector.detect(v), poses = (res && res.landmarks) || [];
            var principal = poses.length ? poses.slice().sort(function (a, b) { return caja(b).area - caja(a).area; })[0] : null;
            fr.push({ t: t, p: principal, otra: poses.length > 1 });
            // Guarda el cuadro con persona más cercano a la mitad para la vista con esqueleto.
            if (principal && Math.abs(k - N / 2) < mejorDist) {
              mejorDist = Math.abs(k - N / 2);
              var c = cv.getContext('2d'); c.drawImage(v, 0, 0, cv.width, cv.height);
              vista = principal;
            }
            if (alProgresar && k % 6 === 0) alProgresar(k / N);
            return siguiente();
          }).catch(function () { return siguiente(); });
        }
        return siguiente();
      }).then(function (ctx) {
        URL.revokeObjectURL(url); v.removeAttribute('src');
        return analizar(fr, tipo, ctx, vista);
      }, function (e) { URL.revokeObjectURL(url); throw e; });
    });
  }

  function analizar(fr, tipo, ctx, vista) {
    var n = Math.max(1, fr.length), W = ctx.vw, H = ctx.vh;
    function P(f, k) { var l = f.p[k]; return [l.x * W, l.y * H]; }
    var con = fr.filter(function (f) { return f.p; });
    var r = {
      tipo: tipo, cuadros: fr.length,
      persona: +(con.length / n).toFixed(2),
      pies: +(con.filter(function (f) { return [TI, TD, TALI, TALD, PI, PD].every(function (k) { return dentro(f.p[k]); }); }).length / n).toFixed(2),
      cuerpo: +(con.filter(function (f) { return dentro(f.p[NAR]) && dentro(f.p[TI]) && dentro(f.p[TD]); }).length / n).toFixed(2),
      otra: +(fr.filter(function (f) { return f.otra; }).length / n).toFixed(2),
      modelo: 'MediaPipe Pose Landmarker lite ' + VERSION
    };
    if (!con.length) { r.vista = null; return r; }
    var altos = con.map(function (f) { return caja(f.p).alto; });
    r.altura_media = +(altos.reduce(function (a, b) { return a + b; }, 0) / altos.length).toFixed(2);
    r.acercamiento = +(Math.max.apply(null, altos) / Math.max(0.01, Math.min.apply(null, altos))).toFixed(2);
    var xs = con.map(function (f) { return (f.p[CI].x + f.p[CD].x) / 2; });
    r.desplazamiento = +(Math.max.apply(null, xs) - Math.min.apply(null, xs)).toFixed(2);
    // Orientación: hombros juntos (perfil) o separados (de frente), relativo al largo del torso.
    var perfil = 0, frente = 0;
    con.forEach(function (f) {
      var hx = Math.abs(P(f, HI)[0] - P(f, HD)[0]);
      var mh = [(P(f, HI)[0] + P(f, HD)[0]) / 2, (P(f, HI)[1] + P(f, HD)[1]) / 2];
      var mc = [(P(f, CI)[0] + P(f, CD)[0]) / 2, (P(f, CI)[1] + P(f, CD)[1]) / 2];
      var torso = Math.hypot(mh[0] - mc[0], mh[1] - mc[1]) || 1;
      if (hx < 0.45 * torso) perfil++;
      if (hx > 0.6 * torso) frente++;
    });
    r.perfil = +(perfil / con.length).toFixed(2);
    r.de_frente = +(frente / con.length).toFixed(2);
    var pierna = mediana(con.map(function (f) { var a = P(f, CI), b = P(f, TI); return Math.hypot(a[0] - b[0], a[1] - b[1]); })) || H * 0.3;
    var dt = fr.length > 1 ? (fr[fr.length - 1].t - fr[0].t) / (fr.length - 1) : 0.15;
    var sep = Math.max(1, Math.round(0.3 / dt));

    if (tipo === 'lado') {
      var cx = suavizar(fr.map(function (f) { return f.p ? (f.p[CI].x + f.p[CD].x) / 2 * W : null; }), 2);
      var vel = cx.map(function (x, i) { return (x != null && cx[i - 1] != null) ? x - cx[i - 1] : null; });
      var dir = suavizar(vel, 3).map(function (x) { return x == null ? 0 : Math.sign(x); });
      var pasos = 0;
      [TALI, TALD].forEach(function (k) {
        var rel = fr.map(function (f, i) { return f.p && cx[i] != null && dir[i] ? (f.p[k].x * W - cx[i]) * dir[i] : null; });
        pasos += contarPicos(suavizar(rel, 1), sep, 0.12 * pierna);
      });
      r.pasos = pasos;
    } else if (tipo === 'frente') {
      var dif = fr.map(function (f) { return f.p ? (f.p[TI].y - f.p[TD].y) * H : null; });
      var s = suavizar(dif, 1), umbral = 0.03 * pierna, estado = 0, cruces = 0;
      s.forEach(function (x) {
        if (x == null) return;
        var e = x > umbral ? 1 : x < -umbral ? -1 : 0;
        if (e && e !== estado) { if (estado) cruces++; estado = e; }
      });
      r.pasos = cruces;
    } else if (tipo === 'sentadilla') {
      var apoyo = { izquierdo: 0, derecho: 0 }, flex = { izquierdo: 0, derecho: 0 };
      con.forEach(function (f) {
        var d = (f.p[TI].y - f.p[TD].y) * H; // positivo: tobillo izquierdo más abajo (apoyo izquierdo)
        var lado = d > 0.06 * pierna ? 'izquierdo' : d < -0.06 * pierna ? 'derecho' : null;
        if (!lado) return;
        apoyo[lado] += dt;
        var c = lado === 'izquierdo' ? [CI, RI, TI] : [CD, RD, TD];
        var a = angulo(P(f, c[0]), P(f, c[1]), P(f, c[2]));
        if (a != null) flex[lado] = Math.max(flex[lado], 180 - a);
      });
      r.apoyo_s = { izquierdo: +apoyo.izquierdo.toFixed(1), derecho: +apoyo.derecho.toFixed(1) };
      r.flexion_max = { izquierdo: Math.round(flex.izquierdo), derecho: Math.round(flex.derecho) };
    }
    r.vista = dibujarVista(ctx.cv, vista);
    return r;
  }

  function dibujarVista(cv, lm) {
    if (!lm) return null;
    try {
      var c = cv.getContext('2d'), W = cv.width, H = cv.height;
      c.lineWidth = Math.max(2, W / 120); c.lineCap = 'round';
      HUESOS.forEach(function (h) {
        var a = lm[h[0]], b = lm[h[1]];
        if (!visible(a) || !visible(b)) return;
        c.strokeStyle = '#2EA8A5';
        c.beginPath(); c.moveTo(a.x * W, a.y * H); c.lineTo(b.x * W, b.y * H); c.stroke();
      });
      [TI, TD, TALI, TALD, PI, PD].forEach(function (k) {
        var l = lm[k]; if (!visible(l)) return;
        c.fillStyle = '#FFB020'; c.beginPath(); c.arc(l.x * W, l.y * H, Math.max(3, W / 90), 0, Math.PI * 2); c.fill();
      });
      return cv.toDataURL('image/jpeg', 0.75);
    } catch (e) { return null; }
  }

  window.OrtostepPostura = { revisar: revisar, cargar: cargar };
})();
