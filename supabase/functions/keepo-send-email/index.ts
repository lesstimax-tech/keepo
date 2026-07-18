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

function buildEmailHtml(bodyText: string, merchantName: string): string {
  const bodyHtml = textToHtml(bodyText);
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Message de ${merchantName}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;max-width:600px;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#7c3aed 0%,#00e8cc 100%);padding:28px 32px;text-align:center;">
            <div style="font-size:26px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;font-family:Arial,sans-serif;">
              KEEPO
            </div>
            <div style="color:rgba(255,255,255,0.75);font-size:12px;margin-top:4px;letter-spacing:0.5px;">
              PROGRAMME DE FIDÉLITÉ DIGITAL
            </div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 36px;color:#333333;font-size:15px;line-height:1.7;">
            ${bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 36px 24px;background:#f8f8fb;font-size:11px;color:#aaaaaa;text-align:center;border-top:1px solid #eeeeee;">
            Vous recevez cet e-mail car vous êtes membre du programme de fidélité
            <strong style="color:#888888;">${merchantName}</strong> via KEEPO.<br>
            <span style="color:#cccccc;">KEEPO — Plateforme de fidélité digitale française</span>
          </td>
        </tr>
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

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const recipient of recipients) {
      const clientName    = String(recipient.name || 'cher client');
      const enseigne      = String(merchant_name || 'votre enseigne');
      const finalSubject  = subjectTemplate.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, enseigne);
      const finalBody     = body_template.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, enseigne);
      const htmlBody      = buildEmailHtml(finalBody, enseigne);

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    FROM_EMAIL,
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
