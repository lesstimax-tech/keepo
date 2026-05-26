// ════════════════════════════════════════════════════════════════
//  Keepo — Cloudflare Pages Function : Proxy IA (Gemini Flash)
//  Route : /api/ai-chat  (même domaine = pas de CORS)
//  Variable d'env : GEMINI_API_KEY  (Cloudflare Pages → Settings → Variables)
// ════════════════════════════════════════════════════════════════

const GEMINI_MODEL = 'gemini-2.0-flash';
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

// Handler universel — fonctionne avec toutes les versions de Cloudflare Pages
export async function onRequest(context) {
  const { request, env } = context;

  // Seul POST est accepté
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status  : 405,
      headers : { 'Content-Type': 'application/json' }
    });
  }

  const GEMINI_API_KEY = env.GEMINI_API_KEY || '';
  if (!GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY non configurée' }), {
      status  : 500,
      headers : { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Corps de requête invalide' }), {
      status  : 400,
      headers : { 'Content-Type': 'application/json' }
    });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const ctx      = body?.userContext || {};

  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: 'Aucun message fourni' }), {
      status  : 400,
      headers : { 'Content-Type': 'application/json' }
    });
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
      return new Response(JSON.stringify({ error: 'Erreur Gemini', details: errTxt.slice(0, 300) }), {
        status  : 502,
        headers : { 'Content-Type': 'application/json' }
      });
    }

    const data  = await geminiRes.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || "Je n'ai pas pu générer de réponse. Reformulez votre question ?";

    return new Response(JSON.stringify({ reply }), {
      status  : 200,
      headers : { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Erreur serveur', details: String(err) }), {
      status  : 500,
      headers : { 'Content-Type': 'application/json' }
    });
  }
}
