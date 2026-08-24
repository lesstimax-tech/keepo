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

    /* ── Styles ──────────────────────────────────────────────────── */
    var CSS = [
        '.kca-btn{position:fixed;right:20px;bottom:var(--kca-bottom,max(20px,env(safe-area-inset-bottom)));',
        '  width:56px;height:56px;border:none;border-radius:50%;cursor:pointer;z-index:2147483000;',
        '  background:linear-gradient(135deg,#5A32A0 0%,#3F63A4 52%,#1FA5A8 100%);color:#fff;',
        '  box-shadow:0 10px 30px -8px rgba(75,69,166,.55),0 2px 6px rgba(16,16,24,.18);',
        '  display:grid;place-items:center;transition:transform .3s cubic-bezier(.16,1,.3,1),opacity .2s}',
        '.kca-btn:hover{transform:translateY(-3px) scale(1.04)}',
        '.kca-btn svg{width:25px;height:25px;display:block}',
        '.kca-btn.kca-open{opacity:0;pointer-events:none;transform:scale(.6)}',
        '.kca-dot{position:absolute;top:2px;right:2px;width:12px;height:12px;border-radius:50%;',
        '  background:#E0245E;border:2px solid #fff}',

        '.kca-panel{position:fixed;right:20px;bottom:var(--kca-bottom,max(20px,env(safe-area-inset-bottom)));',
        '  width:380px;max-width:calc(100vw - 32px);height:min(580px,calc(100vh - 96px));',
        '  background:#fff;border:1px solid #EAEAEF;border-radius:18px;z-index:2147483001;',
        '  box-shadow:0 40px 80px -40px rgba(13,13,17,.45),0 4px 12px rgba(13,13,17,.08);',
        '  display:none;flex-direction:column;overflow:hidden;',
        '  font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0D0D11;',
        '  opacity:0;transform:translateY(14px) scale(.98);',
        '  transition:opacity .28s cubic-bezier(.16,1,.3,1),transform .28s cubic-bezier(.16,1,.3,1)}',
        '.kca-panel.kca-show{display:flex}',
        '.kca-panel.kca-in{opacity:1;transform:none}',

        '.kca-head{display:flex;align-items:center;gap:11px;padding:14px 16px;',
        '  background:linear-gradient(135deg,#5A32A0 0%,#3F63A4 52%,#1FA5A8 100%);color:#fff;flex-shrink:0}',
        '.kca-ava{width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.2);',
        '  display:grid;place-items:center;flex-shrink:0}',
        '.kca-ava svg{width:17px;height:17px}',
        '.kca-ttl{flex:1;min-width:0}',
        '.kca-ttl b{display:block;font-size:14.5px;font-weight:650;letter-spacing:-.01em}',
        '.kca-ttl span{display:block;font-size:11.5px;opacity:.86}',
        '.kca-x{background:rgba(255,255,255,.16);border:none;color:#fff;width:30px;height:30px;',
        '  border-radius:9px;cursor:pointer;display:grid;place-items:center;flex-shrink:0}',
        '.kca-x:hover{background:rgba(255,255,255,.28)}',
        '.kca-x svg{width:14px;height:14px}',

        '.kca-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px;',
        '  background:#FAFAFB;-webkit-overflow-scrolling:touch}',
        '.kca-msg{max-width:86%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.55;',
        '  word-wrap:break-word;overflow-wrap:anywhere;animation:kcaIn .34s cubic-bezier(.16,1,.3,1) both}',
        '@keyframes kcaIn{from{opacity:0;transform:translateY(8px)}}',
        '.kca-bot{align-self:flex-start;background:#fff;border:1px solid #EAEAEF;color:#33333D;',
        '  border-bottom-left-radius:5px}',
        '.kca-me{align-self:flex-end;color:#fff;border-bottom-right-radius:5px;',
        '  background:linear-gradient(135deg,#5A32A0,#3F63A4)}',
        '.kca-msg code{background:rgba(75,69,166,.10);padding:1px 5px;border-radius:5px;font-size:12.5px}',
        '.kca-msg ul{margin:6px 0;padding-left:18px}',
        '.kca-msg li{margin:3px 0}',
        '.kca-msg strong{font-weight:650}',
        '.kca-me a,.kca-bot a{color:inherit;text-decoration:underline}',

        '.kca-wait{align-self:flex-start;display:flex;gap:4px;padding:13px}',
        '.kca-wait i{width:7px;height:7px;border-radius:50%;background:#8E8E98;animation:kcaP 1.3s infinite}',
        '.kca-wait i:nth-child(2){animation-delay:.18s}.kca-wait i:nth-child(3){animation-delay:.36s}',
        '@keyframes kcaP{0%,60%,100%{opacity:.28;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}',

        '.kca-fait{align-self:flex-start;display:flex;align-items:center;gap:8px;max-width:90%;',
        '  background:#EAF7F0;border:1px solid rgba(14,159,110,.28);color:#0B7A55;',
        '  border-radius:12px;padding:9px 12px;font-size:13px;font-weight:550;',
        '  animation:kcaIn .34s cubic-bezier(.16,1,.3,1) both}',
        '.kca-fait svg{width:15px;height:15px;flex-shrink:0}',
        '.kca-sugg{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 12px;background:#FAFAFB;flex-shrink:0}',
        '.kca-sugg button{background:#fff;border:1px solid #DEDEE7;border-radius:999px;padding:8px 13px;',
        '  font-size:12.5px;font-family:inherit;color:#33333D;cursor:pointer;transition:all .2s}',
        '.kca-sugg button:hover{border-color:#4B45A6;color:#4B45A6;background:#F0EFFA}',

        '.kca-foot{display:flex;gap:9px;padding:12px 14px;border-top:1px solid #EAEAEF;background:#fff;',
        '  flex-shrink:0;padding-bottom:max(12px,env(safe-area-inset-bottom))}',
        '.kca-foot input{flex:1;min-width:0;border:1px solid #DEDEE7;border-radius:999px;padding:11px 15px;',
        '  font-size:14px;font-family:inherit;color:#0D0D11;background:#FAFAFB;outline:none}',
        '.kca-foot input:focus{border-color:#4B45A6;background:#fff}',
        '.kca-send{width:42px;height:42px;flex-shrink:0;border:none;border-radius:50%;cursor:pointer;',
        '  background:linear-gradient(135deg,#5A32A0,#1FA5A8);color:#fff;display:grid;place-items:center}',
        '.kca-send:disabled{opacity:.45;cursor:default}',
        '.kca-send svg{width:16px;height:16px}',

        '@media (max-width:520px){',
        '  .kca-panel{right:0;left:0;bottom:0;width:100%;max-width:100%;height:88vh;',
        '    border-radius:20px 20px 0 0;border-bottom:none}',
        '  .kca-btn{right:16px}',
        '}',
        '@media (prefers-reduced-motion:reduce){',
        '  .kca-panel,.kca-btn,.kca-msg{transition:none;animation:none}',
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
        SUGGESTIONS[ROLE].forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = t;
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
