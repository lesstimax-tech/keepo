// ════════════════════════════════════════════════════════════════
//  Keepo — Cloudflare Pages Worker (Advanced mode)
//  Intercepte /api/ai-chat → proxy Gemini Flash
//  Tout le reste → assets statiques
// ════════════════════════════════════════════════════════════════

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Tu es l'Assistant Keepo, le support officiel pour les commerçants utilisant Keepo, une plateforme de fidélité digitale française.

CONTEXTE PRODUIT :
- Les commerçants gèrent un programme de fidélité où leurs clients cumulent des points en achetant.
- Chaque commerçant a un QR Code de comptoir que ses clients scannent pour rejoindre le programme.
- Le commerçant scanne ensuite le QR Code personnel du client pour créditer des points lors d'achats.
- Les clients échangent leurs points contre des récompenses (cafés offerts, réductions, etc.).
- Pour réclamer une récompense : le client génère un code unique à 6 caractères, le commerçant le valide dans son terminal.
- Le commerçant configure : taux de conversion points (X€ = Y points), récompenses, événements multiplicateurs (×2/×3/×5 pendant une période), notifications email automatiques.
- Plans : Essential (50 membres max, fonctionnalités de base) et Pro Scale (illimité, analytics, API, export CSV).
- Sections du dashboard : Dashboard, Terminal de Scan, Mon Code QR, Récompenses, Événements, Historique, Studio Design Card, Notifications, Paramètres, Aide & Support.

TON RÔLE :
- Réponds en français, ton chaleureux mais professionnel.
- Sois CONCIS (max 4-5 phrases sauf si l'utilisateur demande un guide détaillé).
- Utilise des listes numérotées pour les procédures pas-à-pas.
- Tu peux utiliser **gras** pour les mots clés.
- Si la question concerne une fonctionnalité Pro Scale et que l'utilisateur est en Essential, mentionne-le.
- Si la question est hors sujet, redirige poliment vers l'utilisation de Keepo.
- N'invente JAMAIS de fonctionnalités qui n'existent pas.
- Si on te demande quel modèle d'IA tu utilises, réponds : "Je suis l'Assistant Keepo, un outil interne basé sur de l'IA."`;

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

async function handleAiChat(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const GEMINI_API_KEY = env.GEMINI_API_KEY || '';
  if (!GEMINI_API_KEY) {
    return jsonResponse({ error: 'GEMINI_API_KEY non configurée' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Corps de requête invalide' }, 400);
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const ctx      = body?.userContext || {};

  if (messages.length === 0) {
    return jsonResponse({ error: 'Aucun message fourni' }, 400);
  }

  const userCtx = [
    ctx.merchantName  ? `Enseigne : ${ctx.merchantName}`              : null,
    ctx.plan          ? `Plan : ${ctx.plan}`                          : null,
    ctx.pointsPerEuro ? `Taux : ${ctx.pointsPerEuro} points par euro` : null,
  ].filter(Boolean).join('\n');

  const fullSystem = userCtx
    ? `${SYSTEM_PROMPT}\n\n--- CONTEXTE UTILISATEUR ---\n${userCtx}`
    : SYSTEM_PROMPT;

  const contents = messages.map(m => ({
    role  : (m.role === 'model' || m.role === 'assistant') ? 'model' : 'user',
    parts : [{ text: String(m.content || '').slice(0, 4000) }],
  }));

  const geminiPayload = {
    systemInstruction : { parts: [{ text: fullSystem }] },
    contents,
    generationConfig  : { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 600 },
    safetySettings    : [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(geminiPayload),
    });

    if (!geminiRes.ok) {
      const errTxt = await geminiRes.text();
      return jsonResponse({ error: 'Erreur Gemini', details: errTxt.slice(0, 300) }, 502);
    }

    const data  = await geminiRes.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || "Je n'ai pas pu générer de réponse. Reformulez votre question ?";

    return jsonResponse({ reply });

  } catch (err) {
    return jsonResponse({ error: 'Erreur serveur', details: String(err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Route API : /api/ai-chat
    if (url.pathname === '/api/ai-chat') {
      return handleAiChat(request, env);
    }

    // Tout le reste → assets statiques (HTML, CSS, JS, images)
    return env.ASSETS.fetch(request);
  }
};
