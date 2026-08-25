// ════════════════════════════════════════════════════════════════
//  KEEPO — Edge Function : Envoi d'e-mails via Resend
// ════════════════════════════════════════════════════════════════
//
//  Déploiement :
//    1. Obtenez une clé API Resend : https://resend.com
//    2. Vérifiez votre domaine KEEPO.app dans Resend (ou utilisez
//       onboarding@resend.dev pour les tests sans vérification)
//    3. Stockez les secrets :
//         supabase secrets set RESEND_API_KEY=re_...
//    4. Déployez :
//         supabase functions deploy KEEPO-send-email --no-verify-jwt
//
//  Corps de la requête POST :
//    {
//      automation_id?: number,
//      merchant_id: string,
//      merchant_name: string,
//      recipients: [{ email: string, name: string, client_id?: string }],
//      subject: string,
//      body_template: string,
//      is_test?: boolean
//    }
//
//  Réponse :
//    { sent: number, failed: number, errors: string[] }
// ════════════════════════════════════════════════════════════════

// deno-lint-ignore-file
/// <reference lib="deno.ns" />

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Expéditeur configurable : définissez le secret RESEND_FROM une fois votre
// domaine vérifié dans Resend. Sans domaine vérifié, on retombe sur l'adresse
// de test Resend (onboarding@resend.dev) — utile pour valider le pipeline.
const FROM_EMAIL       = Deno.env.get('RESEND_FROM') ?? 'KEEPO <onboarding@resend.dev>';

// Reprend l'adresse configurée mais remplace le nom affiché par celui du
// commerce : « Le Bistrot de Marie <contact@keepo.eu> ».
function expediteurCommercant(enseigne: string): string {
  const adresse = FROM_EMAIL.match(/<([^>]+)>/)?.[1] ?? FROM_EMAIL;
  const nom = String(enseigne || 'KEEPO').replace(/["<>\r\n]/g, '').trim() || 'KEEPO';
  return `${nom} <${adresse}>`;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 12px 0;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

const MAIL_POLICE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto," +
  "'Helvetica Neue',Helvetica,Arial,sans-serif";

// Une couleur venant de la base ne doit jamais atterrir telle quelle dans un
// attribut de style : on n'accepte que la notation hexadécimale.
// « de » + nom du commerce : la langue veut une contraction quand le nom
// commence par un article. « de Le Bistrot » se dit « du Bistrot ».
function deCommerce(nom: string): string {
  const n = String(nom || '').trim();
  if (/^less+/i.test(n)) return 'des ' + n.slice(4);
  if (/^les+/i.test(n))  return 'du ' + n.slice(3);
  if (/^las+/i.test(n))  return 'de la ' + n.slice(3);
  if (/^l['’]/i.test(n)) return 'de ' + n;
  if (/^[aeiouâàéèêîôûhAEIOUÂÀÉÈÊÎÔÛH]/.test(n)) return 'd’' + n;
  return 'de ' + n;
}

function couleurMail(c: string | null | undefined, defaut: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(String(c ?? '')) ? String(c) : defaut;
}
// Éclaircit une couleur pour en faire un fond de bandeau lisible.
function melangeMail(hex: string, ratio: number): string {
  const h = hex.replace('#', '');
  const m = (i: number) =>
    Math.round(parseInt(h.substr(i, 2), 16) * (1 - ratio) + 255 * ratio);
  return '#' + [0, 2, 4].map(i => m(i).toString(16).padStart(2, '0')).join('');
}

// Le client reçoit un message de SON commerçant : c'est sa marque qui doit
// s'afficher — son logo, son nom, sa couleur. KEEPO ne prend qu'une ligne
// en pied de page.
function buildEmailHtml(
  bodyText: string,
  merchantName: string,
  merchantId?: string,
  merchantColor?: string,
): string {
  const bodyHtml = textToHtml(bodyText);
  const nom      = merchantName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const accent   = couleurMail(merchantColor, '#4B45A6');
  const bandeau  = melangeMail(accent, 0.90);
  const logo     = merchantId
    ? `https://keepo.eu/logo/${encodeURIComponent(merchantId)}`
    : 'https://keepo.eu/img/logo.png';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Message de ${nom}</title>
</head>
<body style="margin:0;padding:0;background:#F2F2F6;font-family:${MAIL_POLICE};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F2F6;padding:36px 14px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:20px;overflow:hidden;border:1px solid #E9E9EF;">
    <tr><td align="center" bgcolor="${bandeau}" style="background:${bandeau};padding:36px 32px 30px;border-bottom:3px solid ${accent};">
      <img src="${logo}" width="76" height="76" alt="${nom}" style="display:block;margin:0 auto 16px;border-radius:18px;border:0;outline:none;background:#FFFFFF;">
      <div style="font-family:${MAIL_POLICE};font-size:27px;line-height:1.2;font-weight:700;color:#14141B;letter-spacing:-0.6px;">${nom}</div>
      <div style="font-family:${MAIL_POLICE};font-size:11.5px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:${accent};margin-top:8px;">Votre carte de fidélité</div>
    </td></tr>
    <tr><td style="padding:34px 40px 30px;color:#33333D;font-size:15.5px;line-height:1.72;font-family:${MAIL_POLICE};">
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:20px 40px 26px;background:#FAFAFB;border-top:1px solid #EFEFF4;text-align:center;font-family:${MAIL_POLICE};font-size:11.5px;line-height:1.65;color:#9A9AA6;">
      Vous recevez ce message parce que vous êtes membre du programme de fidélité
      <strong style="color:#6B6B7B;">${deCommerce(nom)}</strong>.<br>
      <span style="color:#B4B4BE;">Envoyé avec <a href="https://keepo.eu" style="color:#B4B4BE;text-decoration:none;">KEEPO</a></span>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({
      error: 'RESEND_API_KEY non configurée. Exécutez : supabase secrets set RESEND_API_KEY=re_...',
    }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  try {
    const body = await req.json();
    const {
      automation_id,
      merchant_id,
      merchant_name,
      recipients,
      subject: subjectTemplate,
      body_template,
      is_test = false,
    } = body;

    if (!merchant_id || !Array.isArray(recipients) || !recipients.length || !subjectTemplate || !body_template) {
      return new Response(JSON.stringify({ error: 'Paramètres manquants (merchant_id, recipients, subject, body_template)' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Sa couleur de marque, pour habiller l en-tete du message.
    let merchant_color: string | null = null;
    try {
      const { data: carte } = await supabase.from('merchant_cards')
        .select('color').eq('merchant_id', merchant_id).maybeSingle();
      merchant_color = carte?.color ?? null;
    } catch (_) { /* sans couleur, le gabarit prend le violet KEEPO */ }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const recipient of recipients) {
      const clientName    = String(recipient.name || 'cher client');
      const enseigne      = String(merchant_name || 'votre enseigne');
      const finalSubject  = subjectTemplate.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, enseigne);
      const finalBody     = body_template.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, enseigne);
      const htmlBody      = buildEmailHtml(finalBody, enseigne, merchant_id, merchant_color ?? undefined);

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Le client doit voir le nom de SON commerce dans sa boîte, pas KEEPO.
          from:    expediteurCommercant(enseigne),
          to:      [recipient.email],
          subject: finalSubject,
          html:    htmlBody,
        }),
      });

      const status   = resendRes.ok ? (is_test ? 'test' : 'sent') : 'failed';
      let   errorMsg: string | null = null;

      if (!resendRes.ok) {
        errorMsg = (await resendRes.text()).substring(0, 400);
        failed++;
        errors.push(errorMsg);
        console.error(`Resend error for ${recipient.email}:`, errorMsg);
      } else {
        sent++;
      }

      await supabase.from('notification_sends').insert({
        automation_id:   automation_id ?? null,
        merchant_id,
        client_id:       recipient.client_id ?? null,
        recipient_email: recipient.email,
        subject:         finalSubject,
        status,
        error_msg:       errorMsg,
      });
    }

    return new Response(JSON.stringify({ sent, failed, errors }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('KEEPO-send-email error:', err);
    return new Response(JSON.stringify({ error: 'Erreur serveur', details: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
