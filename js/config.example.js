// Copiez ce fichier en js/config.js et adaptez pour chaque environnement.
// Sur Cloudflare Pages, vous pouvez aussi générer config.js au build depuis les variables d'environnement.
window.KEEPO_CONFIG = {
  SUPABASE_URL: "https://votre-projet.supabase.co",
  SUPABASE_ANON_KEY: "votre-cle-anon",
  // Clé PUBLIQUE VAPID pour les notifications push (sans danger côté client).
  // Générez la paire avec openssl/web-push ; la clé PRIVÉE reste un secret serveur.
  VAPID_PUBLIC_KEY: "votre-cle-publique-vapid"
};
