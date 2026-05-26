// Client Supabase — URL/clé via js/config.js (optionnel) ou valeurs par défaut ci-dessous.
(function () {
  const cfg = window.KEEPO_CONFIG || {};
  const SUPABASE_URL = cfg.SUPABASE_URL || "https://kvtsjylnwgexfywvxnwz.supabase.co";
  const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || "sb_publishable_XJoCbPawUCipKr2lunV8HA_r8XQ0rJ1";

  if (typeof supabase === "undefined") {
    console.error("Keepo : chargez @supabase/supabase-js avant supabase-config.js");
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
})();
