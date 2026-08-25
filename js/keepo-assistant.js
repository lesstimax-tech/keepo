/* ══════════════════════════════════════════════════════════════════
   KEEPO — Bulle d'assistance, présente sur tout le site

   Une seule ligne à poser sur une page :
     <script src="js/keepo-assistant.js" defer></script>

   Elle s'adapte à qui regarde :
     • tableau de bord commerçant / caisse → /api/ai-chat
     • application client                  → /api/ai-client-chat
     • pages publiques (accueil, démo…)    → /api/ai-public-chat
   Une page peut forcer le contexte avant le chargement :
     <script>window.KEEPO_ASSISTANT = { role: 'client' };</script>

   Autonome : ni CSS ni police externe. Les icônes sont des SVG en ligne,
   pour que la bulle s'affiche même là où Font Awesome n'est pas chargé.
   ══════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var CFG  = window.KEEPO_ASSISTANT || {};
    if (CFG.disabled) return;

    /* ── Contexte ────────────────────────────────────────────────── */
    function detecterRole() {
        if (CFG.role) return CFG.role;
        var p = location.pathname;
        if (/dashboard-commercant|caisse/.test(p)) return 'merchant';
        if (/dashboard-client/.test(p))            return 'client';
        return 'public';
    }
    var ROLE = detecterRole();

    var ROUTES = {
        merchant: '/api/ai-chat',
        client  : '/api/ai-client-chat',
        public  : '/api/ai-public-chat'
    };
    var ACCUEIL = {
        merchant: 'Bonjour ! Je suis l\'assistant KEEPO. Une question sur vos récompenses, vos statistiques ou le mode caisse ?',
        client  : 'Bonjour ! Je peux vous expliquer comment gagner des points, utiliser vos récompenses ou retrouver une carte.',
        public  : 'Bonjour ! Je réponds à vos questions sur KEEPO : le fonctionnement, les offres, la mise en place dans votre commerce.'
    };
    var SUGGESTIONS = {
        merchant: ['Comment créer une récompense ?', 'Points ou tampons ?', 'Comment marche le mode caisse ?'],
        client  : ['Comment gagner des points ?', 'Où voir mes récompenses ?', 'J\'ai perdu une carte'],
        public  : ['Comment ça marche ?', 'Combien ça coûte ?', 'Faut-il installer une application ?']
    };

    /* ── Sécurité d'affichage ────────────────────────────────────── */
    var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
    }
    /* Le modèle répond en markdown léger. On échappe TOUT d'abord, puis on
       rétablit gras, code et listes : jamais l'inverse, sinon une réponse
       piégée pourrait injecter du HTML. */
    function format(txt) {
        var h = esc(txt);
        h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
        h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/^\s*[-•]\s+(.*)$/gm, '<li>$1</li>');
        h = h.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
        return h.replace(/\n/g, '<br>');
    }

    /* ── Styles ──────────────────────────────────────────────────
       Palette « Clarté » du site. Deux courbes d'animation seulement :
       « douce » pour les fondus, « ressort » pour ce qui apparaît — un
       léger dépassement rend le mouvement vivant sans le rendre lourd. */
    var CSS = [
        ':root{--kca-doux:cubic-bezier(.16,1,.3,1);--kca-ressort:cubic-bezier(.22,1.18,.36,1)}',

        /* ─── Le lanceur ─── */
        '.kca-btn{position:fixed;right:22px;bottom:var(--kca-bottom,max(22px,env(safe-area-inset-bottom)));',
        '  width:58px;height:58px;border:none;border-radius:19px;cursor:pointer;z-index:2147483000;',
        '  background:linear-gradient(135deg,#5A32A0 0%,#3F63A4 52%,#1FA5A8 100%);color:#fff;',
        '  box-shadow:0 14px 34px -12px rgba(75,69,166,.62),0 3px 8px rgba(16,16,24,.14),',
        '             inset 0 1px 0 rgba(255,255,255,.28);',
        '  display:grid;place-items:center;isolation:isolate;-webkit-tap-highlight-color:transparent;',
        '  transition:transform .5s var(--kca-ressort),border-radius .5s var(--kca-ressort),',
        '             box-shadow .4s var(--kca-doux),opacity .26s var(--kca-doux)}',
        /* halo diffus, repris du dégradé lui-même */
        '.kca-btn::before{content:"";position:absolute;inset:-7px;border-radius:inherit;z-index:-1;',
        '  background:linear-gradient(135deg,#5A32A0,#1FA5A8);filter:blur(15px);opacity:.42;',
        '  transition:opacity .4s var(--kca-doux)}',
        /* anneau d appel : trois pulsations à l arrivée, puis plus rien */
        '.kca-btn::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;',
        '  border:2px solid rgba(90,50,160,.45);animation:kcaAnneau 2.8s var(--kca-doux) 3}',
        '@keyframes kcaAnneau{0%{transform:scale(1);opacity:.65}70%,100%{transform:scale(1.55);opacity:0}}',
        '.kca-btn:hover{transform:translateY(-4px);border-radius:26px}',
        '.kca-btn:hover::before{opacity:.72}',
        '.kca-btn:active{transform:translateY(-1px) scale(.96)}',
        '.kca-btn svg{width:25px;height:25px;display:block;',
        '  transition:transform .5s var(--kca-ressort)}',
        '.kca-btn:hover svg{transform:rotate(-8deg) scale(1.08)}',
        '.kca-btn.kca-open{opacity:0;pointer-events:none;transform:scale(.5) rotate(-16deg)}',
        '.kca-btn.kca-open::after{display:none}',

        /* ─── Le panneau ─── */
        '.kca-panel{position:fixed;right:22px;bottom:var(--kca-bottom,max(22px,env(safe-area-inset-bottom)));',
        '  width:384px;max-width:calc(100vw - 32px);height:min(600px,calc(100vh - 100px));',
        '  background:#fff;border:1px solid rgba(234,234,239,.9);border-radius:24px;z-index:2147483001;',
        '  box-shadow:0 50px 90px -44px rgba(13,13,17,.42),0 12px 28px -18px rgba(13,13,17,.24),',
        '             0 0 0 1px rgba(75,69,166,.05);',
        '  display:none;flex-direction:column;overflow:hidden;',
        '  font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0D0D11;',
        '  transform-origin:bottom right;opacity:0;transform:translateY(16px) scale(.9);',
        '  transition:opacity .32s var(--kca-doux),transform .5s var(--kca-ressort)}',
        '.kca-panel.kca-show{display:flex}',
        '.kca-panel.kca-in{opacity:1;transform:none}',

        /* ─── En-tête : le dégradé dérive lentement ─── */
        '.kca-head{position:relative;display:flex;align-items:center;gap:12px;padding:15px 16px;',
        '  color:#fff;flex-shrink:0;overflow:hidden;',
        '  background:linear-gradient(115deg,#5A32A0 0%,#3F63A4 46%,#1FA5A8 100%);',
        '  background-size:220% 100%;animation:kcaDerive 16s ease-in-out infinite}',
        '@keyframes kcaDerive{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}',
        '.kca-head::after{content:"";position:absolute;inset:0;pointer-events:none;',
        '  background:radial-gradient(120% 90% at 12% -30%,rgba(255,255,255,.30),transparent 62%)}',
        '.kca-ava{position:relative;width:36px;height:36px;border-radius:12px;flex-shrink:0;',
        '  background:rgba(255,255,255,.20);box-shadow:inset 0 1px 0 rgba(255,255,255,.34);',
        '  display:grid;place-items:center;animation:kcaFlotte 4.5s ease-in-out infinite}',
        '@keyframes kcaFlotte{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}',
        '.kca-ava svg{width:17px;height:17px}',
        '.kca-ttl{flex:1;min-width:0;position:relative}',
        '.kca-ttl b{display:block;font-size:15px;font-weight:650;letter-spacing:-.015em}',
        '.kca-ttl span{display:flex;align-items:center;gap:6px;font-size:11.5px;opacity:.88;margin-top:1px}',
        '.kca-ttl span::before{content:"";width:6px;height:6px;border-radius:50%;background:#7BE8B4;',
        '  box-shadow:0 0 0 0 rgba(123,232,180,.7);animation:kcaSouffle 2.4s ease-out infinite}',
        '@keyframes kcaSouffle{0%{box-shadow:0 0 0 0 rgba(123,232,180,.65)}',
        '  70%,100%{box-shadow:0 0 0 7px rgba(123,232,180,0)}}',
        '.kca-x{position:relative;background:rgba(255,255,255,.16);border:none;color:#fff;',
        '  width:32px;height:32px;border-radius:11px;cursor:pointer;display:grid;place-items:center;',
        '  flex-shrink:0;transition:background .25s,transform .4s var(--kca-ressort)}',
        '.kca-x:hover{background:rgba(255,255,255,.3);transform:rotate(90deg)}',
        '.kca-x svg{width:14px;height:14px}',

        /* ─── Conversation ─── */
        '.kca-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:18px 16px;',
        '  display:flex;flex-direction:column;gap:12px;background:#FAFAFB;',
        '  -webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:#DEDEE7 transparent}',
        '.kca-body::-webkit-scrollbar{width:7px}',
        '.kca-body::-webkit-scrollbar-thumb{background:#DEDEE7;border-radius:99px;',
        '  border:2px solid #FAFAFB}',
        '.kca-body::-webkit-scrollbar-thumb:hover{background:#C9C9D4}',

        '.kca-msg{position:relative;max-width:86%;padding:11px 14px;font-size:14px;line-height:1.55;',
        '  word-wrap:break-word;overflow-wrap:anywhere;',
        '  animation:kcaEntre .48s var(--kca-ressort) both}',
        '@keyframes kcaEntre{from{opacity:0;transform:translateY(10px) scale(.96)}}',
        '.kca-bot{align-self:flex-start;background:#fff;color:#33333D;',
        '  border:1px solid #EDEDF2;border-radius:16px 16px 16px 5px;',
        '  box-shadow:0 2px 6px -2px rgba(13,13,17,.06)}',
        '.kca-me{align-self:flex-end;color:#fff;border-radius:16px 16px 5px 16px;',
        '  background:linear-gradient(135deg,#5A32A0,#3F63A4);',
        '  box-shadow:0 6px 16px -8px rgba(75,69,166,.6)}',
        '.kca-msg code{background:rgba(75,69,166,.09);color:#4B45A6;padding:1.5px 6px;',
        '  border-radius:6px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.kca-me code{background:rgba(255,255,255,.18);color:#fff}',
        '.kca-msg ul{margin:7px 0 3px;padding-left:17px}',
        '.kca-msg li{margin:4px 0}',
        '.kca-msg li::marker{color:#1FA5A8}',
        '.kca-msg strong{font-weight:650}',
        '.kca-me a,.kca-bot a{color:inherit;text-decoration:underline;text-underline-offset:2px}',

        /* ─── Attente ─── */
        '.kca-wait{align-self:flex-start;display:flex;gap:5px;padding:13px 15px;background:#fff;',
        '  border:1px solid #EDEDF2;border-radius:16px 16px 16px 5px;',
        '  animation:kcaEntre .4s var(--kca-ressort) both}',
        '.kca-wait i{width:7px;height:7px;border-radius:50%;',
        '  background:linear-gradient(135deg,#5A32A0,#1FA5A8);animation:kcaPoint 1.25s ease-in-out infinite}',
        '.kca-wait i:nth-child(2){animation-delay:.16s}.kca-wait i:nth-child(3){animation-delay:.32s}',
        '@keyframes kcaPoint{0%,60%,100%{opacity:.3;transform:translateY(0) scale(.85)}',
        '  30%{opacity:1;transform:translateY(-5px) scale(1)}}',

        /* ─── Action réalisée : la coche se trace ─── */
        '.kca-fait{position:relative;align-self:flex-start;display:flex;align-items:center;gap:10px;',
        '  max-width:92%;padding:11px 14px 11px 15px;font-size:13px;font-weight:550;line-height:1.45;',
        '  color:#0B6E4F;border-radius:14px;overflow:hidden;',
        '  background:linear-gradient(135deg,#EDF9F3,#E6F6F4);border:1px solid rgba(14,159,110,.22);',
        '  box-shadow:0 3px 10px -6px rgba(14,159,110,.4);',
        '  animation:kcaEntre .5s var(--kca-ressort) both}',
        '.kca-fait::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;',
        '  background:linear-gradient(180deg,#12B981,#1FA5A8)}',
        '.kca-fait svg{width:16px;height:16px;flex-shrink:0;color:#12B981}',
        '.kca-fait svg path{stroke-dasharray:26;stroke-dashoffset:26;',
        '  animation:kcaTrace .55s .14s cubic-bezier(.65,0,.35,1) forwards}',
        '@keyframes kcaTrace{to{stroke-dashoffset:0}}',

        /* ─── Suggestions ─── */
        '.kca-sugg{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 14px;background:#FAFAFB;flex-shrink:0}',
        '.kca-sugg button{background:#fff;border:1px solid #E4E4EC;border-radius:999px;',
        '  padding:9px 14px;font-size:12.5px;font-family:inherit;color:#3D3D4A;cursor:pointer;',
        '  box-shadow:0 1px 2px rgba(13,13,17,.04);',
        '  animation:kcaEntre .5s var(--kca-ressort) both;animation-delay:calc(var(--i,0)*70ms);',
        '  transition:transform .3s var(--kca-ressort),border-color .25s,color .25s,box-shadow .3s}',
        '.kca-sugg button:hover{transform:translateY(-2px);border-color:rgba(75,69,166,.45);',
        '  color:#4B45A6;box-shadow:0 8px 18px -10px rgba(75,69,166,.5)}',
        '.kca-sugg button:active{transform:translateY(0) scale(.97)}',

        /* ─── Saisie ─── */
        '.kca-foot{display:flex;gap:10px;padding:13px 14px;background:#fff;flex-shrink:0;',
        '  border-top:1px solid #EFEFF4;padding-bottom:max(13px,env(safe-area-inset-bottom))}',
        '.kca-foot input{flex:1;min-width:0;border:1px solid #E4E4EC;border-radius:999px;',
        '  padding:12px 16px;font-size:14px;font-family:inherit;color:#0D0D11;background:#F7F7FA;',
        '  outline:none;transition:border-color .25s,background .25s,box-shadow .3s}',
        '.kca-foot input::placeholder{color:#9A9AA8}',
        '.kca-foot input:focus{border-color:#4B45A6;background:#fff;',
        '  box-shadow:0 0 0 4px rgba(75,69,166,.11)}',
        '.kca-send{position:relative;width:44px;height:44px;flex-shrink:0;border:none;',
        '  border-radius:50%;cursor:pointer;color:#fff;display:grid;place-items:center;',
        '  background:linear-gradient(135deg,#5A32A0,#1FA5A8);',
        '  box-shadow:0 8px 18px -9px rgba(75,69,166,.75);',
        '  transition:transform .4s var(--kca-ressort),box-shadow .3s,opacity .25s}',
        '.kca-send:hover:not(:disabled){transform:translateY(-2px) scale(1.06)}',
        '.kca-send:active:not(:disabled){transform:scale(.94)}',
        '.kca-send:disabled{opacity:.4;cursor:default;transform:none;box-shadow:none}',
        '.kca-send svg{width:16px;height:16px;transition:transform .4s var(--kca-ressort)}',
        '.kca-send:hover:not(:disabled) svg{transform:translateX(2px)}',

        /* ─── Petits écrans : feuille qui remonte du bas ─── */
        '@media (max-width:520px){',
        '  .kca-panel{right:0;left:0;bottom:0;width:100%;max-width:100%;height:88vh;',
        '    border-radius:26px 26px 0 0;border-bottom:none;transform-origin:bottom center;',
        '    transform:translateY(100%)}',
        '  .kca-panel.kca-in{transform:none}',
        '  .kca-head{padding-top:17px}',
        '  .kca-head::before{content:"";position:absolute;top:7px;left:50%;transform:translateX(-50%);',
        '    width:38px;height:4px;border-radius:99px;background:rgba(255,255,255,.4)}',
        '  /* Sous le doigt : la croix et les suggestions doivent rester atteignables */',
        '  .kca-x{width:42px;height:42px;border-radius:14px}',
        '  .kca-sugg button{padding:13px 17px;font-size:13px}',
        '  .kca-btn{right:18px}',
        '}',

        /* ─── Mouvement réduit : on garde les fondus, pas les ressorts ─── */
        '@media (prefers-reduced-motion:reduce){',
        '  .kca-btn,.kca-panel,.kca-msg,.kca-fait,.kca-sugg button,.kca-wait{animation:none!important}',
        '  .kca-btn::after,.kca-ava,.kca-head,.kca-ttl span::before{animation:none!important}',
        '  .kca-fait svg path{stroke-dashoffset:0;animation:none!important}',
        '  .kca-panel{transition:opacity .2s linear;transform:none}',
        '  .kca-panel:not(.kca-in){opacity:0}',
        '}'
    ].join('\n');

    var SVG = {
        bulle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
        etoile: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.6L21 10l-5.3 4.2L17 21l-5-3.4L7 21l1.3-6.8L3 10l6.8-1.4z"/></svg>',
        croix: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
        envoi: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
        coche: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
    };

    /* ── Construction ────────────────────────────────────────────── */
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.className = 'kca-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Ouvrir l\'assistant KEEPO');
    btn.innerHTML = SVG.bulle;

    var panel = document.createElement('div');
    panel.className = 'kca-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Assistant KEEPO');
    panel.innerHTML =
        '<div class="kca-head">'
      +   '<div class="kca-ava">' + SVG.etoile + '</div>'
      +   '<div class="kca-ttl"><b>Assistant KEEPO</b><span>Réponse en quelques secondes</span></div>'
      +   '<button class="kca-x" type="button" aria-label="Fermer">' + SVG.croix + '</button>'
      + '</div>'
      + '<div class="kca-body"></div>'
      + '<div class="kca-sugg"></div>'
      + '<form class="kca-foot">'
      +   '<input type="text" placeholder="Posez votre question…" aria-label="Votre question" autocomplete="off">'
      +   '<button class="kca-send" type="submit" aria-label="Envoyer">' + SVG.envoi + '</button>'
      + '</form>';

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    var corps  = panel.querySelector('.kca-body');
    var sugg   = panel.querySelector('.kca-sugg');
    var form   = panel.querySelector('.kca-foot');
    var champ  = panel.querySelector('input');
    var envoi  = panel.querySelector('.kca-send');

    /* ── Historique (par rôle, le temps de l'onglet) ─────────────── */
    var CLE = 'KEEPO_assistant_' + ROLE;
    var historique = [];
    try { historique = JSON.parse(sessionStorage.getItem(CLE) || '[]'); } catch (e) { historique = []; }
    function sauver() {
        try { sessionStorage.setItem(CLE, JSON.stringify(historique.slice(-20))); } catch (e) {}
    }

    function bulle(qui, texte) {
        var d = document.createElement('div');
        d.className = 'kca-msg ' + (qui === 'me' ? 'kca-me' : 'kca-bot');
        d.innerHTML = format(texte);
        corps.appendChild(d);
        corps.scrollTop = corps.scrollHeight;
        return d;
    }
    // Une action a réellement modifié le compte : on la montre à part du
    // texte, pour qu'elle ne se noie pas dans la réponse.
    function fait(libelle) {
        var d = document.createElement('div');
        d.className = 'kca-fait';
        d.innerHTML = SVG.coche + '<span>' + esc(libelle) + '</span>';
        corps.appendChild(d);
        corps.scrollTop = corps.scrollHeight;
    }

    function attente() {
        var d = document.createElement('div');
        d.className = 'kca-wait';
        d.innerHTML = '<i></i><i></i><i></i>';
        corps.appendChild(d);
        corps.scrollTop = corps.scrollHeight;
        return d;
    }

    function peindreSuggestions() {
        // Les suggestions n'ont d'intérêt qu'au premier contact.
        if (historique.length > 0) { sugg.innerHTML = ''; return; }
        sugg.innerHTML = '';
        SUGGESTIONS[ROLE].forEach(function (t, i) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = t;
            b.style.setProperty('--i', i);   // entrée en cascade
            b.onclick = function () { champ.value = t; form.requestSubmit ? form.requestSubmit() : envoyer(); };
            sugg.appendChild(b);
        });
    }

    function peindre() {
        corps.innerHTML = '';
        if (historique.length === 0) bulle('bot', ACCUEIL[ROLE]);
        else historique.forEach(function (m) { bulle(m.role === 'user' ? 'me' : 'bot', m.content); });
        peindreSuggestions();
    }

    /* ── Ouverture / fermeture ───────────────────────────────────── */
    var ouvert = false;
    function ouvrir() {
        if (ouvert) return;
        ouvert = true;
        peindre();
        panel.classList.add('kca-show');
        // requestAnimationFrame ne se déclenche pas dans un onglet en arrière-plan :
        // sans filet, le panneau resterait invisible et décalé à la réouverture.
        var montrer = function () { panel.classList.add('kca-in'); };
        requestAnimationFrame(montrer);
        setTimeout(montrer, 40);
        btn.classList.add('kca-open');
        setTimeout(function () { if (window.innerWidth > 520) champ.focus(); }, 120);
    }
    function fermer() {
        if (!ouvert) return;
        ouvert = false;
        panel.classList.remove('kca-in');
        btn.classList.remove('kca-open');
        setTimeout(function () { if (!ouvert) panel.classList.remove('kca-show'); }, 280);
    }
    btn.onclick = ouvrir;
    panel.querySelector('.kca-x').onclick = fermer;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ouvert) fermer(); });

    /* ── Envoi ───────────────────────────────────────────────────── */
    var enCours = false;

    // Les points d'entrée authentifiés exigent le jeton de session ; le point
    // d'entrée public n'en veut pas. Un seul endroit pour en décider.
    function entetes() {
        var base = { 'Content-Type': 'application/json' };
        if (ROLE === 'public' || !window.supabaseClient) return Promise.resolve(base);
        return window.supabaseClient.auth.getSession().then(function (r) {
            var s = r && r.data && r.data.session;
            if (s) base['Authorization'] = 'Bearer ' + s.access_token;
            return base;
        }).catch(function () { return base; });
    }

    function contexte() {
        if (ROLE === 'merchant') {
            var t = document.getElementById('merchant-title');
            return { merchantName: t ? t.innerText : '' };
        }
        if (ROLE === 'client') {
            var n = document.getElementById('user-display-name');
            return { clientName: n ? n.innerText : '' };
        }
        return { page: location.pathname };
    }

    function envoyer() {
        var texte = (champ.value || '').trim();
        if (!texte || enCours) return;

        enCours = true;
        champ.value = '';
        envoi.disabled = true;
        sugg.innerHTML = '';

        historique.push({ role: 'user', content: texte });
        bulle('me', texte);
        sauver();

        var pointsSuspension = attente();

        entetes().then(function (h) {
            return fetch(ROUTES[ROLE], {
                method : 'POST',
                headers: h,
                body   : JSON.stringify({ messages: historique.slice(-12), userContext: contexte() })
            });
        }).then(function (res) {
            return res.json().then(function (d) { return { ok: res.ok, statut: res.status, d: d }; });
        }).then(function (r) {
            pointsSuspension.remove();
            if (!r.ok || !r.d.reply) {
                // On nomme ce qui est actionnable, sans étaler l'erreur brute.
                var m = r.statut === 429
                    ? 'Vous allez un peu vite pour moi — laissez-moi une minute.'
                    : r.statut === 401
                    ? 'Votre session a expiré. Rechargez la page pour vous reconnecter.'
                    : r.statut === 503 || r.statut === 504
                    ? 'Le service est momentanément saturé. Réessayez dans un instant.'
                    : 'Je n\'ai pas réussi à répondre. Réessayez dans un instant.';
                bulle('bot', m);
                return;
            }
            var actions = r.d.actions || [];
            actions.forEach(function (a) { fait(a.libelle); });
            // La page peut avoir des listes à recharger : sans cela le
            // commerçant voit un écran périmé et refait le travail.
            if (actions.length && typeof window.KEEPO_ON_ACTION === 'function') {
                try { window.KEEPO_ON_ACTION(actions); } catch (e) { console.warn(e); }
            }
            historique.push({ role: 'model', content: r.d.reply });
            bulle('bot', r.d.reply);
            sauver();
        }).catch(function () {
            pointsSuspension.remove();
            bulle('bot', 'Connexion interrompue. Vérifiez votre réseau et réessayez.');
        }).then(function () {
            enCours = false;
            envoi.disabled = false;
            champ.focus();
        });
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); envoyer(); });

    /* Une page peut ouvrir la bulle elle-même : KeepoAssistant.ouvrir() */
    window.KeepoAssistant = {
        ouvrir: ouvrir,
        fermer: fermer,
        role  : ROLE,
        demander: function (q) { ouvrir(); champ.value = q; envoyer(); }
    };
})();
