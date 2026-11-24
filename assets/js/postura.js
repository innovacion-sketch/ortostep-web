/* ==========================================================
   ORTOSTEP — revisión de postura en los videos de movimiento.
   Usa MediaPipe Pose Landmarker (Apache-2.0) dentro del navegador
   para comprobar que se ve a la persona, sus pies y su cuerpo
   completo. No envía el video a ningún lado.
   Las métricas clínicas (cadencia, apoyo, ángulos) se calculan
   después, en el programa de diseño, con el video completo.
   ========================================================== */
(function () {
  'use strict';

  var VERSION = '1.2.2';
  var BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION;
  var MODELO = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  var CUADROS = 20;
  var cargador = null;

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

  function dentro(l) {
    return l && l.x > 0.01 && l.x < 0.99 && l.y > 0.01 && l.y < 0.99 && (l.visibility == null || l.visibility > 0.5);
  }
  function caja(lms) {
    var x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    lms.forEach(function (l) { x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x); y0 = Math.min(y0, l.y); y1 = Math.max(y1, l.y); });
    return { area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0), alto: Math.max(0, y1 - y0) };
  }

  // Devuelve proporciones (0–1) de cuadros donde se cumple cada condición.
  function revisar(blob, duracionConocida) {
    return cargar().then(function (detector) {
      var url = URL.createObjectURL(blob), v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
      v.src = url;
      var r = { cuadros: 0, persona: 0, pies: 0, cuerpo: 0, otra: 0, desplazamiento: 0, altura_media: 0 };
      var xs = [], alturas = [];
      return esperar(v, 'loadeddata', 20000).then(function () {
        var d = isFinite(v.duration) && v.duration > 0 ? v.duration : (duracionConocida || 0);
        if (!d) throw new Error('sin duración');
        var i = 0;
        function siguiente() {
          if (i >= CUADROS) return Promise.resolve();
          var t = Math.min(d - 0.05, d * (i + 0.5) / CUADROS); i++;
          var p = esperar(v, 'seeked', 5000);
          v.currentTime = Math.max(0, t);
          return p.then(function () {
            var res = detector.detect(v);
            r.cuadros++;
            var poses = (res && res.landmarks) || [];
            if (!poses.length) return siguiente();
            r.persona++;
            if (poses.length > 1) r.otra++;
            var lm = poses.slice().sort(function (a, b) { return caja(b).area - caja(a).area; })[0];
            if ([27, 28, 29, 30, 31, 32].every(function (k) { return dentro(lm[k]); })) r.pies++;
            if (dentro(lm[0]) && dentro(lm[27]) && dentro(lm[28])) r.cuerpo++;
            xs.push((lm[23].x + lm[24].x) / 2);
            alturas.push(caja(lm).alto);
            return siguiente();
          }).catch(function () { return siguiente(); });
        }
        return siguiente();
      }).then(function () {
        var n = Math.max(1, r.cuadros);
        var out = {
          cuadros: r.cuadros,
          persona: +(r.persona / n).toFixed(2),
          pies: +(r.pies / n).toFixed(2),
          cuerpo: +(r.cuerpo / n).toFixed(2),
          otra: +(r.otra / n).toFixed(2),
          desplazamiento: xs.length ? +(Math.max.apply(null, xs) - Math.min.apply(null, xs)).toFixed(2) : 0,
          altura_media: alturas.length ? +(alturas.reduce(function (a, b) { return a + b; }, 0) / alturas.length).toFixed(2) : 0,
          modelo: 'MediaPipe Pose Landmarker lite ' + VERSION
        };
        URL.revokeObjectURL(url); v.removeAttribute('src');
        return out;
      }, function (e) { URL.revokeObjectURL(url); throw e; });
    });
  }

  window.OrtostepPostura = { revisar: revisar, cargar: cargar };
})();
