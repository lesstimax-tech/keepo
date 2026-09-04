#!/usr/bin/env node
/**
 * Invite un commerçant à créer son compte KEEPO.
 *
 *   node scripts/inviter.js <email> "<Nom de l'enseigne>" [--parrain=CODE] [--test]
 *
 * L'invitation part avec les métadonnées { name, role: 'commercant' } — les
 * mêmes que celles envoyées par connexion.html. Sans elles, le déclencheur
 * handle_new_user retombe sur role = 'client' et ne génère aucun code de
 * parrainage : le compte serait à réparer à la main.
 *
 * Le mail utilise le gabarit « Invite user » de Supabase et part par votre
 * SMTP Resend, depuis notifications@keepo.eu.
 *
 * Identifiants attendus dans l'environnement, ou dans un fichier .env.local
 * à la racine du dépôt (ignoré par git via la règle .env.*) :
 *
 *   SUPABASE_URL=https://xxxxxxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE=eyJ...
 *
 * La clé service_role contourne toutes les règles RLS : elle ne doit jamais
 * être versionnée, ni quitter votre machine.
 */
const fs = require("fs");
const path = require("path");

// Node 18 minimum (fetch natif).
if (typeof fetch !== "function") {
  console.error("Node 18 ou plus récent est nécessaire (fetch natif absent).");
  process.exit(1);
}

// ── .env.local ────────────────────────────────────────
function chargerEnvLocal() {
  const fichier = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(fichier)) return;
  for (const ligne of fs.readFileSync(fichier, "utf8").split(/\r?\n/)) {
    const m = ligne.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let valeur = m[2].trim();
    const q = valeur[0];
    if ((q === '"' || q === "'") && valeur[valeur.length - 1] === q) {
      valeur = valeur.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = valeur;
  }
}
chargerEnvLocal();

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.KEEPO_SUPABASE_URL;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

// Page qui reçoit le lien d'invitation : elle gère déjà ?token_hash=&type=
// et bascule sur le formulaire de mot de passe (reset-mot-de-passe.html).
const REDIRECTION = "https://keepo.eu/reset-mot-de-passe";

// ── Arguments ─────────────────────────────────────────
const args = process.argv.slice(2);
const options = args.filter((a) => a.startsWith("--"));
const positionnels = args.filter((a) => !a.startsWith("--"));

const email = (positionnels[0] || "").trim();
const enseigne = (positionnels[1] || "").trim();
const parrain = (options.find((o) => o.startsWith("--parrain=")) || "")
  .slice("--parrain=".length)
  .trim()
  .toUpperCase();
const simulation = options.includes("--test");

function usage(message) {
  if (message) console.error("\n  " + message);
  console.error(`
  Usage :
    node scripts/inviter.js <email> "<Nom de l'enseigne>" [--parrain=CODE] [--test]

  Exemples :
    node scripts/inviter.js jean@boulangerie-martin.fr "Boulangerie Martin"
    node scripts/inviter.js contact@lecoiffeur.fr "Le Coiffeur" --parrain=A1B2C3D4
    node scripts/inviter.js jean@exemple.fr "Test" --test    (n'envoie rien)
`);
  process.exit(1);
}

if (!email) usage("Adresse e-mail manquante.");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) usage("Adresse e-mail invalide : " + email);
if (!enseigne) usage("Nom de l'enseigne manquant (il s'affiche dans le tableau de bord).");
if (parrain && !/^[A-Z0-9]{8}$/.test(parrain)) usage("Code de parrainage attendu : 8 caractères, lettres et chiffres.");
if (!SUPABASE_URL || !SERVICE_ROLE) {
  usage("SUPABASE_URL et SUPABASE_SERVICE_ROLE introuvables (environnement ou .env.local).");
}

// ── Envoi ─────────────────────────────────────────────
const metadonnees = { name: enseigne, role: "commercant" };
if (parrain) metadonnees.ref_code = parrain;

console.log("");
console.log("  Destinataire   " + email);
console.log("  Enseigne       " + enseigne);
console.log("  Rôle           commerçant");
if (parrain) console.log("  Parrain        " + parrain);
console.log("  Projet         " + SUPABASE_URL);
console.log("");

if (simulation) {
  console.log("  --test : rien n'a été envoyé.");
  console.log("  Métadonnées : " + JSON.stringify(metadonnees));
  console.log("");
  process.exit(0);
}

(async () => {
  let reponse;
  try {
    reponse = await fetch(
      SUPABASE_URL.replace(/\/+$/, "") +
        "/auth/v1/invite?redirect_to=" +
        encodeURIComponent(REDIRECTION),
      {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: "Bearer " + SERVICE_ROLE,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, data: metadonnees })
      }
    );
  } catch (e) {
    console.error("  Échec réseau : " + e.message + "\n");
    process.exit(1);
  }

  const brut = await reponse.text();
  let corps = {};
  try { corps = JSON.parse(brut); } catch { /* réponse non JSON */ }

  if (reponse.ok) {
    console.log("  Invitation envoyée.");
    console.log("  " + enseigne + " reçoit un mail « Vous êtes invité » et choisit");
    console.log("  son mot de passe sur " + REDIRECTION + ".");
    console.log("");
    console.log("  Le lien expire selon la durée réglée dans Supabase.");
    console.log("");
    return;
  }

  const message = corps.msg || corps.message || corps.error_description || corps.error || brut;

  console.error("  Échec (HTTP " + reponse.status + ") : " + message);
  if (reponse.status === 401 || reponse.status === 403) {
    console.error("  → La clé service_role semble incorrecte ou périmée.");
  } else if (reponse.status === 422) {
    console.error("  → Cette adresse a déjà un compte. Une invitation ne sert qu'aux nouveaux ;");
    console.error("    pour un compte existant, envoyez plutôt un lien de connexion.");
  } else if (reponse.status === 429) {
    console.error("  → Limite d'envoi atteinte. Patientez avant l'invitation suivante.");
  }
  console.error("");
  process.exit(1);
})();
