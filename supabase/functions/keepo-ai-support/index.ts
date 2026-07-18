// ════════════════════════════════════════════════════════════════
//  KEEPO — Edge Function : Assistant IA Support (Gemini Flash)
// ════════════════════════════════════════════════════════════════
//
//  Déploiement :
//    1. Installez Supabase CLI : https://supabase.com/docs/guides/cli
//    2. Connectez-vous : `supabase login`
//    3. Liez votre projet : `supabase link --project-ref <YOUR_PROJECT_REF>`
//    4. Récupérez une clé Gemini gratuite : https://aistudio.google.com/app/apikey
//    5. Stockez-la comme secret :
//         `supabase secrets set GEMINI_API_KEY=AIza...`
//    6. Déployez :
//         `supabase functions deploy KEEPO-ai-support --no-verify-jwt`
//
//  La clé GEMINI_API_KEY reste côté serveur, jamais exposée au client.
// ════════════════════════════════════════════════════════════════

// deno-lint-ignore-file
/// <reference lib="deno.ns" />

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_MODEL   = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// CORS — autorise les appels depuis votre frontend
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Prompt système — définit la personnalité et les limites de l'assistant
const SYSTEM_PROMPT = `Tu es l'Assistant KEEPO, le support officiel pour les commerçants utilisant KEEPO, une plateforme de fidélité digitale française.

CONTEXTE PRODUIT :
- Les commerçants gèrent un programme de fidélité où leurs clients cumulent des points en achetant.
- Chaque commerçant a un QR Code de comptoir que ses clients scannent pour rejoindre le programme.
- Le commerçant scanne ensuite le QR Code personnel du client pour créditer des points lors d'achats.
- Les clients échangent leurs points contre des récompenses (cafés offerts, réductions, etc.).
- Pour réclamer une récompense : le client génère un code unique à 6 caractères côté son app, le commerçant le valide dans son terminal.
- Le commerçant configure : taux de conversion points (X€ = Y points), récompenses, événements multiplicateurs (×2/×3/×5 pendant une période), notifications email automatiques (relance, avis Google, événements).
- Plans : Essential (50 membres max, fonctionnalités de base) et Pro Scale (illimité, analytics, API, export CSV).
- Sections du dashboard : Dashboard, Terminal de Scan, Mon Code QR, Récompenses, Événements, Historique, Studio Design Card, Notifications, Paramètres, Aide & Support.

TON RÔLE :
- Réponds en français, ton chaleureux mais professionnel.
- Sois CONCIS (max 4-5 phrases sauf si l'utilisateur demande un guide détaillé).
- Utilise des listes numérotées pour les procédures pas-à-pas.
- Tu peux utiliser **gras** pour les mots clés et \`code\` pour les noms de boutons/sections.
- Si la question concerne une fonctionnalité Pro Scale et que l'utilisateur est en Essential, mentionne-le.
- Si la question est hors sujet (politique, médical, code informatique étranger à KEEPO), redirige poliment vers l'utilisation de KEEPO.
- N'invente JAMAIS de fonctionnalités qui n'existent pas. En cas de doute, suggère "Ouvrir un ticket" pour le support humain.
- Si on te demande quel modèle d'IA tu utilises, réponds : "Je suis l'Assistant KEEPO, un outil interne basé sur de l'IA."`;

Deno.serve(async (req) => {
  // Préflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!GEMINI_API_KEY) {
    return new Response(JSON.stringify({
      error: 'GEMINI_API_KEY non configurée. Ajoutez-la dans les secrets Supabase.'
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const ctx = body?.userContext || {};

    if (messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Aucun message fourni' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Construction du contexte utilisateur ajouté au system prompt
    const userCtx = [
      ctx.merchantName ? `Enseigne actuelle : ${ctx.merchantName}` : null,
      ctx.plan         ? `Plan : ${ctx.plan}` : null,
      ctx.pointsPerEuro ? `Taux configuré : ${ctx.pointsPerEuro} points par euro dépensé` : null,
    ].filter(Boolean).join('\n');

    const fullSystem = userCtx
      ? `${SYSTEM_PROMPT}\n\n--- CONTEXTE UTILISATEUR ---\n${userCtx}`
      : SYSTEM_PROMPT;

    // Conversion au format Gemini
    // Gemini attend des contents : [{role:'user'|'model', parts:[{text}]}]
    const contents = messages.map((m: any) => ({
      role: m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '').slice(0, 4000) }],
    }));

    const geminiPayload = {
      systemInstruction: { parts: [{ text: fullSystem }] },
      contents,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 600,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload),
    });

    if (!geminiRes.ok) {
      const errTxt = await geminiRes.text();
      console.error('Gemini error:', geminiRes.status, errTxt);
      return new Response(JSON.stringify({
        error: 'Erreur de communication avec le moteur IA',
        details: errTxt.substring(0, 300),
      }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const geminiData = await geminiRes.json();
    const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || "Je n'ai pas pu générer de réponse. Reformulez votre question ?";

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Edge fn error:', err);
    return new Response(JSON.stringify({ error: 'Erreur serveur', details: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
