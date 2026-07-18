#!/usr/bin/env node
/**
 * Génère js/config.js depuis les variables d'environnement Cloudflare Pages.
 * Build command exemple : node scripts/inject-config.js
 */
const fs = require("fs");
const path = require("path");

const url = process.env.SUPABASE_URL || process.env.KEEPO_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.KEEPO_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.log("inject-config: SUPABASE_URL / SUPABASE_ANON_KEY non définis — js/config.js inchangé.");
  process.exit(0);
}

const out = `window.KEEPO_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(url)},
  SUPABASE_ANON_KEY: ${JSON.stringify(key)}
};
`;

const target = path.join(__dirname, "..", "js", "config.js");
fs.writeFileSync(target, out, "utf8");
console.log("inject-config: écrit", target);
