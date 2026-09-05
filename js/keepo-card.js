/* ══════════════════════════════════════════════════════════════════
   KEEPO — Rendu de la carte de fidélité (moteur unique)

   Utilisé à deux endroits :
     • dashboard-client.html     → les vraies cartes du client
     • dashboard-commercant.html → l'aperçu du Studio Design Card

   Les deux appellent KeepoCard.render() avec les mêmes options, donc
   l'aperçu est le rendu client, pas une imitation. Toute évolution de la
   carte se fait ici et se répercute des deux côtés.

   La carte ne contient QUE ce que le Studio pilote : niveau VIP, boutiques
   et autres informations de compte vivent dans la fenetre du QR code.

   Le FORMAT de la carte (largeur, arrondi, marges, ombre) n'est pas
   réglable : il appartient à l'application client. Le Studio pilote
   l'habillage (fond, motif, typographies, couleurs, logo, tampons).
   ══════════════════════════════════════════════════════════════════ */
window.KeepoCard = (function () {
    'use strict';

    var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
    }
    /* Sécurise une valeur CSS venant du Studio : ni guillemet, ni fin de
       déclaration, pour qu'un réglage ne puisse pas déborder de son attribut. */
    function css(v, fallback) {
        if (v == null || v === '') return fallback || '';
        var s = String(v).replace(/["'<>;{}\\]/g, '').trim();
        return s || fallback || '';
    }
    function num(v, fallback) {
        var n = Number(v);
        return isFinite(n) ? n : fallback;
    }
    function glow(hex, alpha) {
        if (alpha === undefined) alpha = 0.28;
        try {
            var h = String(hex).replace('#', '');
            return 'rgba(' + parseInt(h.substring(0, 2), 16) + ','
                           + parseInt(h.substring(2, 4), 16) + ','
                           + parseInt(h.substring(4, 6), 16) + ',' + alpha + ')';
        } catch (e) { return 'rgba(14,124,140,0.22)'; }
    }

    /* Motif optionnel dessiné par-dessus le fond */
    function patternStyle(p) {
        var c = 'rgba(255,255,255,.14)';
        if (p === 'dots')  return 'background-image:radial-gradient(' + c + ' 1.4px, transparent 1.4px);background-size:14px 14px;';
        if (p === 'lines') return 'background-image:repeating-linear-gradient(45deg, ' + c + ' 0 1px, transparent 1px 11px);';
        if (p === 'grid')  return 'background-image:linear-gradient(' + c + ' 1px, transparent 1px),linear-gradient(90deg, ' + c + ' 1px, transparent 1px);background-size:18px 18px;';
        return '';
    }

    /* Quel type de fond le Studio a-t-il défini ? (compatible anciens formats) */
    function bgKind(S) {
        if (S.bgType) return S.bgType;
        return S.bg ? 'image' : 'none';
    }

    /* Le fond d'une carte, en trois morceaux : le style à poser sur le
       conteneur, le voile éventuel et le motif. Exporté parce que
       l'affiche de comptoir doit peindre exactement le même fond que la
       carte — deux définitions divergeraient au premier réglage ajouté. */
    function background(S) {
        S = S || {};
        var kind = bgKind(S);
        var style = '';
        if (kind === 'gradient') {
            style = 'background-image:linear-gradient(' + num(S.gradAngle, 135) + 'deg, '
                  + css(S.grad1, '#5A32A0') + ', ' + css(S.grad2, '#1FA5A8') + ');';
        } else if (kind === 'color') {
            style = 'background-color:' + css(S.bg1, '#1B1533') + ';';
        } else if (S.bg) {
            style = 'background-image:url(' + String(S.bg).replace(/[()'"\\\s]/g, '') + ');'
                  + 'background-size:cover;background-position:center;';
        }

        /* Voile assombrissant + flou : uniquement sur une photo de fond */
        var overlay = '';
        if (kind === 'image' && S.bg) {
            var op = num(S.opacity, 50) / 100;
            var bl = num(S.blur, 0);
            overlay = '<div style="position:absolute;inset:0;z-index:0;pointer-events:none;'
                    + 'border-radius:inherit;background:rgba(0,0,0,' + op + ');'
                    + (bl ? '-webkit-backdrop-filter:blur(' + bl + 'px);backdrop-filter:blur(' + bl + 'px);' : '')
                    + '"></div>';
        }

        var pat = patternStyle(S.pattern);
        var pattern = pat
            ? '<div style="position:absolute;inset:0;z-index:1;pointer-events:none;' + pat + '"></div>'
            : '';

        /* clair : le fond est-il assez lumineux pour porter du texte sombre ? */
        var reference = kind === 'color' ? css(S.bg1, '#1B1533')
                      : kind === 'gradient' ? css(S.grad1, '#5A32A0') : '#1B1533';
        return { style: style, overlay: overlay, pattern: pattern,
                 kind: kind, clair: estClair(reference) };
    }

    /* Luminance perçue : sert à choisir une encre lisible sur ce fond. */
    function estClair(hex) {
        var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
        if (!m) return false;
        var v = parseInt(m[1], 16);
        var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150;
    }

    /* Une case de tampon */
    function stampCell(on, S, accent) {
        var sz  = num(S.stampSize, 21);
        var ic  = css(S.stampIcon, 'star');
        var on1 = css(S.stampOn, accent);
        var off = S.stampOff ? css(S.stampOff) : null;
        var bg  = on ? on1 : (off ? 'color-mix(in srgb, ' + off + ' 16%, transparent)' : 'var(--bg-2)');
        var fg  = on ? '#fff' : (off ? 'color-mix(in srgb, ' + off + ' 55%, transparent)' : 'var(--faint)');
        var bd  = on ? on1 : (off ? 'color-mix(in srgb, ' + off + ' 28%, transparent)' : 'var(--border-2)');
        return '<span style="width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;'
             + 'display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;'
             + 'font-size:' + Math.round(sz * 0.48) + 'px;background:' + bg + ';color:' + fg + ';'
             + 'border:1px solid ' + bd + ';">'
             + (on ? '<i class="fa-solid fa-' + ic + '"></i>' : '') + '</span>';
    }

    /* Remplace le jeton {n} des mentions par la valeur du moment. */
    function tpl(text, n) {
        return String(text == null ? '' : text).replace(/\{n\}/g, n);
    }

    /**
     * Construit le HTML complet d'une carte.
     *
     * @param {object} o
     *   studio         {object}  options enregistrées par le Studio
     *   accent         {string}  couleur d'accent (#RRGGBB)
     *   shopName       {string}  nom affiché
     *   logoUrl        {string}  logo du commerce (URL ou data:), sinon initiale
     *   points, goal   {number}  solde et objectif (mode points)
     *   stampMode      {bool}    programme à tampons
     *   stampGoal      {number}  nombre de tampons de la carte
     *   stampReward    {string}  récompense annoncée
     *   showRewardsBtn {bool}    bouton « Voir les récompenses »
     *   onclick, rewardsOnclick {string} gestionnaires (vides pour l'aperçu)
     *   animate        {bool}    animation d'entrée + barre progressive
     */
    function render(o) {
        o = o || {};
        var S = o.studio || {};
        var accent = css(o.accent || S.borderColor, '#16B8C4');
        var kind   = bgKind(S);
        var hasBg  = (kind === 'image' && !!S.bg) || kind === 'gradient' || kind === 'color';

        /* ── Fond ── */
        var fond      = background(S);
        var bgStyle   = fond.style;
        var overlayEl = fond.overlay;
        var patEl     = fond.pattern;

        /* ── Éléments libres posés par le commerçant ── */
        var layers = Array.isArray(S.layers) ? S.layers : [];
        var layersEl = layers.length
            ? '<div style="position:absolute;inset:0;z-index:2;pointer-events:none;">' + layers.map(function (l) {
                  var pos = 'position:absolute;left:' + num(l.x, 50) + '%;top:' + num(l.y, 50) + '%;'
                          + 'transform:translate(-50%,-50%) rotate(' + num(l.rot, 0) + 'deg);'
                          + 'opacity:' + (num(l.op, 100) / 100) + ';';
                  if (l.type === 'text') {
                      return '<div style="' + pos + 'font-size:' + num(l.size, 16) + 'px;'
                           + 'font-family:' + css(l.font, 'inherit') + ';font-weight:' + css(l.weight, '700') + ';'
                           + 'color:' + css(l.color, '#fff') + ';letter-spacing:' + num(l.ls, 0) + 'px;'
                           + (l.shadow ? 'text-shadow:0 2px 8px rgba(0,0,0,.55);' : '')
                           + 'white-space:pre-wrap;max-width:92%;">' + esc(l.text) + '</div>';
                  }
                  if (l.type === 'icon') {
                      return '<div style="' + pos + 'font-size:' + num(l.size, 26) + 'px;color:' + css(l.color, '#fff') + ';'
                           + (l.shadow ? 'text-shadow:0 2px 8px rgba(0,0,0,.55);' : '')
                           + '"><i class="fa-solid fa-' + css(l.icon, 'star') + '"></i></div>';
                  }
                  return '<div style="' + pos + 'width:' + num(l.w, 30) + '%;"><img src="' + esc(l.src)
                       + '" alt="" style="width:100%;display:block;border-radius:' + num(l.radius, 0) + 'px;"></div>';
              }).join('') + '</div>'
            : '';

        /* ── Pastille du logo — sans fond ni contour ── */
        var logo     = S.logo || o.logoUrl || '';   // le logo importe dans le Studio prime
        var logoSize = num(S.logoSize, 44);
        var initial  = esc(String(o.shopName || 'K').trim().charAt(0).toUpperCase() || 'K');
        var chipEl   = '';
        if (S.show ? S.show.chip !== false : true) {
            chipEl = '<div class="card-logo-chip' + (logo ? ' has-img' : '') + '"'
                   + ' style="width:' + logoSize + 'px;height:' + logoSize + 'px;font-size:'
                   + Math.round(logoSize * 0.39) + 'px;">' + initial
                   + (logo ? '<img src="' + esc(logo) + '" alt="" loading="lazy" '
                           + 'onerror="this.parentNode.classList.remove(&quot;has-img&quot;);this.remove()">' : '')
                   + '</div>';
        }

        /* ── Compteur ── */
        var points    = num(o.points, 0);
        var goal      = Math.max(num(o.goal, 10), 1);
        var stampGoal = Math.max(num(o.stampGoal, 10), 1);
        var stamps    = !!o.stampMode;
        var reached   = stamps ? points >= stampGoal : points >= goal;
        var remaining = Math.max((stamps ? stampGoal : goal) - points, 0);

        var ptsEl = '';
        if (S.show ? S.show.pts !== false : true) {
            ptsEl = '<div class="card-points-block">'
                  + '<div class="card-points-num" style="color:' + css(S.ptsColor, accent) + ';'
                  + (S.ptsFont ? 'font-family:' + css(S.ptsFont) + ';' : '')
                  + (S.ptsSize ? 'font-size:' + num(S.ptsSize, 30) + 'px;' : '') + '">'
                  + (stamps ? Math.min(points, stampGoal) + '/' + stampGoal : points) + '</div>'
                  + '<div class="card-points-lbl" style="'
                  + (S.ptsLabelColor ? 'color:' + css(S.ptsLabelColor) + ';' : '')
                  + (S.ptsLabelSize ? 'font-size:' + num(S.ptsLabelSize, 10.5) + 'px;' : '') + '">'
                  + (stamps ? '<i class="fa-solid fa-stamp"></i> Tampons' : esc(S.ptsLabel || 'Points'))
                  + '</div></div>';
        }

        /* ── Nom du commerce ── */
        var nameStyle = (S.titleFont ? 'font-family:' + css(S.titleFont) + ';' : '')
                      + (S.titleSize ? 'font-size:' + num(S.titleSize, 17) + 'px;' : '')
                      + (S.titleWeight ? 'font-weight:' + css(S.titleWeight) + ';' : '')
                      + (S.titleLs !== undefined ? 'letter-spacing:' + num(S.titleLs, 0) + 'px;' : '')
                      + (S.txtColor ? 'color:' + css(S.txtColor) + ';' : '')
                      + (S.align ? 'text-align:' + css(S.align) + ';' : '')
                      + (S.titleShadow ? 'text-shadow:0 2px 8px rgba(0,0,0,.55);' : '');
        var shopName = S.titleUpper ? String(o.shopName || '').toUpperCase() : (o.shopName || '');
        var nameEl = (S.show ? S.show.title !== false : true)
            ? '<div class="merchant-name" style="' + nameStyle + '">' + esc(shopName) + '</div>' : '';

        /* ── Bloc central : tampons ou barre de progression ── */
        var middle = '';
        if (stamps) {
            var filled = Math.min(points, stampGoal), cells = '';
            for (var i = 0; i < stampGoal; i++) cells += stampCell(i < filled, S, accent);
            var note = reached
                ? '🎉 Carte pleine — ' + esc(o.stampReward || 'récompense') + ' à retirer !'
                : (S.stampText ? esc(tpl(S.stampText, remaining))
                    : (o.stampReward
                        ? 'Récompense : <strong style="color:' + accent + '">' + esc(o.stampReward) + '</strong>'
                        : stampGoal + ' tampons = 1 récompense'));
            middle = '<div class="card-stamps-row" style="gap:' + num(S.stampGap, 6) + 'px;">' + cells + '</div>'
                   + '<div class="card-stamps-note">' + note + '</div>';
        } else if (S.show ? S.show.bar !== false : true) {
            var pct = Math.min((points / goal) * 100, 100);
            middle = '<div class="card-progress-wrap">'
                   + '<div class="card-progress-labels"><span>' + points + ' pts</span>'
                   + '<span>Objectif : ' + goal + ' pts</span></div>'
                   + '<div class="card-progress-track" style="height:' + num(S.barH, 6) + 'px;'
                   + 'border-radius:' + num(S.barR, 99) + 'px;'
                   + (S.barBg ? 'background:color-mix(in srgb, ' + css(S.barBg) + ' 22%, transparent);' : '') + '">'
                   + '<div class="card-progress-fill" data-width="' + pct + '%" style="width:'
                   + (o.animate ? '0' : pct) + '%;background:' + css(S.barFill, accent) + ';'
                   + 'border-radius:' + num(S.barR, 99) + 'px;"></div></div></div>';
        }

        /* ── Pied de carte ── */
        var badgeOn = S.show ? S.show.badge !== false : true;
        var footStatus;
        if (reached && badgeOn) {
            var bc = css(S.badgeColor, accent);
            footStatus = '<div class="card-reward-badge" style="color:' + bc + ';'
                       + 'border-color:' + glow(bc, 0.35) + ';background:' + glow(bc, 0.1) + ';'
                       + 'border-radius:' + num(S.badgeR, 999) + 'px;"><i class="fa-solid fa-gift"></i> '
                       + esc(S.badgeText || (stamps ? 'À retirer en caisse !' : 'Récompense dispo !')) + '</div>';
        } else {
            var hint = S.hintText
                ? tpl(S.hintText, remaining)
                : 'encore ' + remaining + (stamps ? ' tampon' + (remaining > 1 ? 's' : '')
                                                  : ' pt' + (remaining > 1 ? 's' : ''));
            footStatus = '<div class="card-foot-note" style="'
                       + (S.hintSize ? 'font-size:' + num(S.hintSize, 10) + 'px;' : '')
                       + (S.hintColor ? 'color:' + css(S.hintColor) + ';' : '') + '">' + esc(hint) + '</div>';
        }
        var rewardsBtn = (!stamps && o.showRewardsBtn)
            ? '<button class="btn-see-rewards"' + (o.rewardsOnclick ? ' onclick="' + o.rewardsOnclick + '"' : '')
            + ' style="border-color:' + glow(accent, 0.4) + ';color:' + accent + ';">'
            + '<i class="fa-solid fa-gift"></i> Voir les récompenses</button>' : '';

        /* ── Assemblage ── */
        return '<div class="kc-host"><div class="loyalty-card' + (hasBg ? ' has-bg' : '') + (o.animate ? '' : ' kc-static') + '"'
             + ' style="--card-glow:' + glow(accent) + ';--card-accent:' + accent + ';'
             + '--card-color1:' + accent + ';--card-color2:' + accent + ';--card-accent2:' + accent + ';'
             + bgStyle + '"' + (o.onclick ? ' onclick="' + o.onclick + '"' : '') + '>'
             + overlayEl + patEl + layersEl
             + '<div style="position:relative;z-index:3;">'
             +   '<div class="card-top">' + chipEl + ptsEl + '</div>'
             +   nameEl + middle
             +   '<div class="card-footer" style="gap:8px;flex-wrap:wrap;">' + rewardsBtn + footStatus + '</div>'
             + '</div></div></div>';
    }

    return { render: render, escapeHtml: esc, glow: glow,
             patternStyle: patternStyle, background: background };
})();
