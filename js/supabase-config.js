// Client Supabase — URL/clé via js/config.js (optionnel) ou valeurs par défaut ci-dessous.
(function () {
  const cfg = window.KEEPO_CONFIG || {};
  const SUPABASE_URL = cfg.SUPABASE_URL || "https://kvtsjylnwgexfywvxnwz.supabase.co";
  const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || "sb_publishable_XJoCbPawUCipKr2lunV8HA_r8XQ0rJ1";

  if (typeof supabase === "undefined") {
    console.error("KEEPO : chargez @supabase/supabase-js avant supabase-config.js");
    return;
  }

  const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true
    }
  });

  window.supabaseClient = supabaseClient;
  window.SUPABASE_URL   = SUPABASE_URL; // utile pour les Edge Functions

  // Clé PUBLIQUE VAPID (notifications push). Publique par conception : peut être
  // exposée au client sans risque. La clé PRIVÉE reste un secret serveur
  // (VAPID_PRIVATE_KEY dans les secrets Supabase). Surchargée via js/config.js.
  window.KEEPO_VAPID_PUBLIC_KEY = cfg.VAPID_PUBLIC_KEY
    || "BGU-1TBsMJohHKzZMYgRKrt0ed-_Ffi3qxl5cNOEdIGlFIPzLehi0dO5vsyDZSX-eboZSIoBE2z6Jeg_DzXqY-0";

  // ──────────────────────────────────────────────────────────────
  //  Sécurité : attache automatiquement le jeton d'authentification
  //  aux appels vers nos propres endpoints (/api/*, même origine).
  //  Le Worker exige désormais ce jeton ; ce wrapper garantit que
  //  toutes les fonctionnalités existantes (IA, campagnes, Stripe…)
  //  restent fonctionnelles SANS toucher à chaque appel fetch.
  //  Les appels vers Supabase ou des tiers ne sont pas modifiés.
  // ──────────────────────────────────────────────────────────────
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let rawUrl = "";
    try { rawUrl = typeof input === "string" ? input : (input && input.url) || ""; } catch (_) {}
    const isOwnApi = rawUrl.indexOf("/api/") === 0
      || rawUrl.indexOf(window.location.origin + "/api/") === 0;
    if (!isOwnApi) return _origFetch(input, init);

    return (async () => {
      try {
        const { data } = await supabaseClient.auth.getSession();
        const token = data && data.session && data.session.access_token;
        if (token) {
          const headers = new Headers((init && init.headers) || {});
          if (!headers.has("Authorization")) headers.set("Authorization", "Bearer " + token);
          init = Object.assign({}, init, { headers });
        }
      } catch (_) { /* fail-open : le Worker répondra 401 si le jeton manque */ }
      return _origFetch(input, init);
    })();
  };
})();
