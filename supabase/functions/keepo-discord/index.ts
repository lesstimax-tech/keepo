// ════════════════════════════════════════════════════════════════
//  KEEPO — Edge Function : Envoi vers Discord
// ════════════════════════════════════════════════════════════════
//
//  Un seul point d'entrée pour tout ce que KEEPO raconte sur Discord.
//  Le format des messages vit donc à UN endroit : le jour où on change
//  l'allure d'une carte, on la change ici et nulle part ailleurs.
//
//  Déploiement :
//    supabase functions deploy keepo-discord --no-verify-jwt
//
//  Secrets requis (un par salon — créez le webhook dans Discord :
//  Paramètres du salon → Intégrations → Webhooks → Nouveau webhook) :
//    supabase secrets set DISCORD_ERREURS=https://discord.com/api/webhooks/...
//    supabase secrets set DISCORD_INSCRIPTIONS=https://discord.com/api/webhooks/...
//    supabase secrets set DISCORD_QUOTIDIEN=https://discord.com/api/webhooks/...
//    supabase secrets set DISCORD_PAIEMENTS=https://discord.com/api/webhooks/...
//
//  Une URL de webhook est un mot de passe : qui l'a peut écrire dans le
//  salon. Elle ne doit jamais entrer dans le dépôt.
//
//  Jeton du relais Cloudflare (voir le garde-fou dans le code) :
//    supabase secrets set KEEPO_RELAI_TOKEN=<meme valeur que chez Cloudflare>
//
//  Appel (serveur uniquement — KEEPO_RELAI_TOKEN ou le service role) :
//    POST { salon: 'erreurs'|'inscriptions'|'quotidien'|'paiements',
//           titre: string,
//           texte?: string,
//           champs?: { nom: string, valeur: string, ligne?: boolean }[],
//           url?: string,
//           couleur?: number }
//
//  Réponse : { envoye: boolean, salon, raison? }
//
//  Le salon manquant n'est PAS une erreur : tant que le webhook n'est pas
//  créé, la fonction répond « salon non configuré » sans rien casser chez
//  l'appelant. Une notification qui échoue ne doit jamais faire tomber
//  l'action qu'elle raconte.
// ════════════════════════════════════════════════════════════════

// deno-lint-ignore-file
/// <reference lib="deno.ns" />

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
/* Le jeton du Worker : voir le garde-fou plus bas. */
const RELAI_TOKEN      = Deno.env.get('KEEPO_RELAI_TOKEN') ?? '';

/* Le nom du salon ne sert qu'à choisir un secret : on ne construit jamais
   une URL à partir de ce que l'appelant envoie. */
const SALONS: Record<string, { secret: string; couleur: number; pastille: string }> = {
  erreurs:      { secret: 'DISCORD_ERREURS',      couleur: 0xE0554A, pastille: '🔴' },
  inscriptions: { secret: 'DISCORD_INSCRIPTIONS', couleur: 0x2FC2C5, pastille: '🎉' },
  quotidien:    { secret: 'DISCORD_QUOTIDIEN',    couleur: 0x7B5BD6, pastille: '📊' },
  paiements:    { secret: 'DISCORD_PAIEMENTS',    couleur: 0x3BA55D, pastille: '💳' },
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });

/* Discord coupe brutalement au-delà de ses limites : on tronque proprement
   avant, sinon un message trop long part à la poubelle en entier. */
const couper = (v: unknown, max: number) => {
  const s = String(v ?? '').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
};

async function poster(url: string, charge: unknown): Promise<Response> {
  const envoi = () => fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(charge),
  });

  let r = await envoi();

  /* Discord accepte environ 5 messages par 2 secondes et par webhook. Au
     rythme de KEEPO on n'y touche jamais, sauf le jour où une boucle
     s'emballe — et ce jour-là, c'est justement le message d'erreur qu'on
     ne veut pas perdre. Il indique combien de temps attendre : on attend. */
  if (r.status === 429) {
    let attente = 1.5;
    try { attente = Number((await r.clone().json())?.retry_after ?? 1.5); } catch { /* corps illisible */ }
    await new Promise((r2) => setTimeout(r2, Math.min(attente * 1000 + 250, 6000)));
    r = await envoi();
  }
  return r;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'Méthode non autorisée' }, 405);

  /* Garde-fou : appel serveur uniquement.

     Deux jetons acceptés, et c'est voulu.

     Les appelants qui vivent DANS Supabase — pg_cron, déclencheurs, autres
     fonctions — ont le service role sous la main, injecté par la plateforme.

     Le Worker, lui, vit chez Cloudflare : sa copie du service role est un
     ancien JWT, encore valide pour la base mais différent de celui que la
     plateforme injecte ici depuis la migration des clés. Les aligner
     casserait le reste du Worker. On lui donne donc son propre jeton, qui
     ne dépend d'aucune migration — et qui, au passage, ne porte aucun
     privilège sur la base : poster dans un salon Discord n'a pas besoin
     d'une clé qui peut tout lire. */
  const authHeader = req.headers.get('Authorization') || '';
  const jetons = [RELAI_TOKEN, SERVICE_ROLE_KEY].filter(Boolean);
  if (!jetons.some((j) => authHeader === `Bearer ${j}`)) {
    return json({ error: 'Non autorisé' }, 401);
  }

  let corps: any;
  try { corps = await req.json(); }
  catch { return json({ error: 'Corps JSON illisible' }, 400); }

  const salon = SALONS[String(corps?.salon ?? '')];
  if (!salon) return json({ error: 'Salon inconnu' }, 400);

  const webhook = Deno.env.get(salon.secret) ?? '';
  if (!webhook) {
    // Pas encore branché : on le dit, on ne casse rien.
    return json({ envoye: false, salon: corps.salon, raison: 'salon non configuré' });
  }

  const titre = couper(corps?.titre, 240);
  if (!titre) return json({ error: 'Titre manquant' }, 400);

  const champs = Array.isArray(corps?.champs)
    ? corps.champs.slice(0, 25).map((c: any) => ({
        name:   couper(c?.nom,    256) || '—',
        value:  couper(c?.valeur, 1024) || '—',
        inline: c?.ligne !== false,
      }))
    : undefined;

  const embed: Record<string, unknown> = {
    title:       salon.pastille + '  ' + titre,
    color:       Number.isInteger(corps?.couleur) ? corps.couleur : salon.couleur,
    timestamp:   new Date().toISOString(),
    footer:      { text: 'KEEPO' },
  };
  const texte = couper(corps?.texte, 4000);
  if (texte)  embed.description = texte;
  if (champs && champs.length) embed.fields = champs;
  /* On n'accepte que nos propres liens : un lien arbitraire dans un embed,
     c'est une porte ouverte à l'hameçonnage si la source est compromise. */
  const lien = couper(corps?.url, 400);
  if (lien && /^https:\/\/([a-z0-9-]+\.)*keepo\.eu(\/|$)/i.test(lien)) embed.url = lien;

  try {
    const r = await poster(webhook, { embeds: [embed] });
    if (!r.ok) {
      const detail = couper(await r.text().catch(() => ''), 300);
      return json({ envoye: false, salon: corps.salon, raison: `Discord ${r.status} ${detail}` });
    }
    return json({ envoye: true, salon: corps.salon });
  } catch (e: any) {
    return json({ envoye: false, salon: corps.salon, raison: String(e?.message ?? e) });
  }
});
