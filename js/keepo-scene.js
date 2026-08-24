/* ══════════════════════════════════════════════════════════════════
   KEEPO — Décor du site public (fond topographique + animations)

   Chargé par index.html et upgrade.html pour que les deux pages aient
   exactement le même relief et les mêmes entrées de section. Le fond est
   calculé (bruit de valeur + marching squares), pas une image : chaque
   chargement produit un relief propre, net à tout zoom.

   Les pages gardent leurs animations qui leur sont propres (compteurs,
   inclinaison du téléphone sur l'accueil). Ici, seulement le commun.

   Réglage facultatif, à définir AVANT le chargement du script :
     window.KEEPO_SCENE = { stagger: 'sélecteur, des, enfants, à, égrener' }
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var CFG    = window.KEEPO_SCENE || {};
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ─────────────── 1. FOND TOPOGRAPHIQUE ─────────────── */
  var cv = document.createElement('canvas');
  cv.id = 'topo';
  document.body.insertBefore(cv, document.body.firstChild);
  var ctx = cv.getContext('2d');

  // Bruit de valeur (grille aléatoire + interpolation douce), 3 octaves.
  function makeNoise(seed) {
    var g = [], S = 256;
    var s = seed || 1;
    function rnd() { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }
    for (var i = 0; i < S * S; i++) g[i] = rnd();
    function at(x, y) { return g[((y & (S - 1)) * S + (x & (S - 1)))]; }
    function smooth(t) { return t * t * (3 - 2 * t); }
    function oct(x, y) {
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var fx = smooth(x - x0), fy = smooth(y - y0);
      var a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    return function (x, y) {
      return oct(x, y) * 0.55 + oct(x * 2.1, y * 2.1) * 0.30 + oct(x * 4.3, y * 4.3) * 0.15;
    };
  }

  var noise = makeNoise(20260822);
  var W = 0, H = 0, phase = 0, mobile = false;

  function draw() {
    var w = document.documentElement.clientWidth || window.innerWidth || 0;
    var h = document.documentElement.clientHeight || window.innerHeight || 0;
    // La fenêtre peut ne pas être encore dimensionnée : on réessaie plutôt que
    // de dessiner dans le vide (sinon le fond resterait vide pour toujours).
    if (w < 2 || h < 2) { requestAnimationFrame(draw); return; }
    mobile = w < 760;
    if (w !== W || h !== H) {
      W = w; H = h;
      // Le relief est un décor : on le rend à résolution réduite (moitié sur
      // mobile) et on l'étire — invisible à l'œil, 4× moins de calcul.
      var q = mobile ? 0.5 : 0.7;
      cv.width = Math.round(w * q); cv.height = Math.round(h * q);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    var sw = cv.width, sh = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, sw, sh);

    var step = mobile ? 11 : 12;         // finesse de la grille d'échantillonnage
    var cols = Math.ceil(sw / step) + 1, rows = Math.ceil(sh / step) + 1;
    var scale = 0.026;                   // taille des reliefs

    // Champ de hauteurs — `phase` fait lentement onduler le relief
    var f = new Float32Array(cols * rows);
    for (var y = 0; y < rows; y++)
      for (var x = 0; x < cols; x++)
        f[y * cols + x] = noise(x * step * scale + phase, y * step * scale + phase * 0.35);

    // Marching squares : une polyligne par niveau
    var levels = mobile ? 10 : 13;
    for (var L = 1; L < levels; L++) {
      var t = L / levels;
      // les courbes maîtresses sont plus marquées (comme sur une carte)
      var strong = (L % 4 === 0);
      ctx.beginPath();
      ctx.lineWidth = strong ? 1.5 : 1;
      ctx.strokeStyle = strong ? 'rgba(75,69,166,.30)' : 'rgba(13,13,17,.155)';

      for (var yy = 0; yy < rows - 1; yy++) {
        for (var xx = 0; xx < cols - 1; xx++) {
          var a = f[yy * cols + xx], b = f[yy * cols + xx + 1];
          var c = f[(yy + 1) * cols + xx + 1], d = f[(yy + 1) * cols + xx];
          var idx = (a > t ? 8 : 0) | (b > t ? 4 : 0) | (c > t ? 2 : 0) | (d > t ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          var px = xx * step, py = yy * step;
          // points interpolés sur les 4 arêtes
          var top    = [px + step * ((t - a) / (b - a)), py];
          var right  = [px + step, py + step * ((t - b) / (c - b))];
          var bottom = [px + step * ((t - d) / (c - d)), py + step];
          var left   = [px, py + step * ((t - a) / (d - a))];
          var seg = null;
          switch (idx) {
            case 1: case 14: seg = [left, bottom]; break;
            case 2: case 13: seg = [bottom, right]; break;
            case 3: case 12: seg = [left, right]; break;
            case 4: case 11: seg = [top, right]; break;
            case 5:          seg = [left, top]; break;
            case 6: case 9:  seg = [top, bottom]; break;
            case 7: case 8:  seg = [left, top]; break;
            case 10:         seg = [top, right]; break;
          }
          if (seg) { ctx.moveTo(seg[0][0], seg[0][1]); ctx.lineTo(seg[1][0], seg[1][1]); }
        }
      }
      ctx.stroke();
    }
  }

  draw();
  window.addEventListener('load', draw);   // filet : dimensions sûres après chargement complet
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { W = 0; draw(); }, 220);
  });

  if (reduce) return;   // le fond reste figé, le mouvement s'arrête ici

  // Ondulation lente du relief. Cadence volontairement basse (≈14 im/s) : à cette
  // vitesse le mouvement reste fluide à l'œil pour une fraction du coût, et on
  // met tout en pause dès que l'onglet passe en arrière-plan.
  var last = 0, awake = true;
  document.addEventListener('visibilitychange', function () { awake = !document.hidden; });
  (function animate(now) {
    requestAnimationFrame(animate);
    if (!awake || now - last < 70) return;
    last = now;
    phase += 0.0016;
    draw();
  })(0);

  /* ─────────────── 2. MOUVEMENT ─────────────── */
  document.documentElement.classList.add('motion');

  var bar = document.createElement('div');
  bar.id = 'scrollbar';
  document.body.appendChild(bar);

  // Révélations ponctuelles (.rv)
  var watched = document.querySelectorAll('.rv');
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
  watched.forEach(function (el) { io.observe(el); });
  requestAnimationFrame(function () {                     // déjà à l'écran → immédiat
    watched.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.94 && r.bottom > 0) el.classList.add('in');
    });
  });
  setTimeout(function () { watched.forEach(function (el) { el.classList.add('in'); }); }, 4000);

  /* Entrées de section + cascade des enfants ─────────────────── */
  var STAGGER = CFG.stagger ||
    '.sec-head, .feat, .mkt-card, .step, .res, .tst, .plan, .faq, .cmp-wrap, ' +
    '.bill-toggle, .mkt-foot, .res-note, .final-card, .foot-col, .foot-brand';

  document.querySelectorAll('section:not(.hero), footer').forEach(function (sec) {
    var kids = sec.querySelectorAll(STAGGER);
    Array.prototype.forEach.call(kids, function (k, i) {
      k.classList.add('stg');
      k.style.setProperty('--i', Math.min(i, 8));   // plafonné : pas d'attente interminable
    });
  });

  var ioSec = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('sec-in');
      ioSec.unobserve(e.target);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -10% 0px' });

  var sections = document.querySelectorAll('section:not(.hero), footer');
  sections.forEach(function (s, i) {
    s.classList.add(i % 2 === 0 ? 'from-l' : 'from-r');   // alterne gauche / droite
    ioSec.observe(s);
  });
  setTimeout(function () {                         // filet : rien ne reste masqué
    sections.forEach(function (s) { s.classList.add('sec-in'); });
  }, 6000);

  /* Barre de progression + dérive du fond ────────────────────── */
  // Une seule boucle d’animation : on ne recalcule que si la page a bougé.
  var lastY = -1;
  (function frame() {
    requestAnimationFrame(frame);
    var y = window.pageYOffset;
    if (y === lastY) return;
    lastY = y;
    var h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (h > 0 ? (y / h) * 100 : 0) + '%';
    if (!reduce) cv.style.transform = 'translate3d(0,' + (-y * 0.03).toFixed(1) + 'px,0)';
  })();
})();
