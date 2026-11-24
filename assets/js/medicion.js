/* ==========================================================
   ORTOSTEP — medición del pie en una foto cenital sobre hoja
   carta o A4, con el talón contra la pared.
   Todo corre en el navegador; no se envía nada.

   Pasos:
   1. Encuentra la hoja (región blanca más grande) y sus 4 orillas.
   2. Distingue carta de A4 por la proporción de la hoja.
   3. Corrige la perspectiva (homografía) a una cuadrícula de 0.5 mm.
   4. Separa el pie del papel por color, mide largo desde la pared,
      ancho del antepié y posición de la 1.ª y 5.ª cabeza metatarsal.
   ========================================================== */
(function () {
  'use strict';

  var HOJAS = {
    A4: { corto: 210, largo: 297 },
    carta: { corto: 215.9, largo: 279.4 }
  };
  var RES = 0.5; // mm por celda de la cuadrícula corregida

  function cargarImagen(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), im = new Image();
      im.onload = function () { res({ im: im, url: url }); };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('No se pudo abrir la imagen')); };
      im.src = url;
    });
  }

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, max = 0, th = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > max) { max = between; th = i; }
    }
    return th;
  }

  // Componente conectado más grande de una máscara (4 vecinos).
  function componenteMayor(mask, w, h) {
    var n = w * h, lab = new Int32Array(n), stack = new Int32Array(n), cur = 0;
    var best = { id: 0, area: 0, borde: 0 };
    for (var i = 0; i < n; i++) {
      if (!mask[i] || lab[i]) continue;
      cur++; var sp = 0, area = 0, borde = 0;
      stack[sp++] = i; lab[i] = cur;
      while (sp) {
        var p = stack[--sp]; area++;
        var x = p % w, y = (p / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) borde++;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (area > best.area) best = { id: cur, area: area, borde: borde };
    }
    return { lab: lab, best: best };
  }

  function envolventeConvexa(pts) {
    pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // Ajusta las 4 orillas de la hoja a partir de la envolvente convexa:
  // agrupa los segmentos en dos direcciones dominantes, separa cada
  // dirección en dos lados, ajusta una recta por lado e intersecta.
  // Así una esquina tapada (por el pie, la pierna o una sombra) se reconstruye.
  function cuadrilatero(H) {
    var n = H.length, segs = [], i;
    if (n < 4) return null;
    for (i = 0; i < n; i++) {
      var a = H[i], b = H[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 3) continue;
      var ang = Math.atan2(dy, dx); if (ang < 0) ang += Math.PI; if (ang >= Math.PI) ang -= Math.PI;
      segs.push({ a: a, b: b, len: len, ang: ang });
    }
    var hist = new Float64Array(180);
    segs.forEach(function (s) { hist[Math.floor(s.ang / Math.PI * 180) % 180] += s.len; });
    function suav(k) { var t = 0; for (var d = -4; d <= 4; d++) t += hist[(k + d + 180) % 180]; return t; }
    function distAng(a, b) { var d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); }
    var p1 = 0, v1 = -1, k;
    for (k = 0; k < 180; k++) { var s1 = suav(k); if (s1 > v1) { v1 = s1; p1 = k; } }
    var p2 = -1, v2 = -1;
    for (k = 0; k < 180; k++) { if (distAng(k, p1) < 35) continue; var s2 = suav(k); if (s2 > v2) { v2 = s2; p2 = k; } }
    if (p2 < 0) return null;
    function grupo(pk) {
      var g = segs.filter(function (s) { return distAng(s.ang / Math.PI * 180, pk + 0.5) < 22; });
      var th = (pk + 0.5) / 180 * Math.PI, nx = -Math.sin(th), ny = Math.cos(th);
      g.forEach(function (s) { s.off = nx * (s.a[0] + s.b[0]) / 2 + ny * (s.a[1] + s.b[1]) / 2; });
      if (g.length < 2) return null;
      g.sort(function (x, y) { return x.off - y.off; });
      var gap = -1, cut = -1;
      for (var j = 0; j < g.length - 1; j++) { var d = g[j + 1].off - g[j].off; if (d > gap) { gap = d; cut = j; } }
      return [g.slice(0, cut + 1), g.slice(cut + 1)];
    }
    function recta(lado) {
      // Recta por mínimos cuadrados totales con los extremos de los segmentos, pesados por longitud.
      var sw = 0, mx = 0, my = 0;
      lado.forEach(function (s) { [s.a, s.b].forEach(function (p) { sw += s.len; mx += p[0] * s.len; my += p[1] * s.len; }); });
      mx /= sw; my /= sw;
      var sxx = 0, syy = 0, sxy = 0;
      lado.forEach(function (s) { [s.a, s.b].forEach(function (p) { var dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx * s.len; syy += dy * dy * s.len; sxy += dx * dy * s.len; }); });
      var t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      return { p: [mx, my], d: [Math.cos(t), Math.sin(t)], peso: lado.reduce(function (z, s) { return z + s.len; }, 0) };
    }
    function corte(r1, r2) {
      var den = r1.d[0] * r2.d[1] - r1.d[1] * r2.d[0];
      if (Math.abs(den) < 1e-6) return null;
      var t = ((r2.p[0] - r1.p[0]) * r2.d[1] - (r2.p[1] - r1.p[1]) * r2.d[0]) / den;
      return [r1.p[0] + t * r1.d[0], r1.p[1] + t * r1.d[1]];
    }
    var gA = grupo(p1), gB = grupo(p2);
    if (!gA || !gB || !gA[0].length || !gA[1].length || !gB[0].length || !gB[1].length) return null;
    var a0 = recta(gA[0]), a1 = recta(gA[1]), b0 = recta(gB[0]), b1 = recta(gB[1]);
    var q = [corte(a0, b0), corte(a0, b1), corte(a1, b1), corte(a1, b0)];
    if (q.some(function (c) { return !c; })) return null;
    // Ordena por ángulo alrededor del centro para formar un polígono simple.
    var cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    q.sort(function (u, v) { return Math.atan2(u[1] - cy, u[0] - cx) - Math.atan2(v[1] - cy, v[0] - cx); });
    return q;
  }

  function resolver(A, b) {
    var n = b.length, M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      var t = M[c]; M[c] = M[piv]; M[piv] = t;
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (r = 0; r < n; r++) {
        if (r === c) continue;
        var f = M[r][c] / M[c][c];
        for (var k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map(function (r, i) { return r[n] / r[i]; });
  }
  // Homografía que lleva puntos src (mm) a dst (píxeles).
  function homografia(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var u = src[i][0], v = src[i][1], x = dst[i][0], y = dst[i][1];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    var h = resolver(A, b); if (!h) return null;
    h.push(1); return h;
  }
  function aplicar(h, u, v) {
    var d = h[6] * u + h[7] * v + h[8];
    return [(h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d];
  }
  function mediana(arr) {
    if (!arr.length) return 0;
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    return a[a.length >> 1];
  }
  function fallo(motivo) { return { ok: false, motivo: motivo }; }

  // Proporción real (lado largo / lado corto) de un rectángulo fotografiado en perspectiva.
  // Método de Zhang y He (2007, "Whiteboard scanning and image enhancement"): estima la
  // distancia focal a partir del propio cuadrilátero; si no se puede, usa la típica de un celular.
  // q: esquinas en orden [ (0,0), (largo,0), (largo,corto), (0,corto) ].
  function proporcionReal(q, w, h) {
    function cruz(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function punto(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    var m1 = [q[0][0], q[0][1], 1], m2 = [q[1][0], q[1][1], 1], m3 = [q[3][0], q[3][1], 1], m4 = [q[2][0], q[2][1], 1];
    var k2 = punto(cruz(m1, m4), m3) / punto(cruz(m2, m4), m3);
    var k3 = punto(cruz(m1, m4), m2) / punto(cruz(m3, m4), m2);
    var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    var n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    var u0 = w / 2, v0 = h / 2, fTipica = 0.78 * Math.max(w, h), f = fTipica;
    var den = n2[2] * n3[2];
    if (Math.abs(den) > 1e-9) {
      var f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0) +
                 (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / den;
      if (f2 > 0) { var fe = Math.sqrt(f2); if (fe > 0.45 * Math.max(w, h) && fe < 1.8 * Math.max(w, h)) f = fe; }
    }
    function norma(n) { // n^T A^-T A^-1 n con A = [[f,0,u0],[0,f,v0],[0,0,1]]
      var a = (n[0] - u0 * n[2]) / f, b = (n[1] - v0 * n[2]) / f;
      return a * a + b * b + n[2] * n[2];
    }
    var r = Math.sqrt(norma(n2) / norma(n3));
    if (!isFinite(r) || r <= 0) {
      function lon(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
      r = ((lon(q[0], q[1]) + lon(q[2], q[3])) / 2) / ((lon(q[1], q[2]) + lon(q[3], q[0])) / 2);
    }
    return r < 1 ? 1 / r : r;
  }

  function medirPie(blob, lado) {
    return cargarImagen(blob).then(function (r) {
      try { return medir(r.im, lado); }
      finally { URL.revokeObjectURL(r.url); }
    });
  }

  function medir(im, lado) {
    var W0 = im.naturalWidth, H0 = im.naturalHeight;
    var sc = Math.min(1, 1800 / Math.max(W0, H0));
    var w = Math.max(10, Math.round(W0 * sc)), h = Math.max(10, Math.round(H0 * sc)), n = w * h;
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    var px = ctx.getImageData(0, 0, w, h).data;

    // 1) Máscara de papel: claro y poco saturado.
    var V = new Float32Array(n), S = new Float32Array(n), hist = new Uint32Array(256), i;
    for (i = 0; i < n; i++) {
      var R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
      var mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      V[i] = mx; S[i] = mx ? (mx - mn) / mx : 0; hist[mx]++;
    }
    var th = Math.max(otsu(hist, n), 110);
    var mask = new Uint8Array(n);
    for (i = 0; i < n; i++) mask[i] = V[i] > th && S[i] < 0.3 ? 1 : 0;
    var cc = componenteMayor(mask, w, h), best = cc.best;
    if (best.area < n * 0.012) return fallo('No encontramos la hoja en la foto. Que la hoja se vea completa y con buena luz.');
    if (best.area > n * 0.88 || best.borde > 2 * (w + h) * 0.45) {
      return fallo('No logramos separar la hoja del piso. Si tu piso es blanco o muy claro, pon debajo una toalla o tela oscura, y que se vea piso alrededor de la hoja.');
    }

    // 2) Orillas y esquinas de la hoja.
    var pts = [];
    var lab = cc.lab, id = best.id, x, y;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var p = y * w + x; if (lab[p] !== id) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || lab[p - 1] !== id || lab[p + 1] !== id || lab[p - w] !== id || lab[p + w] !== id) pts.push([x, y]);
    }
    var q = cuadrilatero(envolventeConvexa(pts));
    if (!q) return fallo('No se distinguen las 4 orillas de la hoja. Que se vean las 4 esquinas y que la hoja no esté doblada.');
    var fuera = q.some(function (c) { return c[0] < -0.08 * w || c[0] > 1.08 * w || c[1] < -0.08 * h || c[1] > 1.08 * h; });
    if (fuera) return fallo('Una esquina de la hoja queda fuera de la foto. Aléjate un poco para que se vean las 4.');

    // Orden horario visual (área positiva en coordenadas de imagen) para no reflejar la imagen.
    var area2 = 0;
    for (i = 0; i < 4; i++) area2 += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
    if (area2 < 0) q.reverse();
    function lon(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
    var s = [lon(q[0], q[1]), lon(q[1], q[2]), lon(q[2], q[3]), lon(q[3], q[0])];
    if ((s[0] + s[2]) < (s[1] + s[3])) { q = [q[1], q[2], q[3], q[0]]; s = [s[1], s[2], s[3], s[0]]; }
    var persp = Math.max(s[0] / s[2], s[2] / s[0], s[1] / s[3], s[3] / s[1]);
    if (persp > 1.45) return fallo('La foto está muy inclinada. Tómala con el celular paralelo al piso, justo encima del pie.');
    var aspecto = proporcionReal(q, w, h);
    var dA4 = Math.abs(aspecto - HOJAS.A4.largo / HOJAS.A4.corto), dCarta = Math.abs(aspecto - HOJAS.carta.largo / HOJAS.carta.corto);
    var tipo = dA4 < dCarta ? 'A4' : 'carta', hoja = HOJAS[tipo];
    var avisos = [], confianza = 2;
    if (Math.min(dA4, dCarta) > 0.07) { avisos.push('No pudimos confirmar si la hoja es carta o A4; supusimos ' + tipo + '.'); confianza--; }
    if (persp > 1.15) { avisos.push('La foto está algo inclinada; la medida puede variar unos milímetros. Si puedes, repítela más desde arriba.'); confianza--; }

    var L = hoja.largo, Wd = hoja.corto;
    var Hm = homografia([[0, 0], [L, 0], [L, Wd], [0, Wd]], q);
    if (!Hm) return fallo('No pudimos corregir la perspectiva de la foto. Repítela desde arriba.');

    // 3) Cuadrícula corregida a 0.5 mm.
    var NU = Math.round(L / RES), NV = Math.round(Wd / RES), NN = NU * NV;
    var RV = new Float32Array(NN), RS = new Float32Array(NN);
    for (var iv = 0; iv < NV; iv++) for (var iu = 0; iu < NU; iu++) {
      var xy = aplicar(Hm, (iu + 0.5) * RES, (iv + 0.5) * RES);
      var fx = Math.min(w - 1.001, Math.max(0, xy[0])), fy = Math.min(h - 1.001, Math.max(0, xy[1]));
      var x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, c = [0, 0, 0];
      for (var ch = 0; ch < 3; ch++) {
        var p00 = px[(y0 * w + x0) * 4 + ch], p10 = px[(y0 * w + x0 + 1) * 4 + ch];
        var p01 = px[((y0 + 1) * w + x0) * 4 + ch], p11 = px[((y0 + 1) * w + x0 + 1) * 4 + ch];
        c[ch] = (p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay;
      }
      var cmx = Math.max(c[0], c[1], c[2]), cmn = Math.min(c[0], c[1], c[2]), k2 = iv * NU + iu;
      RV[k2] = cmx; RS[k2] = cmx ? (cmx - cmn) / cmx : 0;
    }
    // Color de referencia del papel: franja de 3 a 9 mm junto a las orillas.
    var bv = [], bs = [];
    for (iv = 0; iv < NV; iv++) for (iu = 0; iu < NU; iu++) {
      var du = Math.min(iu, NU - 1 - iu) * RES, dv = Math.min(iv, NV - 1 - iv) * RES, dmin = Math.min(du, dv);
      if (dmin >= 3 && dmin <= 9 && ((iu + iv) % 3 === 0)) { bv.push(RV[iv * NU + iu]); bs.push(RS[iv * NU + iu]); }
    }
    var Vp = mediana(bv), Sp = mediana(bs);

    // 4) Pie: piel (más saturada que el papel) o mucho más oscuro que el papel.
    var margen = Math.round(1.5 / RES), pie = new Uint8Array(NN);
    for (iv = margen; iv < NV - margen; iv++) for (iu = margen; iu < NU - margen; iu++) {
      var k3 = iv * NU + iu, v3 = RV[k3], s3 = RS[k3];
      pie[k3] = ((s3 > Sp + 0.09 && v3 < Vp * 1.02) || v3 < Vp * 0.45) ? 1 : 0;
    }
    // Apertura morfológica (quita ruido y sombras finas).
    function morf(src, erosion) {
      var out = new Uint8Array(NN), rr = 2;
      for (var b = 0; b < NV; b++) for (var a = 0; a < NU; a++) {
        var val = erosion ? 1 : 0;
        for (var db = -rr; db <= rr && (erosion ? val : !val); db++) for (var da = -rr; da <= rr; da++) {
          var aa = a + da, bb = b + db;
          var on = aa >= 0 && bb >= 0 && aa < NU && bb < NV && src[bb * NU + aa];
          if (erosion && !on) { val = 0; break; }
          if (!erosion && on) { val = 1; break; }
        }
        out[b * NU + a] = val;
      }
      return out;
    }
    pie = morf(morf(pie, true), false);
    var ccp = componenteMayor(pie, NU, NV);
    if (ccp.best.area * RES * RES < 4000) return fallo('No encontramos tu pie sobre la hoja. Párate descalzo sobre ella, con buena luz y sin calcetines.');
    var fid = ccp.best.id, flab = ccp.lab;

    // Lado del talón: la orilla corta que toca el pie (contra la pared).
    var cerca0 = 0, cercaL = 0, ladoLat0 = 0, ladoLatW = 0, banda = Math.round(8 / RES);
    for (iv = 0; iv < NV; iv++) for (iu = 0; iu < NU; iu++) {
      if (flab[iv * NU + iu] !== fid) continue;
      if (iu < banda) cerca0++;
      if (iu >= NU - banda) cercaL++;
      if (iv < Math.round(4 / RES)) ladoLat0++;
      if (iv >= NV - Math.round(4 / RES)) ladoLatW++;
    }
    if (cerca0 > 40 && cercaL > 40) return fallo('Tu pie toca las dos orillas cortas de la hoja: es más largo que la hoja o la pierna tapa la foto. Si tu pie no cabe, usa una hoja A4 o escribe el largo con regla.');
    var talonEnCero = cerca0 >= cercaL;
    var tocaPared = Math.max(cerca0, cercaL) > 40;
    if (!tocaPared) { avisos.push('Tu talón no parece tocar la orilla de la hoja junto a la pared; medimos desde donde empieza el pie.'); confianza--; }
    if (ladoLat0 + ladoLatW > 200) { avisos.push('Tu pie toca una orilla larga de la hoja; el ancho puede salir menor. Centra el pie en la hoja.'); confianza--; }

    // Ejes: y = distancia desde la pared (mm); x = hacia el lado interno (medial) positivo.
    // En una vista desde arriba sin reflejar, con los dedos hacia arriba, el lado interno
    // del pie derecho queda a la izquierda y el del izquierdo a la derecha.
    var derecho = lado !== 'izquierdo';
    var signoMedial = derecho ? (talonEnCero ? -1 : 1) : (talonEnCero ? 1 : -1);
    function aY(iu2) { var u = (iu2 + 0.5) * RES; return talonEnCero ? u : L - u; }
    function aX(iv2) { return signoMedial * ((iv2 + 0.5) * RES - Wd / 2); }
    var yMin = Infinity, yMax = -Infinity, puntaX = 0;
    for (iv = 0; iv < NV; iv++) for (iu = 0; iu < NU; iu++) {
      if (flab[iv * NU + iu] !== fid) continue;
      var yy = aY(iu);
      if (yy < yMin) yMin = yy;
      if (yy > yMax) { yMax = yy; puntaX = aX(iv); }
    }
    var yRef = tocaPared ? 0 : yMin;
    var largo = yMax - yRef;
    if (largo < 140 || largo > 330) return fallo('La medida no tiene sentido (' + Math.round(largo) + ' mm). Repite la foto siguiendo la guía.');

    // Perfil por renglón cada 1 mm: extremo medial y lateral.
    var nb = Math.ceil(largo) + 2, med = new Float32Array(nb).fill(-Infinity), lat = new Float32Array(nb).fill(Infinity);
    for (iv = 0; iv < NV; iv++) for (iu = 0; iu < NU; iu++) {
      if (flab[iv * NU + iu] !== fid) continue;
      var yb = Math.floor(aY(iu) - yRef); if (yb < 0 || yb >= nb) continue;
      var xx = aX(iv);
      if (xx > med[yb]) med[yb] = xx;
      if (xx < lat[yb]) lat[yb] = xx;
    }
    function rango(a, b, f) {
      var bi = -1, bv2 = -Infinity;
      for (var r = Math.floor(largo * a); r <= Math.floor(largo * b) && r < nb; r++) { var val = f(r); if (val > bv2) { bv2 = val; bi = r; } }
      return { r: bi, v: bv2 };
    }
    var bola = rango(0.55, 0.85, function (r) { return isFinite(med[r]) && isFinite(lat[r]) ? med[r] - lat[r] : -Infinity; });
    var mtp1 = rango(0.55, 0.85, function (r) { return isFinite(med[r]) ? med[r] : -Infinity; });
    var mtp5 = rango(0.50, 0.80, function (r) { return isFinite(lat[r]) ? -lat[r] : -Infinity; });
    var ancho = bola.v;
    if (!(ancho > 50)) return fallo('No pudimos medir el ancho de tu pie. Repite la foto con todo el pie dentro de la hoja.');
    var rel = ancho / largo;
    if (rel < 0.31 || rel > 0.47) { avisos.push('La proporción entre largo y ancho se ve poco común; el ortesista la revisará.'); confianza--; }

    // Contorno en mm (lateral de talón a punta, luego medial de punta a talón), cada 2 mm.
    var lateralPts = [], medialPts = [];
    for (var r2 = 0; r2 < nb; r2 += 2) {
      if (!isFinite(med[r2]) || !isFinite(lat[r2])) continue;
      lateralPts.push([+lat[r2].toFixed(1), r2]);
      medialPts.push([+med[r2].toFixed(1), r2]);
    }
    var contorno = lateralPts.concat(medialPts.reverse());

    // Puntos para dibujar sobre la foto (coordenadas normalizadas 0–1).
    function aImagen(xm, ym) {
      var y0b = ym + yRef, u = talonEnCero ? y0b : L - y0b, v = xm / signoMedial + Wd / 2;
      var pIm = aplicar(Hm, u, v); return [+(pIm[0] / w).toFixed(4), +(pIm[1] / h).toFixed(4)];
    }
    var overlay = {
      hoja: q.map(function (c) { return [+(c[0] / w).toFixed(4), +(c[1] / h).toFixed(4)]; }),
      contorno: contorno.filter(function (_, j) { return j % 2 === 0; }).map(function (c) { return aImagen(c[0], c[1]); }),
      lineaLargo: [aImagen(puntaX, 0), aImagen(puntaX, largo)],
      lineaAncho: [aImagen(lat[bola.r], bola.r), aImagen(med[bola.r], bola.r)]
    };

    return {
      ok: true,
      hoja: tipo,
      largo_mm: Math.round(largo),
      ancho_mm: Math.round(ancho),
      ancho_talon_estimado_mm: Math.round(ancho * 0.63),
      bola_pct: +(bola.r / largo).toFixed(3),
      mtp1_pct: +(mtp1.r / largo).toFixed(3),
      mtp5_pct: +(mtp5.r / largo).toFixed(3),
      confianza: confianza >= 2 ? 'alta' : confianza === 1 ? 'media' : 'baja',
      avisos: avisos,
      perspectiva: +persp.toFixed(3),
      aspecto: +aspecto.toFixed(3),
      contorno_mm: contorno,
      overlay: overlay,
      nota: 'Medición 2D en el navegador. Largo desde la pared hasta el dedo más largo; ancho máximo del antepié. Talón y retropié pueden quedar tapados por la pierna en la foto.'
    };
  }

  // Dibuja la foto con la hoja, el contorno y las líneas de medida.
  function dibujar(canvas, blob, m) {
    return cargarImagen(blob).then(function (r) {
      var im = r.im, maxW = 900, sc = Math.min(1, maxW / im.naturalWidth);
      canvas.width = Math.round(im.naturalWidth * sc); canvas.height = Math.round(im.naturalHeight * sc);
      var c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
      c.drawImage(im, 0, 0, W, H);
      URL.revokeObjectURL(r.url);
      var o = m.overlay; if (!o) return;
      var lw = Math.max(2, W / 250);
      function poly(pts, color, cerrar) {
        c.beginPath(); pts.forEach(function (p, i) { (i ? c.lineTo : c.moveTo).call(c, p[0] * W, p[1] * H); });
        if (cerrar) c.closePath(); c.strokeStyle = color; c.lineWidth = lw; c.stroke();
      }
      poly(o.hoja, '#2EA8A5', true);
      poly(o.contorno, '#FFB020', true);
      poly(o.lineaLargo, '#ffffff', false);
      poly(o.lineaAncho, '#ffffff', false);
      c.font = '800 ' + Math.round(W / 26) + 'px Manrope, sans-serif';
      c.fillStyle = 'rgba(30,32,51,.8)';
      var txt = (m.largo_mm / 10).toFixed(1) + ' × ' + (m.ancho_mm / 10).toFixed(1) + ' cm · hoja ' + m.hoja;
      var tw = c.measureText(txt).width;
      c.fillRect(8, 8, tw + 20, W / 26 + 18);
      c.fillStyle = '#fff'; c.fillText(txt, 18, 8 + W / 26 + 4);
    });
  }

  window.OrtostepMedicion = { medirPie: medirPie, dibujar: dibujar, HOJAS: HOJAS };
})();
