// ════════════════════════════════════════════════════════════════
//  Keepo — Cloudflare Worker (Advanced mode)
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

const SUPPORT_MERCHANT_PROMPT = `Tu es l'Assistant Keepo, le support officiel pour les commerçants utilisant Keepo, une plateforme de fidélité digitale française.

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
- Si on te demande quel modèle tu utilises, réponds : "Je suis l'Assistant Keepo, un outil interne basé sur de l'IA."`;

const SUPPORT_CLIENT_PROMPT = `Tu es l'Assistant Keepo côté client. Tu aides les clients d'enseignes utilisant Keepo (programme de fidélité digital).

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

const EMAIL_WRITER_PROMPT = `Tu es un rédacteur publicitaire expert pour les commerces de proximité français utilisant Keepo (programme de fidélité).

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

const DESIGN_STUDIO_PROMPT = `Tu es directeur artistique pour Keepo (cartes de fidélité digitales).

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

  const { merchantId, merchantEmail, returnUrl } = body;
  if (!merchantId || !merchantEmail) return json({ error: 'merchantId et merchantEmail requis' }, 400);

  const priceId = env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return json({ error: 'STRIPE_PRO_PRICE_ID non configuré' }, 500);

  const successUrl = (returnUrl || 'https://keepo.lesstimax.workers.dev/dashboard-commercant') + '?stripe=success&session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl  = (returnUrl || 'https://keepo.lesstimax.workers.dev/dashboard-commercant') + '?stripe=cancel';

  const result = await stripeApi(env, 'checkout/sessions', {
    'mode'                   : 'subscription',
    'line_items[0][price]'   : priceId,
    'line_items[0][quantity]': '1',
    'customer_email'         : merchantEmail,
    'client_reference_id'    : merchantId,
    'success_url'            : successUrl,
    'cancel_url'             : cancelUrl,
    'subscription_data[metadata][merchant_id]': merchantId,
    'metadata[merchant_id]'  : merchantId,
  }, 'POST');

  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ url: result.data.url });
}

// POST /api/stripe-webhook — Stripe notifie les paiements réussis
async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  // Note : pour simplifier, on saute la vérification de signature
  // En prod il faut vérifier la signature avec env.STRIPE_WEBHOOK_SECRET
  let event;
  try { event = await request.json(); }
  catch { return json({ error: 'Webhook payload invalide' }, 400); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    const merchantId = session?.client_reference_id || session?.metadata?.merchant_id;
    const customerId = session?.customer;
    const subId      = session?.subscription;

    if (merchantId) {
      const SUPA_URL  = env.SUPABASE_URL  || 'https://kvtsjylnwgexfywvxnwz.supabase.co';
      const SUPA_KEY  = env.SUPABASE_SERVICE_ROLE;
      if (!SUPA_KEY) {
        console.error('SUPABASE_SERVICE_ROLE manquant pour webhook');
        return json({ received: true, error: 'service role missing' });
      }
      const renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const updateRes = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${merchantId}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          plan: 'pro scale',
          stripe_customer_id: customerId,
          stripe_subscription_id: subId,
          plan_renews_at: renewsAt
        })
      });
      if (!updateRes.ok) console.error('Webhook update failed', await updateRes.text());
    }
  }

  return json({ received: true });
}

// ════════════════════════════════════════════════════════════════
//  CAMPAGNES EMAIL — Feature 3
// ════════════════════════════════════════════════════════════════

async function handleSendCampaign(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Corps invalide' }, 400); }

  const { merchantId, segment, subject, emailBody } = body;
  if (!merchantId || !subject || !emailBody) return json({ error: 'Champs manquants (merchantId, subject, emailBody)' }, 400);

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
          from    : `${merchantName} <notifications@keepo.fr>`,
          to      : [profile.email],
          subject,
          text    : personalBody,
          html    : personalBody.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>'),
        })
      });
      if (r.ok) sent++; else failed++;
    } catch { failed++; }
  }

  return json({ sent, failed, total: profiles.length, merchantName });
}

// ── Décompte destinataires ──
async function handleCampaignCount(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Corps invalide' }, 400); }

  const { merchantId, segment } = body;
  if (!merchantId) return json({ error: 'merchantId requis' }, 400);

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

// ──────────── Router ────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
    }

    // Tout le reste → assets statiques
    return env.ASSETS.fetch(request);
  }
};
