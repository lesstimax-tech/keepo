// ════════════════════════════════════════════════════════════════
//  KEEPO — Cloudflare Worker (Advanced mode)
//  Endpoints IA :
//    POST /api/ai-chat                  → support commerçant
//    POST /api/ai-client-chat           → support client
//    POST /api/ai-email-writer          → génère email marketing
//    POST /api/ai-reward-suggestions    → suggère récompenses
//    POST /api/ai-design-studio         → génère palette + design carte
//  Tout le reste → assets statiques
// ════════════════════════════════════════════════════════════════

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ──────────── Prompts système ────────────

const SUPPORT_MERCHANT_PROMPT = `Tu es l'Assistant KEEPO, le support officiel pour les commerçants utilisant KEEPO, une plateforme de fidélité digitale française.

CONTEXTE PRODUIT :
- Les commerçants gèrent un programme de fidélité où leurs clients cumulent des points en achetant.
- Chaque commerçant a un QR Code de comptoir que ses clients scannent pour rejoindre le programme.
- Le commerçant scanne ensuite le QR Code personnel du client pour créditer des points lors d'achats.
- Les clients échangent leurs points contre des récompenses (cafés offerts, réductions, etc.).
- Pour réclamer une récompense : le client génère un code unique à 6 caractères, le commerçant le valide dans son terminal.
- Le commerçant configure : taux de conversion points (X€ = Y points), récompenses, événements multiplicateurs (×2/×3/×5), notifications email automatiques.
- Plans : Essential (50 membres max) et Pro Scale (illimité, analytics, export CSV).

TON RÔLE :
- Réponds en français, ton chaleureux mais professionnel.
- Sois CONCIS (max 4-5 phrases sauf si guide détaillé demandé).
- Listes numérotées pour les procédures.
- **gras** pour mots clés.
- N'invente JAMAIS de fonctionnalités qui n'existent pas.
- Si on te demande quel modèle tu utilises, réponds : "Je suis l'Assistant KEEPO, un outil interne basé sur de l'IA."`;

const SUPPORT_CLIENT_PROMPT = `Tu es l'Assistant KEEPO côté client. Tu aides les clients d'enseignes utilisant KEEPO (programme de fidélité digital).

CONTEXTE :
- Le client a une carte de fidélité digitale par commerce où il scanne sa carte pour gagner des points.
- Pour cumuler des points : il montre son QR Code personnel au commerçant qui le scanne.
- Pour réclamer une récompense : il choisit une récompense, génère un code à 6 chiffres, le donne au commerçant qui valide.
- Sections de son app : Mes Cartes, Mon QR Code, Récompenses, Historique, Paramètres.

TON RÔLE :
- Français chaleureux et simple, comme un ami qui explique.
- Très concis (2-3 phrases max).
- Pas de jargon technique.
- Si question hors sujet, redirige gentiment.`;

const EMAIL_WRITER_PROMPT = `Tu es un rédacteur publicitaire expert pour les commerces de proximité français utilisant KEEPO (programme de fidélité).

Tu génères des emails marketing courts, percutants et chaleureux, destinés aux clients fidèles d'un commerce.

RÈGLES STRICTES :
- Réponds UNIQUEMENT en JSON valide, format : {"subject": "...", "body": "..."}
- Subject : max 60 caractères, accrocheur, peut contenir 1 emoji.
- Body : max 600 caractères, ton chaleureux, en français, 2-3 paragraphes courts.
- Utilise le prénom via le placeholder {{prenom}} (le système le remplacera).
- Mentionne le nom du commerce via {{enseigne}}.
- Termine par une signature simple, pas de "Cordialement".
- N'invente pas d'offres, suit ce que l'utilisateur demande.
- Pas de markdown, juste du texte plat dans body (sauts de ligne avec \\n).`;

const REWARD_SUGGEST_PROMPT = `Tu es expert en fidélisation client pour commerces de proximité français.

À partir d'une description de commerce et du taux de conversion (X points = 1€), tu proposes 5 récompenses pertinentes et progressives.

RÈGLES STRICTES :
- Réponds UNIQUEMENT en JSON valide, format : {"rewards": [{"name": "...", "points": 50}, ...]}
- 5 récompenses exactement, du moins cher (atteignable rapidement) au plus cher (objectif premium).
- "name" : court, concret, attirant (ex: "Café offert", "20% sur votre prochain achat", "Dessert maison").
- "points" : entier cohérent avec le taux (commence vers 50 pts, finit vers 1000-2000 pts).
- Adapté au type de commerce détecté.
- En français.`;

const DESIGN_STUDIO_PROMPT = `Tu es directeur artistique pour KEEPO (cartes de fidélité digitales).

À partir d'une description d'ambiance/commerce, tu génères une palette de couleurs cohérente et un texte d'accroche.

RÈGLES STRICTES :
- Réponds UNIQUEMENT en JSON valide, format : {"bgColor": "#hex", "txtColor": "#hex", "borderColor": "#hex", "tagline": "...", "rationale": "..."}
- bgColor : couleur dominante (background carte), code hex à 6 caractères.
- txtColor : texte sur fond bgColor, doit avoir un excellent contraste (sombre sur clair ou vice-versa).
- borderColor : couleur d'accent (bordure / glow), complémentaire harmonieuse.
- tagline : courte phrase d'accroche (max 8 mots), en français, sans guillemets.
- rationale : une phrase explicative (max 25 mots) sur les choix de couleurs.
- Couleurs accessibles (WCAG AA pour le contraste txt/bg).`;

// ──────────── Helpers ────────────

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

// ──────────── Sécurité : validation & authentification ────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// Vérifie le jeton Supabase (header "Authorization: Bearer <jwt>") auprès de
// l'API Auth de Supabase et renvoie l'utilisateur authentifié, ou null.
// → empêche toute requête anonyme d'atteindre les endpoints privilégiés.
async function getAuthUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length < 20) return null;

  const SUPA_URL  = env.SUPABASE_URL      || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
  const SUPA_ANON = env.SUPABASE_ANON_KEY || 'sb_publishable_XJoCbPawUCipKr2lunV8HA_r8XQ0rJ1';
  try {
    const res = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPA_ANON, 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

// Garde-fou commun : exige un utilisateur connecté et (optionnellement) que son
// id corresponde au merchantId ciblé. Renvoie { user } ou { error: Response }.
async function requireMerchant(request, env, merchantId) {
  const user = await getAuthUser(request, env);
  if (!user) return { error: json({ error: 'Authentification requise' }, 401) };
  if (merchantId !== undefined) {
    if (!isUuid(merchantId) || user.id !== merchantId) {
      return { error: json({ error: 'Accès refusé' }, 403) };
    }
  }
  return { user };
}

async function callGemini(env, { systemPrompt, contents, generationConfig = {}, jsonMode = false }) {
  const GEMINI_API_KEY = env.GEMINI_API_KEY || '';
  if (!GEMINI_API_KEY) {
    return { error: 'GEMINI_API_KEY non configurée', status: 500 };
  }

  const finalGenConfig = {
    temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 600,
    ...generationConfig
  };
  if (jsonMode) finalGenConfig.responseMimeType = 'application/json';

  const payload = {
    systemInstruction : { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig  : finalGenConfig,
    safetySettings    : [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(payload),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      console.log('Gemini error', res.status, errTxt);
      return { error: 'Erreur Gemini ' + res.status, details: errTxt.slice(0, 500), status: 502 };
    }

    const data  = await res.json();
    const text  = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (!text) {
      console.log('Gemini empty response', JSON.stringify(data).slice(0, 500));
      return { error: 'Réponse vide', details: JSON.stringify(data?.promptFeedback || data).slice(0, 300), status: 502 };
    }
    return { text };

  } catch (err) {
    return { error: 'Erreur serveur', details: String(err), status: 500 };
  }
}

// Extrait du JSON depuis une réponse Gemini (gère markdown fences ```json ... ```)
function extractJson(text) {
  let t = text.trim();
  // Retire les fences markdown
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
  // Trouve le premier { et le dernier }
  const first = t.indexOf('{');
  const last  = t.lastIndexOf('}');
  if (first === -1 || last === -1) return null;
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
}

// ──────────── Handlers ────────────

async function handleAiChat(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const auth = await requireMerchant(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const ctx      = body?.userContext || {};
  if (messages.length === 0) return json({ error: 'Aucun message' }, 400);

  const userCtx = [
    ctx.merchantName  ? `Enseigne : ${ctx.merchantName}` : null,
    ctx.plan          ? `Plan : ${ctx.plan}` : null,
    ctx.pointsPerEuro ? `Taux : ${ctx.pointsPerEuro} points par euro` : null,
  ].filter(Boolean).join('\n');

  const fullSystem = userCtx
    ? `${SUPPORT_MERCHANT_PROMPT}\n\n--- CONTEXTE UTILISATEUR ---\n${userCtx}`
    : SUPPORT_MERCHANT_PROMPT;

  const contents = messages.map(m => ({
    role  : (m.role === 'model' || m.role === 'assistant') ? 'model' : 'user',
    parts : [{ text: String(m.content || '').slice(0, 4000) }],
  }));

  const result = await callGemini(env, { systemPrompt: fullSystem, contents });
  if (result.error) return json(result, result.status);
  return json({ reply: result.text || "Je n'ai pas pu générer de réponse." });
}

async function handleClientChat(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const auth = await requireMerchant(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const ctx      = body?.userContext || {};
  if (messages.length === 0) return json({ error: 'Aucun message' }, 400);

  const userCtx = [
    ctx.clientName ? `Prénom client : ${ctx.clientName}` : null,
    ctx.cardCount  ? `Nombre de cartes actives : ${ctx.cardCount}` : null,
  ].filter(Boolean).join('\n');

  const fullSystem = userCtx
    ? `${SUPPORT_CLIENT_PROMPT}\n\n--- CONTEXTE ---\n${userCtx}`
    : SUPPORT_CLIENT_PROMPT;

  const contents = messages.map(m => ({
    role  : (m.role === 'model' || m.role === 'assistant') ? 'model' : 'user',
    parts : [{ text: String(m.content || '').slice(0, 2000) }],
  }));

  const result = await callGemini(env, {
    systemPrompt: fullSystem,
    contents,
    generationConfig: { maxOutputTokens: 400 }
  });
  if (result.error) return json(result, result.status);
  return json({ reply: result.text || "Désolé, je n'ai pas compris. Reformulez ?" });
}

async function handleEmailWriter(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const auth = await requireMerchant(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const prompt      = String(body?.prompt || '').slice(0, 1000);
  const merchantName = String(body?.merchantName || 'mon commerce').slice(0, 80);
  const emailType   = String(body?.type || 'relance').slice(0, 30);

  if (!prompt) return json({ error: 'Prompt manquant' }, 400);

  const userMsg = `Type d'email : ${emailType}
Enseigne : ${merchantName}
Demande du commerçant : ${prompt}

Génère le JSON {subject, body}.`;

  const result = await callGemini(env, {
    systemPrompt: EMAIL_WRITER_PROMPT,
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    generationConfig: { maxOutputTokens: 800, temperature: 0.85 },
    jsonMode: true
  });
  if (result.error) return json(result, result.status);

  const parsed = extractJson(result.text);
  if (!parsed?.subject || !parsed?.body) {
    return json({ error: 'Format de réponse invalide', raw: result.text }, 502);
  }
  return json({ subject: parsed.subject, body: parsed.body });
}

async function handleRewardSuggestions(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const auth = await requireMerchant(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const description   = String(body?.description || '').slice(0, 500);
  const pointsPerEuro = Number(body?.pointsPerEuro) || 1;

  if (!description) return json({ error: 'Description manquante' }, 400);

  const userMsg = `Type de commerce / ambiance : ${description}
Taux de conversion : ${pointsPerEuro} point(s) gagné(s) par euro dépensé.

Propose 5 récompenses au format JSON {rewards:[...]}.`;

  const result = await callGemini(env, {
    systemPrompt: REWARD_SUGGEST_PROMPT,
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    generationConfig: { maxOutputTokens: 800, temperature: 0.6 },
    jsonMode: true
  });
  if (result.error) return json(result, result.status);

  const parsed = extractJson(result.text);
  if (!Array.isArray(parsed?.rewards)) {
    return json({ error: 'Format invalide', raw: result.text }, 502);
  }
  // Validate
  const rewards = parsed.rewards
    .filter(r => r?.name && r?.points && Number(r.points) > 0)
    .slice(0, 5)
    .map(r => ({ name: String(r.name).slice(0, 60), points: Math.round(Number(r.points)) }));

  return json({ rewards });
}

async function handleDesignStudio(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const auth = await requireMerchant(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const description = String(body?.description || '').slice(0, 500);
  if (!description) return json({ error: 'Description manquante' }, 400);

  const userMsg = `Ambiance / commerce : ${description}

Propose une palette + tagline au format JSON {bgColor, txtColor, borderColor, tagline, rationale}.`;

  const result = await callGemini(env, {
    systemPrompt: DESIGN_STUDIO_PROMPT,
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    generationConfig: { maxOutputTokens: 500, temperature: 0.9 },
    jsonMode: true
  });
  if (result.error) return json(result, result.status);

  const parsed = extractJson(result.text);
  if (!parsed?.bgColor || !parsed?.txtColor) {
    return json({ error: 'Format invalide', raw: result.text }, 502);
  }
  // Normalize hex codes
  const isHex = s => /^#[0-9a-f]{6}$/i.test(String(s || '').trim());
  if (!isHex(parsed.bgColor) || !isHex(parsed.txtColor)) {
    return json({ error: 'Couleurs invalides', raw: result.text }, 502);
  }

  return json({
    bgColor    : parsed.bgColor.trim(),
    txtColor   : parsed.txtColor.trim(),
    borderColor: isHex(parsed.borderColor) ? parsed.borderColor.trim() : parsed.bgColor.trim(),
    tagline    : String(parsed.tagline || '').slice(0, 80),
    rationale  : String(parsed.rationale || '').slice(0, 200)
  });
}

// ════════════════════════════════════════════════════════════════
//  STRIPE BILLING — Phase 4 #14
// ════════════════════════════════════════════════════════════════

async function stripeApi(env, endpoint, params = null, method = 'GET') {
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) return { ok: false, status: 500, error: 'STRIPE_SECRET_KEY non configurée' };

  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${STRIPE_KEY}` }
  };
  if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach((x, i) => body.append(`${k}[${i}]`, x));
      else body.append(k, v);
    });
    opts.body = body.toString();
  }

  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) return { ok: false, status: res.status, error: data?.error?.message || 'Erreur Stripe' };
  return { ok: true, data };
}

// POST /api/stripe-checkout — crée une session Stripe pour passer Pro
async function handleStripeCheckout(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const { merchantId, merchantEmail, returnUrl, plan, billing } = body;
  if (!merchantId || !merchantEmail) return json({ error: 'merchantId et merchantEmail requis' }, 400);

  // Sécurité : le commerçant ne peut ouvrir un checkout que pour lui-même.
  const auth = await requireMerchant(request, env, merchantId);
  if (auth.error) return auth.error;

  const chosenPlan    = plan === 'essentiel' ? 'essentiel' : 'pro';
  const chosenBilling = billing === 'year' ? 'year' : 'month';
  const PRICE_MATRIX = {
    'essentiel:month': env.STRIPE_ESSENTIEL_PRICE_ID,
    'essentiel:year' : env.STRIPE_ESSENTIEL_YEAR_PRICE_ID,
    'pro:month'      : env.STRIPE_PRO_PRICE_ID,
    'pro:year'       : env.STRIPE_PRO_YEAR_PRICE_ID,
  };
  const priceKey = `${chosenPlan}:${chosenBilling}`;
  // .trim() : défense contre un retour-ligne/espace collé par erreur dans le
  // secret (wrangler secret put) — un 'price_xxx\n' donnerait « No such price ».
  const priceId  = (PRICE_MATRIX[priceKey] || '').trim();
  if (!priceId) return json({ error: `Tarif non configuré côté serveur (${priceKey})` }, 500);

  // Essai 14 jours offert UNIQUEMENT à la première souscription : l'éligibilité
  // se lit côté serveur (stripe_customer_id absent = jamais souscrit). Un client
  // résilié qui re-souscrit n'a pas droit à un second essai.
  let trialDays = 0;
  const SUPA_URL = env.SUPABASE_URL || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE;
  if (SUPA_KEY) {
    try {
      const pr = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${merchantId}&select=stripe_customer_id`, {
        headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
      });
      const rows = pr.ok ? await pr.json() : [];
      if (rows.length && !rows[0].stripe_customer_id) {
        trialDays = 14;
        // Parrainage : un filleul (parrainage 'pending') a droit à un essai
        // prolongé de 14 → 30 jours à sa première souscription.
        try {
          const rr = await fetch(`${SUPA_URL}/rest/v1/merchant_referrals?referred_id=eq.${merchantId}&status=eq.pending&select=id`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
          });
          const refRows = rr.ok ? await rr.json() : [];
          if (refRows.length) trialDays = 30;
        } catch { /* défaut : essai standard */ }
      }
    } catch { /* en cas de doute : pas d'essai (sécurité avant générosité) */ }
  }

  const successUrl = (returnUrl || 'https://keepo.eu/dashboard-commercant') + '?stripe=success&session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl  = (returnUrl || 'https://keepo.eu/dashboard-commercant') + '?stripe=cancel';

  const sessionParams = {
    'mode'                   : 'subscription',
    'line_items[0][price]'   : priceId,
    'line_items[0][quantity]': '1',
    // Affiche le champ « Ajouter un code promotionnel » sur la page Stripe
    // (codes de réduction / tests internes créés dans le dashboard Stripe).
    'allow_promotion_codes'  : 'true',
    'customer_email'         : merchantEmail,
    'client_reference_id'    : merchantId,
    'success_url'            : successUrl,
    'cancel_url'             : cancelUrl,
    'subscription_data[metadata][merchant_id]': merchantId,
    'subscription_data[metadata][plan]'       : chosenPlan,
    'subscription_data[metadata][billing]'    : chosenBilling,
    'metadata[merchant_id]'  : merchantId,
    'metadata[plan]'         : chosenPlan,
    'metadata[billing]'      : chosenBilling,
  };
  if (trialDays > 0) {
    sessionParams['subscription_data[trial_period_days]'] = String(trialDays);
  }
  const result = await stripeApi(env, 'checkout/sessions', sessionParams, 'POST');

  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ url: result.data.url });
}

// Vérifie la signature HMAC-SHA256 d'un webhook Stripe (anti-fraude + anti-rejeu).
async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  for (const kv of sigHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const timestamp = parts.t, expected = parts.v1;
  if (!timestamp || !expected) return false;

  // Rejette les requêtes hors de la fenêtre de tolérance (rejeu).
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(+timestamp) || Math.abs(now - +timestamp) > toleranceSec) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`));
  const computed = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

  // Comparaison à temps constant.
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// POST /api/stripe-webhook — Stripe notifie les paiements réussis
async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  // Lecture du corps BRUT (requis pour la vérification de signature).
  const rawBody = await request.text();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  // SÉCURITÉ (fail-closed) : la signature est OBLIGATOIRE. Sans secret configuré,
  // on REFUSE le webhook — sinon n'importe qui pourrait POSTer un faux événement
  // « checkout.session.completed » et s'octroyer un plan payant (fraude).
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET non configuré — webhook refusé');
    return json({ error: 'Webhook non configuré côté serveur' }, 503);
  }
  const sigHeader = request.headers.get('stripe-signature');
  const valid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!valid) {
    console.error('Signature Stripe invalide — webhook rejeté');
    return json({ error: 'Signature invalide' }, 400);
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return json({ error: 'Webhook payload invalide' }, 400); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    const merchantId = session?.client_reference_id || session?.metadata?.merchant_id;
    const customerId = session?.customer;
    const subId      = session?.subscription;

    if (merchantId && isUuid(merchantId)) {
      const SUPA_URL  = env.SUPABASE_URL  || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
      const SUPA_KEY  = env.SUPABASE_SERVICE_ROLE;
      if (!SUPA_KEY) {
        console.error('SUPABASE_SERVICE_ROLE manquant pour webhook');
        return json({ received: true, error: 'service role missing' });
      }
      const renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      // Le plan acheté voyage dans les métadonnées de la session (cf. handleStripeCheckout).
      // NB : la base utilise 'essential' (orthographe du check constraint), pas 'essentiel'.
      const paidPlan = session?.metadata?.plan === 'essentiel' ? 'essential' : 'pro scale';

      // Si l'abonnement démarre par un essai, on mémorise sa vraie date de fin
      // (badge « Essai Pro · X j restants » côté dashboard).
      let trialEndsAt = null;
      if (subId) {
        const subRes = await stripeApi(env, `subscriptions/${subId}`);
        if (subRes.ok && subRes.data?.trial_end) {
          trialEndsAt = new Date(subRes.data.trial_end * 1000).toISOString();
        }
      }
      const updateRes = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${merchantId}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          plan: paidPlan,
          stripe_customer_id: customerId,
          stripe_subscription_id: subId,
          plan_renews_at: renewsAt,
          ...(trialEndsAt ? { trial_ends_at: trialEndsAt } : {})
        })
      });
      if (!updateRes.ok) console.error('Webhook update failed', await updateRes.text());
    }
  }

  // Abonnement résilié (annulation volontaire OU échecs de paiement répétés)
  // → retour au plan limité. Le merchant_id voyage dans les métadonnées de
  // l'abonnement ; à défaut on retrouve le profil par stripe_subscription_id.
  if (event.type === 'customer.subscription.deleted') {
    const sub        = event.data?.object;
    const merchantId = sub?.metadata?.merchant_id;
    const subId      = sub?.id;
    const SUPA_URL   = env.SUPABASE_URL || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
    const SUPA_KEY   = env.SUPABASE_SERVICE_ROLE;

    if (SUPA_KEY && ((merchantId && isUuid(merchantId)) || subId)) {
      const filter = (merchantId && isUuid(merchantId))
        ? `id=eq.${merchantId}`
        : `stripe_subscription_id=eq.${encodeURIComponent(subId)}`;
      const res = await fetch(`${SUPA_URL}/rest/v1/profiles?${filter}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ plan: 'essential', stripe_subscription_id: null })
      });
      if (!res.ok) console.error('Webhook downgrade failed', await res.text());
    }
  }

  // ── PARRAINAGE : 1er vrai paiement d'un filleul → +1 mois gratuit au parrain ──
  // Se déclenche sur la 1ʳᵉ facture PAYANTE (montant > 0, donc après l'essai), et
  // une seule fois grâce à la réclamation atomique du parrainage (status=pending).
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    const invoice  = event.data?.object;
    const subId    = invoice?.subscription;
    const amount   = invoice?.amount_paid || 0;
    const SUPA_URL = env.SUPABASE_URL || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
    const SUPA_KEY = env.SUPABASE_SERVICE_ROLE;

    if (SUPA_KEY && subId && amount > 0) {
      const supaHeaders = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
      try {
        // 1) Filleul = profil abonné à cette souscription.
        const fRes = await fetch(`${SUPA_URL}/rest/v1/profiles?stripe_subscription_id=eq.${encodeURIComponent(subId)}&select=id`, { headers: supaHeaders });
        const referredId = fRes.ok ? (await fRes.json())[0]?.id : null;

        if (referredId) {
          // 2) Réclamation atomique du parrainage 'pending' → 'rewarded'
          //    (garantit une récompense unique, même sur webhook rejoué).
          const claimRes = await fetch(`${SUPA_URL}/rest/v1/merchant_referrals?referred_id=eq.${referredId}&status=eq.pending`, {
            method: 'PATCH',
            headers: { ...supaHeaders, 'Prefer': 'return=representation' },
            body: JSON.stringify({ status: 'rewarded', rewarded_at: new Date().toISOString() })
          });
          const referrerId = claimRes.ok ? (await claimRes.json())[0]?.referrer_id : null;

          if (referrerId) {
            // 3) Récompense : +30 j sur l'abonnement du parrain.
            const rRes = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${referrerId}&select=stripe_subscription_id`, { headers: supaHeaders });
            const referrerSub = rRes.ok ? (await rRes.json())[0]?.stripe_subscription_id : null;

            let newEndIso;
            if (referrerSub) {
              // On repousse la prochaine facturation de 30 j : trial_end = (fin de
              // période courante + 30 j), sans proratisation.
              const subInfo = await stripeApi(env, `subscriptions/${encodeURIComponent(referrerSub)}`);
              const base    = (subInfo.ok && subInfo.data?.current_period_end)
                ? subInfo.data.current_period_end
                : Math.floor(Date.now() / 1000);
              const newEnd  = base + 30 * 24 * 60 * 60;
              newEndIso     = new Date(newEnd * 1000).toISOString();
              const upd = await stripeApi(env, `subscriptions/${encodeURIComponent(referrerSub)}`,
                { 'trial_end': String(newEnd), 'proration_behavior': 'none' }, 'POST');
              if (!upd.ok) console.error('Parrainage: extension Stripe échouée', upd.error);
            } else {
              // Fallback (parrain sans abonnement actif) : 30 j d'accès.
              newEndIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            }
            // Reflète la nouvelle échéance côté profil (badge dashboard).
            await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${referrerId}`, {
              method: 'PATCH',
              headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ trial_ends_at: newEndIso })
            });
          }
        }
      } catch (e) { console.error('Parrainage webhook error', String(e)); }
    }
  }

  return json({ received: true });
}

// ════════════════════════════════════════════════════════════════
//  CAMPAGNES EMAIL — Feature 3
// ════════════════════════════════════════════════════════════════

// ── Expéditeur e-mail : domaine vérifié + nom du commerce en affichage ──
// Le client voit « Le Fenix » dans sa boîte mail, l'adresse technique reste
// sur le domaine vérifié Resend (sinon : 403 mode test).
function resendFromAddress(env) {
  const raw = (env.RESEND_FROM || '').trim();
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  if (raw.includes('@')) return raw;
  return 'notifications@keepo.eu';
}
function merchantSender(merchantName, env) {
  const safe = String(merchantName || 'KEEPO').replace(/["<>\r\n]/g, '').trim() || 'KEEPO';
  return `${safe} <${resendFromAddress(env)}>`;
}

// ── Gabarit e-mail aux couleurs du commerce (logo + nom) ──
function escapeHtmlMail(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function linkifyMail(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#0E7C8C;font-weight:bold;">$1</a>');
}
function buildBrandedEmailHtml({ bodyText, merchantName, merchantId, ctaUrl, ctaLabel }) {
  const safeName = escapeHtmlMail(merchantName || 'Votre commerce');
  const logoUrl  = `https://keepo.eu/logo/${merchantId}`;
  const htmlBody = String(bodyText).split(/\n\n+/)
    .map(p => `<p style="margin:0 0 12px 0;">${linkifyMail(escapeHtmlMail(p)).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const ctaBlock = ctaUrl
    ? `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 18px;"><tr><td style="border-radius:50px;background:linear-gradient(135deg,#5B3AA0,#16B8C4);background-color:#5B3AA0;">
         <a href="${ctaUrl}" style="display:inline-block;padding:14px 34px;color:#ffffff;font-weight:bold;font-size:15px;text-decoration:none;border-radius:50px;">${escapeHtmlMail(ctaLabel || 'Découvrir')}</a>
       </td></tr></table>`
    : '';
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F4F4F8;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="background:#ffffff;border-radius:18px;overflow:hidden;max-width:600px;box-shadow:0 4px 24px rgba(20,20,27,0.07);">
        <tr>
          <td style="padding:30px 36px 22px;text-align:center;border-bottom:1px solid #EFEFF4;">
            <img src="${logoUrl}" width="62" height="62" alt="${safeName}"
                 style="border-radius:16px;display:inline-block;object-fit:cover;">
            <div style="font-size:22px;font-weight:900;color:#14141B;margin-top:12px;letter-spacing:-0.3px;">${safeName}</div>
            <div style="color:#8C8A9E;font-size:11px;margin-top:3px;letter-spacing:1px;text-transform:uppercase;">Programme de fidélité</div>
          </td>
        </tr>
        <tr>
          <td style="padding:30px 36px 18px;color:#34333F;font-size:15px;line-height:1.7;">
            ${htmlBody}
            ${ctaBlock}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 36px 22px;background:#FAFAFC;font-size:11px;color:#A6A4B2;text-align:center;border-top:1px solid #EFEFF4;">
            Vous recevez cet e-mail car vous êtes membre du programme de fidélité de
            <strong style="color:#6B6A78;">${safeName}</strong>, propulsé par <a href="https://keepo.eu" style="color:#0E7C8C;text-decoration:none;font-weight:bold;">KEEPO</a>.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function handleSendCampaign(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const { merchantId, segment, subject, emailBody } = body;
  if (!merchantId || !subject || !emailBody) return json({ error: 'Champs manquants (merchantId, subject, emailBody)' }, 400);

  // Sécurité : seul le commerçant authentifié peut adresser un message à SA base clients.
  const auth = await requireMerchant(request, env, merchantId);
  if (auth.error) return auth.error;

  const RESEND_KEY = env.RESEND_API_KEY;
  if (!RESEND_KEY) return json({ error: 'RESEND_API_KEY non configuré dans wrangler' }, 500);

  const SUPA_URL = env.SUPABASE_URL || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE;
  if (!SUPA_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE manquant' }, 500);

  const supaHeaders = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` };

  // ── 1. Récupère les clients selon segment ──
  let balanceFilter = `merchant_id=eq.${merchantId}&select=client_id,lifetime_points,points_balance`;

  if (segment === 'gold')   balanceFilter += '&lifetime_points=gte.2000';
  if (segment === 'silver') balanceFilter += '&lifetime_points=gte.500&lifetime_points=lt.2000';
  if (segment === 'bronze') balanceFilter += '&lifetime_points=lt.500';

  const balRes = await fetch(`${SUPA_URL}/rest/v1/loyalty_balances?${balanceFilter}`, { headers: supaHeaders });
  if (!balRes.ok) return json({ error: 'Erreur Supabase (balances)' }, 500);
  const balances = await balRes.json();

  if (!balances.length) return json({ sent: 0, total: 0, message: 'Aucun client dans ce segment' });

  // ── 2. Segment inactifs (pas de transaction credit depuis 30j) ──
  let clientIds = balances.map(b => b.client_id);

  if (segment === 'inactive_30') {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const txRes = await fetch(
      `${SUPA_URL}/rest/v1/transactions?merchant_id=eq.${merchantId}&type=eq.credit&created_at=gte.${cutoff}&select=client_id`,
      { headers: supaHeaders }
    );
    const activeTx = txRes.ok ? await txRes.json() : [];
    const activeSet = new Set(activeTx.map(t => t.client_id));
    // Inactifs = clients qui n'ont PAS de tx récente
    const allIdsRes = await fetch(
      `${SUPA_URL}/rest/v1/loyalty_balances?merchant_id=eq.${merchantId}&select=client_id`,
      { headers: supaHeaders }
    );
    const allBalances = allIdsRes.ok ? await allIdsRes.json() : [];
    clientIds = allBalances.map(b => b.client_id).filter(id => !activeSet.has(id));
    if (!clientIds.length) return json({ sent: 0, total: 0, message: 'Aucun client inactif depuis 30 jours' });
  }

  if (segment === 'new_7') {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const newRes = await fetch(
      `${SUPA_URL}/rest/v1/loyalty_balances?merchant_id=eq.${merchantId}&created_at=gte.${cutoff}&select=client_id`,
      { headers: supaHeaders }
    );
    const newBals = newRes.ok ? await newRes.json() : [];
    clientIds = newBals.map(b => b.client_id);
    if (!clientIds.length) return json({ sent: 0, total: 0, message: 'Aucun nouveau client ces 7 derniers jours' });
  }

  // ── 3. Récupère les emails des clients ──
  const profilesRes = await fetch(
    `${SUPA_URL}/rest/v1/profiles?id=in.(${clientIds.slice(0, 500).join(',')})&select=id,email,name`,
    { headers: supaHeaders }
  );
  if (!profilesRes.ok) return json({ error: 'Erreur Supabase (profiles)' }, 500);
  const profiles = await profilesRes.json();

  // ── 4. Nom du commerce ──
  const mcRes = await fetch(
    `${SUPA_URL}/rest/v1/merchant_cards?merchant_id=eq.${merchantId}&select=title`,
    { headers: supaHeaders }
  );
  const mcData = mcRes.ok ? await mcRes.json() : [];
  const merchantName = mcData[0]?.title || 'Votre commerce';

  // ── 5. Envoi via Resend ──
  let sent = 0, failed = 0;
  const errors = [];

  for (const profile of profiles) {
    if (!profile.email) continue;

    const firstName = (profile.name || '').split(' ')[0] || 'cher client';
    const personalBody = emailBody
      .replace(/\{\{prenom\}\}/gi, firstName)
      .replace(/\{\{enseigne\}\}/gi, merchantName);

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from    : merchantSender(merchantName, env),
          to      : [profile.email],
          subject,
          text    : personalBody,
          html    : buildBrandedEmailHtml({ bodyText: personalBody, merchantName, merchantId }),
        })
      });
      if (r.ok) {
        sent++;
      } else {
        const errJson = await r.json().catch(() => ({}));
        errors.push(`${profile.email}: [${r.status}] ${errJson.message || errJson.name || JSON.stringify(errJson)}`);
        failed++;
      }
    } catch(e) {
      errors.push(`${profile.email}: ${e.message}`);
      failed++;
    }
  }

  return json({ sent, failed, total: profiles.length, merchantName, errors });
}

// ── Logo public d'un commerçant (avatar du profil, décodé du base64) ──
async function handleMerchantLogo(request, env, url) {
  const merchantId = url.pathname.slice('/logo/'.length).split('/')[0];
  const fallback = () => Response.redirect(new URL('/img/icon-192.png', url.origin).toString(), 302);
  if (!isUuid(merchantId)) return fallback();

  const SUPA_URL = env.SUPABASE_URL || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE;
  if (!SUPA_KEY) return fallback();

  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${merchantId}&select=avatar_url`, {
      headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
    });
    const rows = res.ok ? await res.json() : [];
    const dataUrl = rows[0]?.avatar_url || '';
    const m = dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
    if (!m) return fallback();

    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, {
      headers: {
        'Content-Type': m[1],
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch {
    return fallback();
  }
}

// ── Décompte destinataires ──
// ── Géocodage d'adresse (OpenStreetMap / Nominatim, gratuit, sans clé) ──
// Le commerçant saisit son adresse → on récupère lat/lng pour l'afficher dans
// « Découvrir » côté client. Proxifié côté serveur (User-Agent conforme à la
// politique Nominatim) et réservé aux commerçants connectés (anti-abus).
async function handleGeocode(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Authentification requise' }, 401);

  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (q.length < 4) return json({ error: 'Adresse trop courte' }, 400);

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'KEEPO/1.0 (https://keepo.eu; contact@keepo.eu)', 'Accept': 'application/json' } }
    );
    if (!r.ok) return json({ error: 'Service de localisation indisponible' }, 502);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return json({ found: false });
    const hit = arr[0];
    return json({ found: true, lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name || '' });
  } catch {
    return json({ error: 'Erreur de localisation' }, 502);
  }
}

// ── Suppression de compte (RGPD : droit à l'effacement) ──
// L'utilisateur ne peut supprimer QUE son propre compte : l'id provient du
// JWT vérifié, jamais du corps de requête. La cascade SQL efface ensuite tout
// ce qui lui est rattaché (cartes, points, transactions, récompenses…). Un
// abonnement Stripe actif est annulé avant, pour ne plus jamais le facturer.
async function handleDeleteAccount(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Authentification requise' }, 401);
  const userId = user.id;

  const SUPA_URL = env.SUPABASE_URL || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE;
  if (!SUPA_KEY) return json({ error: 'Service indisponible' }, 500);

  const supaHeaders = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` };

  // 1. Annule l'abonnement Stripe s'il existe (sinon facturation continue).
  try {
    const pr = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${userId}&select=stripe_subscription_id`, { headers: supaHeaders });
    const rows = pr.ok ? await pr.json() : [];
    const subId = rows[0]?.stripe_subscription_id;
    if (subId && env.STRIPE_SECRET_KEY) {
      await stripeApi(env, `subscriptions/${encodeURIComponent(subId)}`, null, 'DELETE');
    }
  } catch (_) { /* on supprime quand même : le droit à l'effacement prime */ }

  // 2. Supprime l'utilisateur Auth → cascade SQL sur profiles + tout le reste.
  const delRes = await fetch(`${SUPA_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: supaHeaders
  });
  if (!delRes.ok) {
    console.error('Delete account failed', await delRes.text().catch(() => ''));
    return json({ error: 'La suppression a échoué. Réessayez ou contactez le support.' }, 500);
  }

  return json({ deleted: true });
}

async function handleCampaignCount(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Corps invalide' }, 400); }

  const { merchantId, segment } = body;
  if (!merchantId) return json({ error: 'merchantId requis' }, 400);

  // Sécurité : décompte réservé au commerçant authentifié, pour sa propre base.
  const auth = await requireMerchant(request, env, merchantId);
  if (auth.error) return auth.error;

  const SUPA_URL = env.SUPABASE_URL || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
  const SUPA_KEY = env.SUPABASE_SERVICE_ROLE;
  if (!SUPA_KEY) return json({ count: 0 });

  const supaHeaders = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` };

  let filter = `merchant_id=eq.${merchantId}`;
  if (segment === 'gold')   filter += '&lifetime_points=gte.2000';
  if (segment === 'silver') filter += '&lifetime_points=gte.500&lifetime_points=lt.2000';
  if (segment === 'bronze') filter += '&lifetime_points=lt.500';

  const res = await fetch(`${SUPA_URL}/rest/v1/loyalty_balances?${filter}&select=client_id`, {
    headers: { ...supaHeaders, 'Prefer': 'count=exact' }
  });
  const count = parseInt(res.headers.get('Content-Range')?.split('/')[1] || '0', 10);
  return json({ count });
}

// ════════════════════════════════════════════════════════════════
//  PAGE PUBLIQUE COMMERÇANT — /c/:slug
// ════════════════════════════════════════════════════════════════

const MERCHANT_PAGE_PROMPT = `Tu es un rédacteur marketing expert en fidélisation pour commerces de proximité français.
À partir du nom et de l'adresse d'un commerce utilisant KEEPO (programme de fidélité digital), rédige une accroche courte et chaleureuse (2-3 phrases, 70-100 mots max) pour leur page publique de fidélité.
Ton accueillant, convivial, pas de jargon. En français. Réponds UNIQUEMENT avec le texte, sans guillemets ni formatage.`;

function escH(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function hexToRgb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : '0,232,204';
}

function renderMerchantPage({ card, rewards, description, merchantId }) {
  const name    = card.title || 'Commerce';
  const initial = name.charAt(0).toUpperCase();
  const accent  = card.color || '#00e8cc';
  const rgb     = hexToRgb(accent);
  const address = card.address || '';
  const rate    = parseFloat(card.points_per_euro) || 0.1;
  const rateLabel = rate >= 1
    ? `${Math.round(rate)} point${Math.round(rate) > 1 ? 's' : ''} par euro`
    : `1 point pour chaque ${Math.round(1 / rate)}€`;

  const rewardsHtml = rewards.length ? `
    <div class="section">
      <p class="section-label">VOS RÉCOMPENSES</p>
      <div class="rewards-list">
        ${rewards.map(r => `
          <div class="reward-row">
            <span class="reward-name">${escH(r.name)}</span>
            <span class="reward-badge">${r.points_required} pts</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  const desc = description
    || `Rejoignez le programme de fidélité de ${escH(name)} et gagnez des points à chaque visite !`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escH(name)} · Programme de fidélité KEEPO</title>
  <link rel="icon" href="/favicon.png">
  <meta property="og:title" content="${escH(name)} — Programme fidélité">
  <meta property="og:description" content="${escH(desc)}">
  <meta name="theme-color" content="${escH(accent)}">
  <link href="https://fonts.googleapis.com/css2?family=Cabinet+Grotesk:wght@700;800;900&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    :root { --a: ${accent}; --rgb: ${rgb}; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { height: 100%; }
    body {
      min-height: 100dvh; background: #080613; color: #f0eeff;
      font-family: 'DM Sans', sans-serif;
      display: flex; flex-direction: column; align-items: center;
    }
    body::before {
      content: ''; position: fixed; inset: 0; z-index: 0;
      background: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(${rgb},.20) 0%, transparent 65%);
      pointer-events: none;
    }
    .wrap {
      position: relative; z-index: 1; width: 100%; max-width: 480px;
      padding-bottom: 56px; display: flex; flex-direction: column; flex: 1;
    }
    /* top bar */
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 20px 20px 0; }
    .logo { font-family: 'Cabinet Grotesk', sans-serif; font-weight: 900; font-size: 19px;
            color: var(--a); text-decoration: none; letter-spacing: -.5px; }
    .member-link { font-size: 12px; color: rgba(240,238,255,.4); text-decoration: none; transition: color .2s; }
    .member-link:hover { color: var(--a); }
    /* hero */
    .hero { padding: 40px 24px 28px; display: flex; flex-direction: column; align-items: center; text-align: center; }
    .avatar {
      width: 88px; height: 88px; border-radius: 26px; margin-bottom: 22px;
      background: linear-gradient(135deg, rgba(${rgb},.22), rgba(${rgb},.07));
      border: 2px solid rgba(${rgb},.35);
      box-shadow: 0 0 44px rgba(${rgb},.22);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Cabinet Grotesk', sans-serif; font-weight: 900; font-size: 42px; color: var(--a);
    }
    .merchant-name {
      font-family: 'Cabinet Grotesk', sans-serif; font-weight: 900; font-size: 30px;
      line-height: 1.1; color: #fff; margin-bottom: 8px;
    }
    .merchant-addr { font-size: 13px; color: rgba(240,238,255,.4); margin-bottom: 18px; }
    .merchant-addr i { font-size: 10px; margin-right: 4px; }
    .merchant-desc { font-size: 14px; line-height: 1.75; color: rgba(240,238,255,.65); max-width: 360px; }
    /* program banner */
    .program-banner {
      margin: 4px 16px 4px;
      background: linear-gradient(135deg, rgba(${rgb},.10), rgba(${rgb},.04));
      border: 1px solid rgba(${rgb},.2); border-radius: 18px; padding: 18px 20px;
      display: flex; align-items: center; gap: 14px;
    }
    .program-icon {
      width: 46px; height: 46px; border-radius: 14px; flex-shrink: 0;
      background: rgba(${rgb},.15); display: flex; align-items: center; justify-content: center;
      font-size: 20px; color: var(--a);
    }
    .program-big { font-family: 'Cabinet Grotesk', sans-serif; font-weight: 800; font-size: 17px; color: #fff; }
    .program-sub { font-size: 12px; color: rgba(240,238,255,.45); margin-top: 3px; }
    /* section */
    .section { padding: 20px 16px 4px; }
    .section-label {
      font-size: 10px; font-weight: 700; letter-spacing: 1px;
      color: rgba(240,238,255,.35); margin-bottom: 12px; font-family: 'Cabinet Grotesk', sans-serif;
    }
    /* rewards */
    .rewards-list { display: flex; flex-direction: column; gap: 8px; }
    .reward-row {
      display: flex; align-items: center; justify-content: space-between;
      background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
      border-radius: 14px; padding: 14px 16px;
    }
    .reward-name { font-weight: 600; font-size: 14px; color: #f0eeff; }
    .reward-badge {
      font-family: 'Cabinet Grotesk', sans-serif; font-weight: 800; font-size: 13px;
      color: var(--a); background: rgba(${rgb},.12); padding: 4px 10px; border-radius: 20px;
    }
    /* cta */
    .cta { padding: 28px 16px 12px; display: flex; flex-direction: column; gap: 10px; }
    .btn-join {
      display: block; text-align: center; text-decoration: none;
      background: var(--a); color: #060413;
      font-family: 'Cabinet Grotesk', sans-serif; font-weight: 800; font-size: 16px;
      padding: 17px 24px; border-radius: 16px; transition: opacity .2s, transform .12s;
    }
    .btn-join:hover { opacity: .9; transform: translateY(-1px); }
    .btn-join:active { opacity: .8; transform: none; }
    .btn-member {
      display: block; text-align: center; text-decoration: none;
      font-size: 13px; color: rgba(240,238,255,.38); padding: 10px; transition: color .2s;
    }
    .btn-member:hover { color: rgba(240,238,255,.65); }
    /* footer */
    .footer { margin-top: auto; padding: 32px 0 0; text-align: center; }
    .footer a { font-size: 12px; color: rgba(240,238,255,.18); text-decoration: none; transition: color .2s; }
    .footer a span { font-family: 'Cabinet Grotesk', sans-serif; font-weight: 900; }
    .footer a:hover { color: var(--a); }
    .footer-legal { margin-top: 14px; display: flex; gap: 18px; justify-content: center; flex-wrap: wrap; }
    .footer-legal a { font-size: 11px; color: rgba(240,238,255,.28); }
    :focus-visible { outline: 2px solid var(--a); outline-offset: 2px; border-radius: 6px; }
    a:focus:not(:focus-visible) { outline: none; }
    ::selection { background: rgba(var(--rgb), 0.30); color: #fff; }
    a { -webkit-tap-highlight-color: transparent; }
    .btn-join:active, .btn-member:active { transform: translateY(1px) scale(0.99); }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; } }
  </style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="/" class="logo">KEEPO</a>
    <a href="/dashboard-client" class="member-link"><i class="fa-solid fa-user"></i>&nbsp;Déjà membre</a>
  </div>

  <div class="hero">
    <div class="avatar">${escH(initial)}</div>
    <h1 class="merchant-name">${escH(name)}</h1>
    ${address ? `<p class="merchant-addr"><i class="fa-solid fa-location-dot"></i>${escH(address)}</p>` : ''}
    <p class="merchant-desc">${escH(desc)}</p>
  </div>

  <div class="program-banner">
    <div class="program-icon"><i class="fa-solid fa-star"></i></div>
    <div>
      <div class="program-big">${escH(rateLabel)}</div>
      <div class="program-sub">Cumulez des points à chaque achat</div>
    </div>
  </div>

  ${rewardsHtml}

  <div class="cta">
    <a href="/dashboard-client?join=${escH(merchantId)}" class="btn-join">
      <i class="fa-solid fa-heart" style="margin-right:8px;"></i>Rejoindre le programme
    </a>
    <a href="/dashboard-client" class="btn-member">Déjà membre · Voir mes points →</a>
  </div>

  <div class="footer">
    <a href="/"><span>KEEPO</span> — Programme de fidélité digital</a>
    <div class="footer-legal">
      <a href="/mentions-legales.html">Mentions légales</a>
      <a href="/confidentialite.html">Confidentialité</a>
      <a href="/cgu-cgv.html">CGU</a>
    </div>
  </div>
</div>
</body>
</html>`;
}

function notFoundPage() {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Page introuvable · KEEPO</title>
<style>body{min-height:100vh;background:#080613;color:#f0eeff;font-family:sans-serif;
display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;text-align:center;padding:24px;}
h2{font-size:22px;}p{color:rgba(240,238,255,.5);font-size:14px;}a{color:#00e8cc;text-decoration:none;}</style>
</head><body>
<h2>Page introuvable</h2>
<p>Ce commerce n'a pas encore configuré sa page publique.</p>
<a href="/">Retour à l'accueil</a>
</body></html>`;
}

async function handleMerchantPage(request, env, url) {
  const slug = url.pathname.slice(3).split('/')[0]; // extract slug, ignore trailing parts
  if (!slug || slug.length < 2) {
    return new Response(notFoundPage(), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const SUPA_URL  = env.SUPABASE_URL  || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
  const SUPA_ANON = env.SUPABASE_ANON_KEY || 'sb_publishable_XJoCbPawUCipKr2lunV8HA_r8XQ0rJ1';
  const headers   = { 'apikey': SUPA_ANON, 'Authorization': `Bearer ${SUPA_ANON}` };

  const [cardRes, ] = await Promise.all([
    fetch(`${SUPA_URL}/rest/v1/merchant_cards?slug=eq.${encodeURIComponent(slug)}&select=merchant_id,title,color,address,points_per_euro,studio_json&limit=1`,
      { headers })
  ]);

  const cards = cardRes.ok ? await cardRes.json() : [];
  if (!cards.length) {
    return new Response(notFoundPage(), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const card       = cards[0];
  const merchantId = card.merchant_id;

  // Fetch rewards (public) in parallel with AI description
  const rewardsPromise = fetch(
    `${SUPA_URL}/rest/v1/rewards?merchant_id=eq.${merchantId}&select=name,points_required&order=points_required.asc&limit=8`,
    { headers }
  ).then(r => r.ok ? r.json() : []).catch(() => []);

  const descPromise = (async () => {
    if (!env.GEMINI_API_KEY) return '';
    const prompt = `Commerce : "${card.title}"${card.address ? `, situé à ${card.address}` : ''}.`;
    const result = await callGemini(env, {
      systemPrompt: MERCHANT_PAGE_PROMPT,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.82 }
    });
    return result.error ? '' : (result.text || '');
  })();

  const [rewards, description] = await Promise.all([rewardsPromise, descPromise]);

  const html = renderMerchantPage({ card, rewards, description, merchantId });
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' }
  });
}

// ──────────── Router ────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Dynamic route: public merchant page
    if (url.pathname.startsWith('/c/') && url.pathname.length > 3) {
      return handleMerchantPage(request, env, url);
    }

    // Logo public d'un commerçant (utilisé dans les e-mails : Gmail bloque
    // les images base64, il faut une URL servie en HTTP).
    if (url.pathname.startsWith('/logo/')) {
      return handleMerchantLogo(request, env, url);
    }

    switch (url.pathname) {
      case '/api/ai-chat':                 return handleAiChat(request, env);
      case '/api/ai-client-chat':          return handleClientChat(request, env);
      case '/api/ai-email-writer':         return handleEmailWriter(request, env);
      case '/api/ai-reward-suggestions':   return handleRewardSuggestions(request, env);
      case '/api/ai-design-studio':        return handleDesignStudio(request, env);
      case '/api/stripe-checkout':         return handleStripeCheckout(request, env);
      case '/api/stripe-webhook':          return handleStripeWebhook(request, env);
      case '/api/send-campaign':           return handleSendCampaign(request, env);
      case '/api/campaign-count':          return handleCampaignCount(request, env);
      case '/api/delete-account':          return handleDeleteAccount(request, env);
      case '/api/geocode':                 return handleGeocode(request, env);
    }

    // Tout le reste → assets statiques
    return env.ASSETS.fetch(request);
  }
};
