/* ==========================================================
   ORTOSTEP — lógica de la página
   - Revisión real de cada captura (duración, luz, nitidez, resolución)
   - Guardado del avance en el celular (localStorage + IndexedDB)
   - Envío del expediente a Supabase, o por WhatsApp si no está configurado
   - Códigos de promoción validados en el servidor (nunca en la página)
   ========================================================== */
(function () {
  'use strict';

  var C = window.ORTOSTEP_CONFIG || {};
  var ONLINE = !!(C.supabaseUrl && C.supabaseAnonKey);
  var SB_URL = (C.supabaseUrl || '').replace(/\/+$/, '');
  var WA = String(C.whatsapp || '').replace(/\D/g, '');
  var EMAIL = C.email || 'hola@ortostep.com.mx';
  var MAX_MB = C.maxUploadMB || 50;
  var BUCKET = C.bucket || 'expedientes';

  var $ = function (id) { return document.getElementById(id); };
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '$' + Number(n).toLocaleString('es-MX'); }
  function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
  function waLink(text) { return 'https://wa.me/' + WA + (text ? '?text=' + encodeURIComponent(text) : ''); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* ---------- Generales ---------- */
  var yearEl = $('year'); if (yearEl) yearEl.textContent = new Date().getFullYear();
  qsa('[data-wa-link]').forEach(function (a) {
    if (!WA) { a.style.display = 'none'; return; }
    a.href = waLink('Hola, quiero información de las plantillas personalizadas ORTOSTEP.');
    a.target = '_blank'; a.rel = 'noopener';
  });

  /* Menú móvil */
  (function () {
    var btn = $('menuBtn'), nav = $('mobileNav');
    function set(open) {
      nav.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
    }
    btn.addEventListener('click', function () { set(!nav.classList.contains('open')); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
  })();

  /* Carrete de productos */
  var scrollToProduct = (function () {
    var track = $('carTrack'); if (!track) return function () {};
    var cards = track.children, dotsBox = $('carDots'), dots = [];
    function step() { return cards[0].getBoundingClientRect().width + 18; }
    function current() { return Math.round(track.scrollLeft / step()); }
    function go(i) { track.scrollTo({ left: i * step(), behavior: reduceMotion ? 'auto' : 'smooth' }); }
    Array.prototype.forEach.call(cards, function (card, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Ver ' + (card.getAttribute('aria-label') || 'producto ' + (i + 1)));
      b.addEventListener('click', function () { go(i); });
      dotsBox.appendChild(b); dots.push(b);
    });
    function paint() {
      var c = Math.min(cards.length - 1, Math.max(0, current()));
      dots.forEach(function (d, i) { d.classList.toggle('on', i === c); d.setAttribute('aria-current', i === c ? 'true' : 'false'); });
    }
    $('carPrev').addEventListener('click', function () { go(Math.max(0, current() - 1)); });
    $('carNext').addEventListener('click', function () { go(Math.min(cards.length - 1, current() + 1)); });
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(Math.min(cards.length - 1, current() + 1)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(Math.max(0, current() - 1)); }
    });
    track.addEventListener('scroll', paint, { passive: true });
    window.addEventListener('resize', paint);
    paint();
    return go;
  })();
  qsa('a[data-car]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      $('productos').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
      var i = +a.getAttribute('data-car');
      setTimeout(function () { scrollToProduct(i); }, reduceMotion ? 0 : 450);
    });
  });
  qsa('a[data-open-faq]').forEach(function (a) {
    a.addEventListener('click', function () { var d = $(a.getAttribute('data-open-faq')); if (d) d.open = true; });
  });

  /* ---------- Diálogos accesibles ---------- */
  var activeDialog = null, lastFocus = null;
  function openDialog(el, focusEl) {
    lastFocus = document.activeElement;
    el.hidden = false;
    document.body.classList.add('flow-open');
    activeDialog = el;
    setTimeout(function () { (focusEl || el).focus({ preventScroll: true }); }, 30);
  }
  function closeDialog(el) {
    el.hidden = true;
    if (activeDialog === el) activeDialog = null;
    if (!document.querySelector('.overlay:not([hidden])')) document.body.classList.remove('flow-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', function (e) {
    if (!activeDialog) return;
    if (e.key === 'Escape') {
      if (activeDialog === gate) closeDialog(gate);
      else if (!S.sending) closeFlow();
    }
    if (e.key === 'Tab') {
      var f = qsa('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]', activeDialog)
        .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Aviso para computadora + QR ---------- */
  var gate = $('mobileGate');
  function isDesktop() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return false;
    if (window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0) return false;
    return true;
  }
  var qrDone = false;
  function siteUrl() {
    return /^https?:$/.test(location.protocol) && !/^(localhost|127\.)/.test(location.hostname)
      ? location.origin + location.pathname
      : 'https://ortostep.com.mx/';
  }
  function makeQR() {
    if (qrDone) return; qrDone = true;
    var url = siteUrl();
    $('gateUrl').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = function () {
      try {
        var box = $('qrBox'); box.innerHTML = '';
        new window.QRCode(box, { text: url, width: 190, height: 190, colorDark: '#1E2033', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
        var img = box.querySelector('img'); if (img) img.alt = 'Código QR para abrir ORTOSTEP en tu celular';
      } catch (e) { /* se queda el QR de respaldo */ }
    };
    document.head.appendChild(s);
  }
  $('gateClose').addEventListener('click', function () { closeDialog(gate); });
  $('gateContinue').addEventListener('click', function () {
    closeDialog(gate);
    flow.classList.add('is-desktop');
    openFlow(pendingProduct, true);
  });
  gate.addEventListener('click', function (e) { if (e.target === gate) closeDialog(gate); });

  /* ==========================================================
     FLUJO DE COMPRA Y CAPTURA
     ========================================================== */
  var flow = $('flujoCompra');
  var PRODUCTS = {
    clasica:    { name: 'Plantilla Clásica',   price: 1798, img: 'assets/img/producto-clasica.webp' },
    deportiva:  { name: 'Plantilla Deportiva', price: 1998, img: 'assets/img/producto-deportiva.webp' },
    sandalia:   { name: 'Sandalia',            price: 2798, img: 'assets/img/producto-sandalia.webp' },
    bostoniana: { name: 'Bostoniana',          price: 2858, img: 'assets/img/producto-bostoniana.webp' }
  };
  function priceText(p) { return money(PRODUCTS[p].price) + ' MXN · el par'; }
  function esCalzado(p) { return p === 'sandalia' || p === 'bostoniana'; }
  var STEP_NAMES = ['Tus datos', 'Tu escaneo', 'Tus fotos', 'Tu marcha en video', 'Mapa de dolor', 'Cuestionario de salud', 'Tu actividad y tu calzado', 'Tu objetivo y envío'];
  var ZONES = {
    'p-dedos': 'Dedos (planta)', 'p-metatarso': 'Parte delantera de la planta', 'p-arco': 'Arco',
    'p-talon': 'Talón', 'd-dedos': 'Dedos (dorso)', 'd-empeine': 'Empeine', 'd-tobillo': 'Tobillo'
  };
  var CUANDO = ['Al despertar', 'Al caminar', 'Al correr', 'Al estar de pie mucho tiempo', 'Al final del día'];
  var PHOTOS = [
    { key: 'planta', title: '1. La planta de tu pie', label: 'planta', text: 'Siéntate, cruza un pie sobre la rodilla contraria y fotografía su planta completa, del talón a los dedos, llenando la pantalla. Una sola foto: del pie que más te molesta o el que salga más claro.' },
    { key: 'talon-der', title: '2. Talón derecho, desde atrás', label: 'talón derecho', text: 'De pie, con el peso repartido en ambos pies, fotografía tu talón derecho desde atrás, con el celular a la altura del piso. Así vemos la alineación de tu tobillo.' },
    { key: 'talon-izq', title: '3. Talón izquierdo, desde atrás', label: 'talón izquierdo', text: 'Igual que la anterior, ahora con tu talón izquierdo: de pie, desde atrás y con el celular a la altura del piso.' },
    { key: 'lateral-der', title: '4. Lado interno del pie derecho', label: 'lateral derecho', text: 'De pie, fotografía el lado interno de tu pie derecho (donde está el arco) con el celular a la altura del piso. Así medimos tu arco con tu peso encima.' },
    { key: 'lateral-izq', title: '5. Lado interno del pie izquierdo', label: 'lateral izquierdo', text: 'Igual que la anterior, ahora con el lado interno de tu pie izquierdo.' },
    { key: 'desgaste-der', title: '6. Suela de tu zapato derecho', label: 'suela derecha', text: 'Voltea el zapato derecho que más usas y fotografía su suela completa. El desgaste nos dice cómo cargas tu peso al caminar.' },
    { key: 'desgaste-izq', title: '7. Suela de tu zapato izquierdo', label: 'suela izquierda', text: 'Igual que la anterior, con el zapato izquierdo del mismo par.' }
  ];
  var RULES = {
    'scan-derecho':   { type: 'video', min: 10, max: 90,  label: 'Escaneo del pie derecho' },
    'scan-izquierdo': { type: 'video', min: 10, max: 90,  label: 'Escaneo del pie izquierdo' },
    marcha:           { type: 'video', min: 6,  max: 90,  label: 'Video caminando' },
    sentadilla:       { type: 'video', min: 6,  max: 120, label: 'Prueba de movimiento' }
  };
  PHOTOS.forEach(function (p) { RULES[p.key] = { type: 'image', label: 'Foto: ' + p.label }; });
  var FILE_ORDER = ['scan-derecho', 'scan-izquierdo'].concat(PHOTOS.map(function (p) { return p.key; }), ['marcha', 'sentadilla']);

  var S = {
    product: 'clasica', step: 1, files: {}, pain: {}, sinDolor: false,
    cupon: null, orderId: null, uploaded: {}, sending: false, restored: false
  };
  var FILES = {};      // key -> File/Blob aceptado
  var urls = {};       // key -> objectURL de la vista previa
  var pendingProduct = 'clasica';

  var flowMain = $('flowMain'), alertBox = $('flowAlert');
  var steps = qsa('.fstep', flow);
  var segs = $('progSegs').children;

  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function checkedVal(name) { var el = flow.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ''; }
  function accepted(key) { var m = S.files[key]; return !!(m && m.level !== 'err' && FILES[key]); }

  /* Tarjetas de fotos */
  $('photoGrid').innerHTML = PHOTOS.map(function (p) {
    return '<div class="upload-card" data-key="' + p.key + '">' +
      '<h3>' + p.title + ' <span class="ucheck" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span></h3>' +
      '<p>' + p.text + '</p>' +
      '<img class="uprev" alt="Vista previa: ' + p.label + '" />' +
      '<label class="upload-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Tomar o subir foto<input type="file" accept="image/*" data-file="' + p.key + '" /></label>' +
      '<span class="fname"></span><p class="qstatus" aria-live="polite"></p></div>';
  }).join('');

  function cardFor(key) {
    if (key.indexOf('scan-') === 0) return $('scanCard-' + key.slice(5));
    return flow.querySelector('.upload-card[data-key="' + key + '"]');
  }

  /* ---------- Guardado del avance ---------- */
  var LS_KEY = 'ortostep-expediente-v1';
  var idb = (function () {
    var dbp = null;
    function open() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        if (!('indexedDB' in window)) return rej(new Error('sin IndexedDB'));
        var r = indexedDB.open('ortostep', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('files'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction('files', mode), req = fn(t.objectStore('files'));
          t.oncomplete = function () { res(req && req.result); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error); };
        });
      });
    }
    return {
      put: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); },
      get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
      del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); },
      clear: function () { return tx('readwrite', function (s) { return s.clear(); }); }
    };
  })();

  function collectForm() {
    var fields = {}, radios = {};
    qsa('input[id], select[id], textarea[id]', flow).forEach(function (el) {
      if (el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') return;
      fields[el.id] = el.value;
    });
    qsa('input[type=radio]:checked', flow).forEach(function (el) { radios[el.name] = el.value; });
    var salud = qsa('input[name="salud"]:checked', flow).map(function (el) { return el.value; });
    return { fields: fields, radios: radios, salud: salud, consent: $('f-consent').checked };
  }
  function save() {
    try {
      var f = collectForm();
      localStorage.setItem(LS_KEY, JSON.stringify({
        v: 1, updated: Date.now(), product: S.product, step: S.step,
        fields: f.fields, radios: f.radios, salud: f.salud, consent: f.consent,
        pain: S.pain, sinDolor: S.sinDolor, files: S.files, cupon: S.cupon,
        orderId: S.orderId, uploaded: S.uploaded
      }));
    } catch (e) { /* almacenamiento no disponible */ }
  }
  var saveSoon = debounce(save, 400);
  flow.addEventListener('input', saveSoon);
  flow.addEventListener('change', saveSoon);

  function clearSaved() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    return idb.clear().catch(function () {});
  }

  function restore() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) {}
    if (!saved || saved.v !== 1) return Promise.resolve(false);
    Object.keys(saved.fields || {}).forEach(function (id) { var el = $(id); if (el) el.value = saved.fields[id]; });
    Object.keys(saved.radios || {}).forEach(function (name) {
      var el = flow.querySelector('input[name="' + name + '"][value="' + String(saved.radios[name]).replace(/"/g, '\\"') + '"]');
      if (el) el.checked = true;
    });
    (saved.salud || []).forEach(function (v) {
      qsa('input[name="salud"]', flow).forEach(function (el) { if (el.value === v) el.checked = true; });
    });
    $('f-consent').checked = !!saved.consent;
    S.pain = saved.pain || {}; S.sinDolor = !!saved.sinDolor;
    S.cupon = saved.cupon || null; S.orderId = saved.orderId || null; S.uploaded = saved.uploaded || {};
    S.step = Math.min(8, Math.max(1, saved.step || 1));
    if (PRODUCTS[saved.product]) S.product = saved.product;
    Object.keys(ZONES).forEach(syncZoneUI);
    $('painNone').setAttribute('aria-pressed', S.sinDolor ? 'true' : 'false');
    renderPainDetails(); syncUso(); suggestTalla();
    if (S.cupon) { $('f-cupon').value = S.cupon.code; paintCupon(); }
    var meta = saved.files || {};
    var jobs = Object.keys(meta).map(function (key) {
      if (!RULES[key] || meta[key].level === 'err') return null;
      return idb.get(key).then(function (blob) {
        if (blob) { FILES[key] = blob; S.files[key] = meta[key]; }
        paintCard(key);
      }).catch(function () { paintCard(key); });
    });
    S.restored = true;
    return Promise.all(jobs).then(function () { return true; });
  }

  /* ---------- Abrir / cerrar ---------- */
  function setProduct(p) {
    S.product = p;
    $('fpName').textContent = PRODUCTS[p].name;
    $('fpPrice').textContent = priceText(p);
    $('spProduct').textContent = PRODUCTS[p].name;
    $('spImg').src = PRODUCTS[p].img;
    $('colorPicker').hidden = !esCalzado(p);
    $('calzadoField').hidden = esCalzado(p);
    qsa('.prod-switch button', flow).forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-prod') === p ? 'true' : 'false');
    });
    if (S.step === 8) buildSummary();
    saveSoon();
  }
  function hasProgress() {
    return S.step > 1 || !!val('f-nombre') || Object.keys(FILES).length > 0;
  }
  function openFlow(product, force) {
    pendingProduct = product || pendingProduct;
    if (!force && isDesktop() && !flow.classList.contains('is-desktop')) {
      makeQR();
      openDialog(gate, $('gateTitle'));
      return;
    }
    if (product && PRODUCTS[product]) setProduct(product);
    if (S.restored && hasProgress()) {
      $('resumeText').textContent = 'Retomamos tu expediente donde lo dejaste (paso ' + S.step + ' de 8).';
      $('resumeBanner').hidden = false;
    }
    if (S.sending) { openDialog(flow, $('sendTitle')); return; }
    ['flowSend', 'flowDone', 'flowManual'].forEach(function (p) { $(p).classList.remove('show'); });
    flowMain.style.display = '';
    openDialog(flow, flow.querySelector('.fstep[data-step="' + S.step + '"] h2'));
    goTo(S.step, true);
    flow.scrollTop = 0;
  }
  function closeFlow() {
    stopRecording(true);
    qsa('.demo-box video', flow).forEach(function (v) { try { v.pause(); } catch (e) {} });
    save();
    closeDialog(flow);
  }
  qsa('[data-flow-open]').forEach(function (b) {
    b.addEventListener('click', function () { openFlow(b.getAttribute('data-product')); });
  });
  $('flowClose').addEventListener('click', closeFlow);
  qsa('.prod-switch button', flow).forEach(function (b) {
    b.addEventListener('click', function () { setProduct(b.getAttribute('data-prod')); });
  });
  $('resetFlow').addEventListener('click', function () {
    if (!window.confirm('¿Borrar todo tu avance y empezar de nuevo? Se eliminarán tus respuestas, videos y fotos guardados en este celular.')) return;
    clearSaved().then(function () { location.hash = ''; location.reload(); });
  });

  /* ---------- Navegación ---------- */
  function loadDemos(n) {
    var sec = flow.querySelector('.fstep[data-step="' + n + '"]');
    qsa('video[data-src]', sec).forEach(function (v) {
      if (v.getAttribute('src')) return;
      var box = v.closest('.demo-box');
      v.addEventListener('loadeddata', function () { box.hidden = false; v.play().catch(function () {}); }, { once: true });
      v.addEventListener('error', function () { box.hidden = true; }, { once: true });
      v.src = v.getAttribute('data-src');
      v.load();
    });
  }
  function goTo(n, initial) {
    S.step = n;
    steps.forEach(function (s) { s.classList.toggle('active', +s.getAttribute('data-step') === n); });
    for (var i = 0; i < segs.length; i++) segs[i].className = i < n - 1 ? 'done' : (i === n - 1 ? 'now' : '');
    $('progStepName').textContent = STEP_NAMES[n - 1];
    $('progStepCount').textContent = 'Paso ' + n + ' de 8';
    $('btnBack').style.visibility = n === 1 ? 'hidden' : 'visible';
    $('btnNext').style.display = n === 8 ? 'none' : '';
    hideAlert();
    loadDemos(n);
    if (n === 8) buildSummary();
    if (!initial) {
      flow.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      var h = flow.querySelector('.fstep.active h2');
      if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    }
    save();
  }
  $('btnBack').addEventListener('click', function () { if (S.step > 1) goTo(S.step - 1); });
  $('btnNext').addEventListener('click', function () {
    var errs = validate(S.step);
    if (errs.length) { showAlert(errs); return; }
    if (S.step < 8) goTo(S.step + 1);
  });
  function showAlert(errs) {
    alertBox.innerHTML = '<strong>Para continuar, completa:</strong><ul>' +
      errs.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    alertBox.classList.add('show');
    alertBox.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    alertBox.focus({ preventScroll: true });
  }
  function hideAlert() { alertBox.classList.remove('show'); alertBox.innerHTML = ''; }

  /* ---------- Validación ---------- */
  function phone10() {
    var d = val('f-whatsapp').replace(/\D/g, '');
    if (d.length === 13 && d.indexOf('521') === 0) d = d.slice(3);
    else if (d.length === 12 && d.indexOf('52') === 0) d = d.slice(2);
    return d.length === 10 ? d : '';
  }
  function fileErr(key, text) {
    var m = S.files[key];
    if (m && m.level === 'busy') return text + ' (todavía la estamos revisando)';
    if (m && m.level === 'err') return text + ' (la última no se pudo usar; repítela)';
    return text;
  }
  function validate(step) {
    var errs = [];
    if (step === 1) {
      if (val('f-nombre').length < 3) errs.push('Tu nombre completo');
      var edad = parseFloat(val('f-edad'));
      if (!(edad >= 4 && edad <= 100)) errs.push('Tu edad (de 4 a 100 años)');
      if (!val('f-sexo')) errs.push('Tu sexo');
      var peso = parseFloat(val('f-peso'));
      if (!(peso >= 15 && peso <= 250)) errs.push('Tu peso en kg');
      var est = parseFloat(val('f-estatura'));
      if (!(est >= 80 && est <= 230)) errs.push('Tu estatura en cm');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('f-correo'))) errs.push('Un correo electrónico válido');
      if (!phone10()) errs.push('Tu WhatsApp a 10 dígitos');
    }
    if (step === 2) {
      if (!accepted('scan-derecho')) errs.push(fileErr('scan-derecho', 'El video de tu pie derecho'));
      if (!accepted('scan-izquierdo')) errs.push(fileErr('scan-izquierdo', 'El video de tu pie izquierdo'));
      if (!val('f-talla')) errs.push('Tu talla de calzado');
      if (!checkedVal('arco')) errs.push('Cómo es tu arco (puedes elegir «No sé»)');
    }
    if (step === 3) {
      PHOTOS.forEach(function (p) { if (!accepted(p.key)) errs.push(fileErr(p.key, 'La foto: ' + p.title.replace(/^\d+\.\s*/, ''))); });
    }
    if (step === 4) {
      if (!accepted('marcha')) errs.push(fileErr('marcha', 'Tu video caminando'));
      if (!accepted('sentadilla')) errs.push(fileErr('sentadilla', 'Tu video de la prueba de movimiento'));
    }
    if (step === 5) {
      if (!S.sinDolor && Object.keys(S.pain).length === 0) errs.push('Marca al menos una zona de dolor, o elige «No me duele nada»');
    }
    if (step === 6) {
      if (!qsa('input[name="salud"]:checked', flow).length) errs.push('Marca tus condiciones de salud, o elige «Ninguna de las anteriores»');
    }
    if (step === 7) {
      var uso = checkedVal('uso');
      if (!uso) errs.push('Para qué vas a usar tus plantillas');
      if (uso === 'Deporte' && !val('f-deporte')) errs.push('Qué deporte practicas');
      if (uso === 'Trabajo' && !val('f-horas-pie')) errs.push('Cuántas horas pasas de pie al día');
      if (!esCalzado(S.product) && !val('f-calzado-tipo')) errs.push('El calzado donde las usarás');
      if (!checkedVal('ancho')) errs.push('El ancho de tu pie (puedes elegir «No sé»)');
    }
    return errs;
  }
  function validateFinal() {
    var errs = [];
    if (esCalzado(S.product) && !checkedVal('upper-color')) errs.push('El color de tu ' + PRODUCTS[S.product].name.toLowerCase() + ' (arriba, junto al producto)');
    if (val('f-objetivo').length < 5) errs.push('Tu objetivo, en tus palabras');
    if (val('f-dir-calle').length < 5) errs.push('Tu calle y número');
    if (!val('f-dir-colonia')) errs.push('Tu colonia');
    if (!/^\d{5}$/.test(val('f-dir-cp'))) errs.push('Tu código postal (5 dígitos)');
    if (!val('f-dir-ciudad')) errs.push('Tu ciudad o municipio');
    if (!val('f-dir-estado')) errs.push('Tu estado');
    if (!$('f-consent').checked) errs.push('Aceptar el aviso de privacidad y los términos');
    [1, 2, 3, 4, 5, 6, 7].forEach(function (n) {
      validate(n).forEach(function (e) { errs.push('Paso ' + n + ': ' + e.charAt(0).toLowerCase() + e.slice(1)); });
    });
    return errs;
  }

  /* ==========================================================
     REVISIÓN DE CAPTURAS (se hace en el celular, al momento)
     ========================================================== */
  function loadImage(url) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = rej;
      img.src = url;
    });
  }
  function analyzeImage(file) {
    var url = URL.createObjectURL(file);
    return loadImage(url).then(function (img) {
      var w = img.naturalWidth, h = img.naturalHeight;
      var sc = Math.min(1, 360 / Math.max(w, h));
      var cw = Math.max(3, Math.round(w * sc)), ch = Math.max(3, Math.round(h * sc));
      var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, cw, ch);
      var d = ctx.getImageData(0, 0, cw, ch).data, n = cw * ch, g = new Float32Array(n), sum = 0, i;
      for (i = 0; i < n; i++) { g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += g[i]; }
      var ls = 0, lq = 0, c = 0;
      for (var y = 1; y < ch - 1; y++) for (var x = 1; x < cw - 1; x++) {
        i = y * cw + x;
        var v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - cw] - g[i + cw];
        ls += v; lq += v * v; c++;
      }
      var mean = sum / n, sharp = c ? lq / c - Math.pow(ls / c, 2) : 0;
      return { w: w, h: h, mean: mean, sharp: sharp };
    }).catch(function () { return { decodeError: true }; })
      .then(function (r) { URL.revokeObjectURL(url); return r; });
  }
  function frameMean(video) {
    try {
      var cv = document.createElement('canvas'); cv.width = 96; cv.height = 96;
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 96, 96);
      var d = ctx.getImageData(0, 0, 96, 96).data, s = 0;
      for (var i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      var m = s / (d.length / 4);
      return m > 0.5 ? m : null; // un cuadro completamente negro suele ser "aún no dibujado"
    } catch (e) { return null; }
  }
  function analyzeVideo(blob, known) {
    return new Promise(function (resolve) {
      var v = document.createElement('video'), url = URL.createObjectURL(blob), done = false;
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
      function finish(r) {
        if (done) return; done = true; clearTimeout(t);
        v.removeAttribute('src'); try { v.load(); } catch (e) {}
        URL.revokeObjectURL(url); resolve(r);
      }
      var t = setTimeout(function () { finish({ timeout: true, duration: known || null }); }, 12000);
      v.onerror = function () { finish({ decodeError: true, duration: known || null }); };
      function measure(d) {
        var w = v.videoWidth, h = v.videoHeight, target = Math.max(0.1, Math.min(d / 2, d - 0.2));
        v.onseeked = function () { v.onseeked = null; setTimeout(function () { finish({ duration: d, w: w, h: h, mean: frameMean(v) }); }, 60); };
        try { v.currentTime = target; } catch (e) { finish({ duration: d, w: w, h: h, mean: null }); }
      }
      v.onloadedmetadata = function () {
        var d = v.duration;
        if (isFinite(d) && d > 0) return measure(d);
        if (known) return measure(known);
        // Videos .webm grabados en el navegador no traen duración: se fuerza a calcularla.
        v.ondurationchange = function () {
          if (isFinite(v.duration) && v.duration > 0) { v.ondurationchange = null; measure(v.duration); }
        };
        try { v.currentTime = 1e7; } catch (e) { finish({ duration: null }); }
      };
      v.src = url;
    });
  }

  function checkImage(file) {
    if (!/^image\//.test(file.type || '') && !/\.(jpe?g|png|heic|heif|webp)$/i.test(file.name || '')) {
      return Promise.resolve({ level: 'err', msgs: ['Ese archivo no es una foto. Elige una imagen.'] });
    }
    return analyzeImage(file).then(function (r) {
      if (r.decodeError) return { level: 'warn', msgs: ['No pudimos revisarla en este navegador (formato HEIC o similar). La recibimos y el ortesista la revisará.'] };
      var errs = [], warns = [];
      if (Math.min(r.w, r.h) < 600) errs.push('La resolución es muy baja (' + r.w + '×' + r.h + '). Tómala con la cámara de tu celular, no uses capturas de pantalla.');
      if (r.mean < 45) warns.push('Se ve oscura. Busca más luz, de preferencia natural.');
      if (r.mean > 238) warns.push('Se ve demasiado clara (sobreexpuesta). Evita el sol directo o el flash.');
      if (r.sharp < 30) warns.push('Parece borrosa o movida. Sostén el celular firme y toca la pantalla para enfocar.');
      var info = r.w + '×' + r.h + ' px';
      if (errs.length) return { level: 'err', msgs: errs.concat(warns), info: info };
      if (warns.length) return { level: 'warn', msgs: warns, info: info };
      return { level: 'ok', msgs: ['Buena luz, nitidez y resolución.'], info: info };
    });
  }
  function checkVideo(file, rule, known) {
    if (!/^video\//.test(file.type || '') && !/\.(mp4|mov|webm|m4v|3gp|avi|mkv)$/i.test(file.name || '')) {
      return Promise.resolve({ level: 'err', msgs: ['Ese archivo no es un video. Elige un video.'] });
    }
    var sizeMB = file.size / 1048576;
    if (ONLINE && sizeMB > MAX_MB) {
      return Promise.resolve({ level: 'err', msgs: ['Pesa ' + sizeMB.toFixed(0) + ' MB y el máximo es ' + MAX_MB + ' MB. Grábalo en calidad 1080p (no 4K) o más corto' + (rule.min === 10 ? ', o usa «Grabar con la cámara» aquí en la página.' : '.')] });
    }
    return analyzeVideo(file, known).then(function (r) {
      var errs = [], warns = [], d = r.duration;
      if (r.decodeError || r.timeout) {
        if (d && d < rule.min) errs.push('Dura ' + Math.round(d) + ' s y necesitamos al menos ' + rule.min + ' s.');
        if (errs.length) return { level: 'err', msgs: errs };
        return { level: 'warn', msgs: ['No pudimos reproducirlo en este navegador para revisarlo (algunos formatos de iPhone pasan esto). Lo recibimos y el ortesista lo revisará.'], info: mb(file.size) };
      }
      if (d && d < rule.min) errs.push('Dura ' + Math.round(d) + ' s y necesitamos al menos ' + rule.min + ' s' + (rule.min === 10 ? ' para dar la vuelta completa al pie.' : '.'));
      if (r.w && r.h && Math.min(r.w, r.h) < 360) errs.push('La resolución es muy baja (' + r.w + '×' + r.h + ').');
      if (d && d > rule.max) warns.push('Es largo (' + Math.round(d) + ' s). Sirve, pero tardará más en enviarse.');
      if (r.mean != null && r.mean < 40) warns.push('Se ve oscuro. Graba con más luz.');
      var info = (d ? Math.round(d) + ' s · ' : '') + (r.w ? r.w + '×' + r.h + ' · ' : '') + mb(file.size);
      if (errs.length) return { level: 'err', msgs: errs.concat(warns), info: info };
      if (warns.length) return { level: 'warn', msgs: warns, info: info };
      return { level: 'ok', msgs: ['Duración, luz y resolución correctas.'], info: info };
    });
  }

  function handleFile(key, file, opts) {
    opts = opts || {};
    var rule = RULES[key]; if (!rule || !file) return;
    S.files[key] = { level: 'busy', name: file.name };
    paintCard(key);
    var check = rule.type === 'image' ? checkImage(file) : checkVideo(file, rule, opts.duration);
    return check.then(function (res) {
      var meta = { name: file.name || key, type: file.type, size: file.size, level: res.level, msgs: res.msgs, info: res.info || '', recorded: !!opts.recorded };
      S.files[key] = meta;
      if (res.level === 'err') {
        delete FILES[key];
        idb.del(key).catch(function () {});
      } else {
        FILES[key] = file;
        delete S.uploaded[key];
        idb.put(key, file).catch(function () {
          meta.notSaved = true; paintCard(key);
        });
      }
      paintCard(key);
      hideAlert();
      save();
    });
  }

  function paintCard(key) {
    var card = cardFor(key); if (!card) return;
    var meta = S.files[key], blob = FILES[key];
    var qs = card.querySelector('.qstatus'), prev = card.querySelector('.uprev'), fn = card.querySelector('.fname');
    var recBtn = card.querySelector('[data-scan]');
    card.classList.remove('done', 'warn', 'error');
    if (urls[key]) { URL.revokeObjectURL(urls[key]); delete urls[key]; }
    prev.classList.remove('show'); prev.removeAttribute('src');
    if (fn) fn.textContent = '';
    if (!meta) { qs.className = 'qstatus'; qs.innerHTML = ''; if (recBtn) recBtn.textContent = 'Grabar con la cámara'; return; }
    if (meta.level === 'busy') { qs.className = 'qstatus show busy'; qs.textContent = 'Revisando ' + (RULES[key].type === 'image' ? 'tu foto' : 'tu video') + '…'; return; }
    card.classList.add(meta.level === 'ok' ? 'done' : meta.level === 'warn' ? 'warn' : 'error');
    var head = meta.level === 'ok' ? '✓ Captura válida' : meta.level === 'warn' ? 'Recibida, con observaciones. Te recomendamos repetirla:' : 'No la podemos usar. Repítela:';
    var html = '<span>' + head + (meta.info && meta.level === 'ok' ? ' · ' + esc(meta.info) : '') + '</span>';
    if (meta.level !== 'ok' && meta.msgs && meta.msgs.length) html += '<ul>' + meta.msgs.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
    if (meta.notSaved) html += '<ul><li>No se pudo guardar en este celular para retomarlo después: termina tu pedido en esta visita.</li></ul>';
    qs.className = 'qstatus show ' + meta.level; qs.innerHTML = html;
    if (blob && meta.level !== 'err') {
      urls[key] = URL.createObjectURL(blob);
      prev.src = urls[key]; prev.classList.add('show');
      if (fn) fn.textContent = (meta.recorded ? 'Grabado aquí' : meta.name) + ' · ' + mb(meta.size);
    }
    if (recBtn) recBtn.textContent = accepted(key) ? 'Volver a grabar' : 'Grabar con la cámara';
  }

  flow.addEventListener('change', function (e) {
    var inp = e.target;
    if (!inp.matches('input[type=file][data-file]')) return;
    var f = inp.files && inp.files[0];
    if (f) handleFile(inp.getAttribute('data-file'), f);
    inp.value = '';
  });

  /* ---------- Grabación del escaneo con la cámara ---------- */
  var REC = null;
  var REC_MIN = 10, REC_MAX = 40, REC_TARGET = 25;
  var REC_GUIDE = [
    [0, 'Empieza de frente a los dedos, con toda la hoja A4 a la vista.'],
    [4, 'Avanza despacio hacia el lado interno del pie (el arco).'],
    [9, 'Sigue hasta el talón, por detrás.'],
    [14, 'Continúa por el lado externo del pie.'],
    [19, 'Cierra la vuelta otra vez en los dedos.'],
    [24, '¡Listo! Ya puedes terminar la grabación.']
  ];
  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  function showCardMsg(card, level, text) {
    var qs = card.querySelector('.qstatus');
    qs.className = 'qstatus show ' + level; qs.textContent = text;
  }
  function stopRecording(cancel) {
    if (!REC) return;
    var r = REC; REC = null;
    clearInterval(r.iv);
    r.cancel = !!cancel;
    try { r.mr.state !== 'inactive' ? r.mr.stop() : r.cleanup(); } catch (e) { r.cleanup(); }
  }
  function startRecording(side) {
    var card = $('scanCard-' + side), key = 'scan-' + side;
    if (REC) stopRecording(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      showCardMsg(card, 'warn', 'Tu navegador no permite grabar aquí. Graba el video con la cámara de tu celular y súbelo con «sube un video que ya grabaste».');
      return;
    }
    var rec = card.querySelector('.rec'), live = card.querySelector('.rec-live'), guide = card.querySelector('.rec-guide'),
      bar = card.querySelector('.rec-bar i'), time = card.querySelector('.rec-time'), stopBtn = card.querySelector('.rec-stop'),
      startBtn = card.querySelector('[data-scan]'), alt = card.querySelector('.link-alt');
    startBtn.disabled = true; startBtn.textContent = 'Abriendo cámara…';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (stream) {
        startBtn.disabled = false; startBtn.hidden = true; alt.hidden = true;
        card.querySelector('.uprev').classList.remove('show');
        live.srcObject = stream; live.play().catch(function () {});
        rec.classList.add('run');
        var mime = pickMime(), opts = { videoBitsPerSecond: 2500000 };
        if (mime) opts.mimeType = mime;
        var mr; try { mr = new MediaRecorder(stream, opts); } catch (e) { mr = new MediaRecorder(stream); }
        var chunks = [], t0 = Date.now();
        var r = { mr: mr, iv: null, cancel: false };
        r.cleanup = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          live.srcObject = null; rec.classList.remove('run');
          startBtn.hidden = false; alt.hidden = false;
          bar.style.width = '0';
        };
        mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
        mr.onstop = function () {
          r.cleanup();
          if (r.cancel) { paintCard(key); return; }
          var type = (mr.mimeType || mime || 'video/webm').split(';')[0];
          var blob = new Blob(chunks, { type: type });
          var file = new File([blob], 'escaneo-pie-' + side + (type.indexOf('mp4') >= 0 ? '.mp4' : '.webm'), { type: type });
          handleFile(key, file, { duration: (Date.now() - t0) / 1000, recorded: true });
        };
        mr.start(500);
        REC = r;
        stopBtn.onclick = function () { stopRecording(false); };
        r.iv = setInterval(function () {
          var s = (Date.now() - t0) / 1000;
          bar.style.width = Math.min(100, s / REC_TARGET * 100) + '%';
          time.innerHTML = '<span class="rec-dot"></span>Grabando · ' + Math.floor(s) + ' s';
          var g = REC_GUIDE[0][1];
          REC_GUIDE.forEach(function (x) { if (s >= x[0]) g = x[1]; });
          if (guide.textContent !== g) guide.textContent = g;
          stopBtn.disabled = s < REC_MIN;
          stopBtn.textContent = s < REC_MIN ? 'Terminar (mínimo ' + REC_MIN + ' s)' : 'Terminar grabación';
          if (s >= REC_MAX) stopRecording(false);
        }, 250);
      })
      .catch(function (err) {
        startBtn.disabled = false; startBtn.textContent = 'Grabar con la cámara';
        var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        showCardMsg(card, 'err', denied
          ? 'No tenemos permiso para usar la cámara. Actívalo en la configuración del navegador, o graba con la cámara de tu celular y súbelo con «sube un video que ya grabaste».'
          : 'No pudimos abrir la cámara. Graba con la cámara de tu celular y súbelo con «sube un video que ya grabaste».');
      });
  }
  qsa('[data-scan]', flow).forEach(function (b) {
    b.addEventListener('click', function () { startRecording(b.getAttribute('data-scan')); });
  });

  /* ---------- Talla sugerida ---------- */
  function suggestTalla() {
    var len = parseFloat(val('f-largo')), box = $('tallaSuggest'), span = box.querySelector('span'), btn = $('useSuggest');
    if (!(len >= 12 && len <= 35)) { box.classList.remove('show'); return; }
    var opts = qsa('#f-talla option', flow).map(function (o) { return o.value; }).filter(function (v) { return v && v !== 'Otra'; });
    var target = Math.round(len * 2) / 2;
    box.classList.add('show');
    if (target < 21) { span.textContent = 'Para tallas menores a 21, elige «Otra talla» y te contactamos.'; btn.hidden = true; box.dataset.talla = 'Otra'; return; }
    var best = opts.reduce(function (a, b) { return Math.abs(b - target) < Math.abs(a - target) ? b : a; });
    span.textContent = 'Talla sugerida: ' + best + ' MX';
    btn.hidden = false; box.dataset.talla = best;
  }
  $('f-largo').addEventListener('input', suggestTalla);
  $('useSuggest').addEventListener('click', function () { $('f-talla').value = $('tallaSuggest').dataset.talla; save(); });

  /* ---------- Mapa de dolor ---------- */
  function syncZoneUI(key) {
    var on = !!S.pain[key];
    qsa('[data-zone="' + key + '"]', flow).forEach(function (el) {
      el.classList.toggle('sel', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function toggleZone(key) {
    if (S.pain[key]) delete S.pain[key];
    else {
      S.sinDolor = false; $('painNone').setAttribute('aria-pressed', 'false');
      S.pain[key] = { desde: 'Menos de 1 mes', nivel: 5, cuando: [] };
    }
    syncZoneUI(key); renderPainDetails(); hideAlert(); save();
  }
  qsa('.zone', flow).forEach(function (z) {
    z.addEventListener('click', function () { toggleZone(z.getAttribute('data-zone')); });
    z.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleZone(z.getAttribute('data-zone')); }
    });
  });
  qsa('#painChips .chip[data-zone]', flow).forEach(function (ch) {
    ch.addEventListener('click', function () { toggleZone(ch.getAttribute('data-zone')); });
  });
  $('painNone').addEventListener('click', function () {
    S.sinDolor = !S.sinDolor;
    this.setAttribute('aria-pressed', S.sinDolor ? 'true' : 'false');
    if (S.sinDolor) { Object.keys(S.pain).forEach(function (k) { delete S.pain[k]; syncZoneUI(k); }); renderPainDetails(); }
    hideAlert(); save();
  });
  function renderPainDetails() {
    var box = $('painDetails'), keys = Object.keys(S.pain);
    if (!keys.length) { box.innerHTML = ''; return; }
    box.innerHTML = keys.map(function (k) {
      var d = S.pain[k];
      var chips = CUANDO.map(function (c) {
        return '<button type="button" class="chip" aria-pressed="' + (d.cuando.indexOf(c) >= 0) + '" data-cuando="' + esc(c) + '" data-zkey="' + k + '">' + esc(c) + '</button>';
      }).join('');
      return '<div class="pain-detail">' +
        '<h4>' + ZONES[k] + '</h4>' +
        '<div class="fgrid two">' +
          '<div class="field"><label for="pd-desde-' + k + '">¿Desde cuándo te duele?</label>' +
            '<select id="pd-desde-' + k + '" data-pfield="desde" data-zkey="' + k + '">' +
              ['Menos de 1 mes', 'De 1 a 6 meses', 'De 6 meses a 1 año', 'Más de 1 año'].map(function (o) {
                return '<option' + (d.desde === o ? ' selected' : '') + '>' + o + '</option>';
              }).join('') +
            '</select></div>' +
          '<div class="field"><label for="pd-nivel-' + k + '">¿Cuánto duele? <span class="range-val" data-rval="' + k + '">' + d.nivel + '</span> / 10</label>' +
            '<input id="pd-nivel-' + k + '" type="range" min="1" max="10" step="1" value="' + d.nivel + '" data-pfield="nivel" data-zkey="' + k + '" /></div>' +
        '</div>' +
        '<div class="field" style="margin-top:12px"><span class="label">¿Cuándo duele más?</span><div class="mini-chips">' + chips + '</div></div>' +
      '</div>';
    }).join('');
  }
  $('painDetails').addEventListener('input', function (e) {
    var el = e.target, k = el.getAttribute('data-zkey'), f = el.getAttribute('data-pfield');
    if (!k || !f || !S.pain[k]) return;
    S.pain[k][f] = f === 'nivel' ? +el.value : el.value;
    if (f === 'nivel') $('painDetails').querySelector('[data-rval="' + k + '"]').textContent = el.value;
  });
  $('painDetails').addEventListener('change', function (e) {
    var el = e.target, k = el.getAttribute('data-zkey'), f = el.getAttribute('data-pfield');
    if (k && f && S.pain[k]) S.pain[k][f] = f === 'nivel' ? +el.value : el.value;
  });
  $('painDetails').addEventListener('click', function (e) {
    var ch = e.target.closest('[data-cuando]'); if (!ch) return;
    var k = ch.getAttribute('data-zkey'), c = ch.getAttribute('data-cuando');
    var arr = S.pain[k].cuando, i = arr.indexOf(c);
    if (i >= 0) arr.splice(i, 1); else arr.push(c);
    ch.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
    save();
  });

  /* ---------- Salud: «Ninguna» es excluyente ---------- */
  qsa('input[name="salud"]', flow).forEach(function (c) {
    c.addEventListener('change', function () {
      if (!c.checked) return;
      if (c.id === 'saludNinguna') qsa('input[name="salud"]', flow).forEach(function (o) { if (o !== c) o.checked = false; });
      else $('saludNinguna').checked = false;
    });
  });

  /* ---------- Uso ---------- */
  function syncUso() {
    var u = checkedVal('uso');
    $('usoDeporte').classList.toggle('show', u === 'Deporte');
    $('usoTrabajo').classList.toggle('show', u === 'Trabajo');
  }
  qsa('input[name="uso"]', flow).forEach(function (r) { r.addEventListener('change', syncUso); });

  /* ---------- Códigos de promoción ---------- */
  function sbHeaders(extra) {
    var h = { apikey: C.supabaseAnonKey };
    if (/^eyJ/.test(C.supabaseAnonKey)) h.Authorization = 'Bearer ' + C.supabaseAnonKey;
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }
  function rpc(fn, body) {
    return fetch(SB_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) throw new Error('Servidor ' + r.status + ': ' + t.slice(0, 200));
        return t ? JSON.parse(t) : null;
      });
    });
  }
  function paintCupon() {
    var msg = $('cuponMsg'), c = S.cupon;
    msg.className = 'cupon-msg';
    if (!c) { msg.textContent = ''; }
    else if (c.valid === true) { msg.classList.add('ok'); msg.textContent = 'Código válido: tu pedido sale gratis. Se aplica al confirmar.'; }
    else if (c.valid === false) { msg.classList.add('err'); msg.textContent = 'Ese código no es válido o ya se usó. Revísalo e inténtalo de nuevo.'; }
    else { msg.classList.add('ok'); msg.textContent = 'Anotamos tu código ' + c.code + '. Lo validamos al confirmar tu pedido por WhatsApp.'; }
    paintTotals();
  }
  function paintTotals() {
    var p = PRODUCTS[S.product], free = S.cupon && S.cupon.valid === true;
    $('totProd').textContent = p.name;
    $('totPrecio').textContent = money(p.price);
    $('totDescRow').hidden = !free;
    $('totDesc').textContent = '−' + money(p.price);
    $('totTotal').textContent = free ? '$0 MXN' : money(p.price) + ' MXN';
    $('pagoHint').textContent = free
      ? 'Tu código cubre todo el pedido: no tienes que pagar nada.'
      : (S.cupon && S.cupon.valid == null ? 'Si tu código es válido, tu pedido sale gratis. ' : '') + 'Al confirmar tu pedido te escribimos por WhatsApp para completar tu pago.';
  }
  $('btnCupon').addEventListener('click', function () {
    var code = val('f-cupon').toUpperCase().replace(/\s+/g, '');
    var btn = this;
    if (!code) { S.cupon = null; paintCupon(); return; }
    if (!ONLINE) { S.cupon = { code: code, valid: null }; paintCupon(); save(); return; }
    btn.disabled = true; btn.textContent = 'Revisando…';
    rpc('validar_cupon', { p_codigo: code }).then(function (ok) {
      S.cupon = { code: code, valid: ok === true };
      paintCupon(); save();
    }).catch(function () {
      var msg = $('cuponMsg'); msg.className = 'cupon-msg err';
      msg.textContent = 'No pudimos revisar el código en este momento. Revisa tu conexión e inténtalo de nuevo.';
    }).then(function () { btn.disabled = false; btn.textContent = 'Aplicar'; });
  });

  /* ---------- Resumen ---------- */
  var ICON_OK = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
  var ICON_MISS = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>';
  function li(ok, html, step) {
    return '<li class="' + (ok ? '' : 'miss') + '">' + (ok ? ICON_OK : ICON_MISS) + '<span>' + html + '</span>' +
      (step ? '<button type="button" class="edit" data-goto="' + step + '">Editar</button>' : '') + '</li>';
  }
  function gatherHealth() { return qsa('input[name="salud"]:checked', flow).map(function (c) { return c.value; }); }
  function countAccepted(keys) { return keys.filter(accepted).length; }
  function buildSummary() {
    var it = [], p = PRODUCTS[S.product];
    it.push(li(true, '<strong>' + esc(p.name) + '</strong> · ' + esc(priceText(S.product))));
    if (esCalzado(S.product)) { var col = checkedVal('upper-color'); it.push(li(!!col, 'Color: ' + esc(col || 'sin elegir (elígelo arriba)'))); }
    it.push(li(validate(1).length === 0, 'Datos: ' + esc(val('f-nombre') || '—') + (val('f-edad') ? ', ' + esc(val('f-edad')) + ' años' : '') + (val('f-peso') ? ' · ' + esc(val('f-peso')) + ' kg' : '') + (val('f-estatura') ? ' · ' + esc(val('f-estatura')) + ' cm' : ''), 1));
    it.push(li(validate(2).length === 0, 'Escaneo: ' + countAccepted(['scan-derecho', 'scan-izquierdo']) + ' de 2 videos · Talla ' + esc(val('f-talla') || '—') + ' · Arco: ' + esc(checkedVal('arco') || '—'), 2));
    it.push(li(validate(3).length === 0, 'Fotos: ' + countAccepted(PHOTOS.map(function (x) { return x.key; })) + ' de 7', 3));
    it.push(li(validate(4).length === 0, 'Videos de marcha y movimiento: ' + countAccepted(['marcha', 'sentadilla']) + ' de 2', 4));
    var pz = Object.keys(S.pain).map(function (k) { return ZONES[k] + ' (' + S.pain[k].nivel + '/10)'; }).join(', ');
    it.push(li(validate(5).length === 0, 'Mapa de dolor: ' + esc(S.sinDolor ? 'sin dolor' : (pz || 'sin zonas marcadas')), 5));
    var salud = gatherHealth();
    it.push(li(validate(6).length === 0, 'Salud: ' + esc(salud.length ? salud.join(', ') : 'sin responder'), 6));
    var uso = checkedVal('uso');
    it.push(li(validate(7).length === 0, 'Uso: ' + esc(uso || '—') + (!esCalzado(S.product) && val('f-calzado-tipo') ? ' · Calzado ' + esc(val('f-calzado-tipo').toLowerCase()) : '') + (checkedVal('ancho') ? ' · Ancho ' + esc(checkedVal('ancho').toLowerCase()) : ''), 7));
    $('resumenExpediente').innerHTML = it.join('');
    paintTotals();
    $('btnEnviarText').textContent = ONLINE ? 'Enviar mi expediente y confirmar pedido' : 'Continuar para enviar por WhatsApp';
    $('submitNote').textContent = ONLINE
      ? 'Subimos tu expediente completo (videos, fotos y respuestas) a nuestro sistema privado. No cierres esta página mientras se envía.'
      : 'En el siguiente paso abrimos WhatsApp con tu resumen ya escrito; ahí nos adjuntas tus videos y fotos.';
  }
  $('resumenExpediente').addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto]'); if (b) goTo(+b.getAttribute('data-goto'));
  });

  /* ---------- Datos del pedido ---------- */
  function buildDatos() {
    var uso = checkedVal('uso');
    return {
      producto: S.product, producto_nombre: PRODUCTS[S.product].name, precio_lista: PRODUCTS[S.product].price,
      color: esCalzado(S.product) ? checkedVal('upper-color') : null,
      nombre: val('f-nombre'), edad: +val('f-edad'), sexo: val('f-sexo'), peso_kg: +val('f-peso'), estatura_cm: +val('f-estatura'),
      correo: val('f-correo'), whatsapp: phone10(),
      medidas: { largo_pie_cm: val('f-largo') ? +val('f-largo') : null, talla_mx: val('f-talla'), arco: checkedVal('arco') },
      dolor: S.sinDolor ? 'sin dolor' : Object.keys(S.pain).map(function (k) {
        var d = S.pain[k]; return { zona: ZONES[k], desde: d.desde, intensidad: d.nivel, cuando: d.cuando };
      }),
      salud: gatherHealth(), salud_nota: val('f-salud-otro'),
      actividad: {
        uso: uso, deporte: uso === 'Deporte' ? val('f-deporte') : null, frecuencia: uso === 'Deporte' ? val('f-deporte-frec') : null,
        horas_de_pie: uso === 'Trabajo' ? val('f-horas-pie') : null,
        calzado: esCalzado(S.product) ? null : val('f-calzado-tipo'), ancho: checkedVal('ancho'), marca_modelo: val('f-marca-modelo')
      },
      objetivo: val('f-objetivo'),
      entrega: { calle: val('f-dir-calle'), colonia: val('f-dir-colonia'), cp: val('f-dir-cp'), ciudad: val('f-dir-ciudad'), estado: val('f-dir-estado'), referencias: val('f-dir-ref') },
      cupon: S.cupon ? S.cupon.code : null,
      revision_capturas: FILE_ORDER.reduce(function (o, k) {
        var m = S.files[k]; if (m) o[k] = { nivel: m.level, detalle: m.info, observaciones: m.level === 'ok' ? [] : m.msgs }; return o;
      }, {}),
      consentimiento: { aceptado: true, fecha: new Date().toISOString() },
      navegador: navigator.userAgent
    };
  }
  function buildText() {
    var d = buildDatos(), L = [];
    L.push('EXPEDIENTE ORTOSTEP');
    L.push('Producto: ' + d.producto_nombre + ' (' + money(d.precio_lista) + ' MXN)' + (d.color ? ' · Color: ' + d.color : ''));
    if (d.cupon) L.push('Código de promoción: ' + d.cupon);
    L.push('');
    L.push('DATOS');
    L.push(d.nombre + ' · ' + d.edad + ' años · ' + d.sexo);
    L.push('Peso ' + d.peso_kg + ' kg · Estatura ' + d.estatura_cm + ' cm');
    L.push('Correo: ' + d.correo + ' · WhatsApp: ' + d.whatsapp);
    L.push('');
    L.push('MEDIDAS');
    L.push('Talla MX: ' + d.medidas.talla_mx + (d.medidas.largo_pie_cm ? ' · Largo del pie: ' + d.medidas.largo_pie_cm + ' cm' : '') + ' · Arco: ' + d.medidas.arco);
    L.push('');
    L.push('MAPA DE DOLOR');
    if (d.dolor === 'sin dolor') L.push('Sin dolor.');
    else d.dolor.forEach(function (z) { L.push('- ' + z.zona + ': ' + z.intensidad + '/10, ' + z.desde.toLowerCase() + (z.cuando.length ? ', peor ' + z.cuando.join(', ').toLowerCase() : '')); });
    L.push('');
    L.push('SALUD');
    L.push(d.salud.join(', '));
    if (d.salud_nota) L.push('Nota: ' + d.salud_nota);
    L.push('');
    L.push('ACTIVIDAD Y CALZADO');
    var a = d.actividad;
    L.push('Uso: ' + a.uso + (a.deporte ? ' · ' + a.deporte + (a.frecuencia ? ', ' + a.frecuencia : '') : '') + (a.horas_de_pie ? ' · ' + a.horas_de_pie + ' de pie' : ''));
    L.push((a.calzado ? 'Calzado: ' + a.calzado + ' · ' : '') + 'Ancho: ' + a.ancho + (a.marca_modelo ? ' · Usa: ' + a.marca_modelo : ''));
    L.push('');
    L.push('OBJETIVO');
    L.push(d.objetivo);
    L.push('');
    L.push('ENTREGA');
    var e = d.entrega;
    L.push(e.calle + ', col. ' + e.colonia + ', CP ' + e.cp + ', ' + e.ciudad + ', ' + e.estado + (e.referencias ? '. Ref: ' + e.referencias : ''));
    L.push('');
    L.push('ARCHIVOS (los adjunto en este chat)');
    FILE_ORDER.forEach(function (k) { if (accepted(k)) L.push('- ' + RULES[k].label + (S.files[k].level === 'warn' ? ' (con observaciones)' : '')); });
    L.push('');
    L.push('Acepté el aviso de privacidad y los términos.');
    return L.join('\n');
  }

  /* ---------- Envío ---------- */
  function extFor(file, key) {
    var m = /\.([a-z0-9]{2,5})$/i.exec(file.name || '');
    if (m) return m[1].toLowerCase();
    var t = file.type || '';
    if (t.indexOf('mp4') >= 0) return 'mp4';
    if (t.indexOf('webm') >= 0) return 'webm';
    if (t.indexOf('quicktime') >= 0) return 'mov';
    if (t.indexOf('png') >= 0) return 'png';
    if (t.indexOf('heic') >= 0) return 'heic';
    return RULES[key].type === 'image' ? 'jpg' : 'mp4';
  }
  function uploadOnce(path, file, onProgress, ctype) {
    return new Promise(function (res, rej) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', SB_URL + '/storage/v1/object/' + BUCKET + '/' + path);
      var h = sbHeaders({ 'x-upsert': 'false', 'Content-Type': ctype, 'cache-control': '3600' });
      Object.keys(h).forEach(function (k) { xhr.setRequestHeader(k, h[k]); });
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) return res();
        if (/Duplicate|already exists/i.test(xhr.responseText)) return res(); // ya se había subido
        rej(new Error('Error ' + xhr.status + ' al subir'));
      };
      xhr.onerror = function () { rej(new Error('Sin conexión')); };
      xhr.ontimeout = function () { rej(new Error('Tiempo de espera agotado')); };
      xhr.send(file);
    });
  }
  function uploadRetry(path, file, onProgress, tries, ctype) {
    return uploadOnce(path, file, onProgress, ctype).catch(function (err) {
      if (tries <= 1) throw err;
      return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return uploadRetry(path, file, onProgress, tries - 1, ctype); });
    });
  }
  function showPanel(id) {
    flowMain.style.display = id ? 'none' : '';
    ['flowSend', 'flowDone', 'flowManual'].forEach(function (p) { $(p).classList.toggle('show', p === id); });
    flow.scrollTo({ top: 0 });
    var h = id && $(id).querySelector('h2');
    if (h) setTimeout(function () { h.focus({ preventScroll: true }); }, 30);
  }

  function submitOnline() {
    if (!S.orderId) S.orderId = uuid();
    save();
    S.sending = true;
    showPanel('flowSend');
    $('sendRetry').hidden = true;
    $('sendTitle').textContent = 'Enviando tu expediente…';
    var keys = FILE_ORDER.filter(accepted);
    var total = keys.reduce(function (s, k) { return s + FILES[k].size; }, 0) || 1, doneBytes = 0;
    function paint(extra, label) {
      var pct = Math.min(99, Math.round((doneBytes + extra) / total * 100));
      $('sendBar').style.width = pct + '%';
      $('sendStatus').textContent = label + ' · ' + pct + '%';
    }
    var chain = Promise.resolve();
    keys.forEach(function (k, i) {
      chain = chain.then(function () {
        var file = FILES[k];
        if (S.uploaded[k]) { doneBytes += file.size; return; }
        var path = S.orderId + '/' + k + '.' + extFor(file, k);
        var label = 'Subiendo ' + (i + 1) + ' de ' + keys.length + ': ' + RULES[k].label.toLowerCase();
        paint(0, label);
        var ctype = file.type || (RULES[k].type === 'image' ? 'image/jpeg' : 'video/mp4');
        return uploadRetry(path, file, function (l) { paint(l, label); }, 3, ctype).then(function () {
          doneBytes += file.size; S.uploaded[k] = path; save();
        });
      });
    });
    chain.then(function () {
      $('sendStatus').textContent = 'Registrando tu pedido…';
      return rpc('crear_pedido', {
        p_id: S.orderId, p_producto: S.product, p_datos: buildDatos(),
        p_archivos: S.uploaded, p_cupon: S.cupon && S.cupon.valid ? S.cupon.code : null
      });
    }).then(function (r) {
      S.sending = false;
      $('sendBar').style.width = '100%';
      var gratis = r && r.gratis;
      $('doneFolio').textContent = (r && r.folio) || S.orderId.slice(0, 8).toUpperCase();
      $('doneProducto').textContent = PRODUCTS[S.product].name + (esCalzado(S.product) ? ' · ' + checkedVal('upper-color') : '');
      $('doneTotal').textContent = gratis ? '$0 MXN (código ' + S.cupon.code + ')' : money(r && r.total != null ? r.total : PRODUCTS[S.product].price) + ' MXN';
      $('doneLead').textContent = gratis
        ? 'Tu pedido quedó registrado y tu código cubre el total. Te escribiremos por WhatsApp cuando el ortesista revise tu expediente.'
        : 'Tu pedido quedó registrado. Te escribiremos por WhatsApp para confirmar los detalles y el pago.';
      if (S.cupon && S.cupon.valid && !gratis) $('doneLead').textContent += ' Tu código ya no estaba disponible, así que se registró con el precio normal; si crees que es un error, escríbenos.';
      var wa = $('doneWa');
      if (WA) wa.href = waLink('Hola, acabo de enviar mi expediente ORTOSTEP. Folio ' + $('doneFolio').textContent + ', a nombre de ' + val('f-nombre') + '.');
      else wa.style.display = 'none';
      showPanel('flowDone');
      clearSaved();
      S.done = true;
    }).catch(function (err) {
      S.sending = false;
      $('sendTitle').textContent = 'No se pudo completar el envío';
      $('sendStatus').textContent = 'Lo que ya se subió queda guardado; al reintentar seguimos desde ahí. (' + err.message + ')';
      $('sendRetry').hidden = false;
    });
  }
  $('btnRetry').addEventListener('click', submitOnline);
  $('btnSendBack').addEventListener('click', function () { showPanel(null); goTo(8); });

  function submitManual() {
    var text = buildText();
    var wa = $('manualWa');
    if (WA) wa.href = waLink(text); else wa.style.display = 'none';
    var subject = 'Expediente ORTOSTEP — ' + val('f-nombre') + ' — ' + PRODUCTS[S.product].name;
    var body = text.length > 6000 ? text.slice(0, 6000) + '\n…' : text;
    $('manualMail').href = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body + '\n\n(Adjunto mis 4 videos y 7 fotos.)');
    var share = $('scanShare'); share.innerHTML = '';
    ['derecho', 'izquierdo'].forEach(function (side) {
      var k = 'scan-' + side, m = S.files[k];
      if (!accepted(k) || !m.recorded) return;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-outline';
      b.textContent = 'Guardar el video de mi pie ' + side;
      b.addEventListener('click', function () {
        var f = FILES[k] instanceof File ? FILES[k] : new File([FILES[k]], 'escaneo-pie-' + side + '.' + extFor(FILES[k], k), { type: FILES[k].type });
        if (navigator.canShare && navigator.canShare({ files: [f] })) {
          navigator.share({ files: [f], title: 'Escaneo ORTOSTEP', text: 'Video de mi pie ' + side }).catch(function () {});
        } else {
          var a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
          document.body.appendChild(a); a.click(); a.remove();
        }
      });
      share.appendChild(b);
    });
    $('btnCopy').onclick = function () {
      var btn = this;
      function ok() { btn.textContent = '¡Resumen copiado!'; setTimeout(function () { btn.textContent = 'Copiar resumen'; }, 2500); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
      function fallback() {
        var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) {} ta.remove();
      }
    };
    showPanel('flowManual');
  }

  $('btnEnviar').addEventListener('click', function () {
    var errs = validateFinal();
    if (errs.length) { showAlert(errs); return; }
    hideAlert();
    if (ONLINE) submitOnline(); else submitManual();
  });
  $('btnDoneClose').addEventListener('click', function () {
    closeFlow();
    // Pedido enviado: se reinicia la página para un expediente nuevo.
    setTimeout(function () { location.reload(); }, 50);
  });
  $('btnManualClose').addEventListener('click', function () { showPanel(null); closeFlow(); });

  /* ---------- Inicio ---------- */
  setProduct('clasica');
  restore().then(function (had) {
    setProduct(S.product);
    if (had) paintTotals();
    if (/^#(empezar-escaneo|pedido)$/.test(location.hash)) openFlow(S.product);
  });
})();
