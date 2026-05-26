// ════════════════════════════════════════════════════════════════
//  Keepo — Edge Function : Cron d'envoi automatique des e-mails
// ════════════════════════════════════════════════════════════════
//
//  Déploiement :
//    supabase functions deploy keepo-notif-cron --no-verify-jwt
//
//  Planification (pg_cron — toutes les 15 min) :
//    Dans Supabase SQL Editor :
//
//    select cron.schedule(
//      'keepo-notif-cron',
//      '*/15 * * * *',
//      $$
//        select net.http_post(
//          url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/keepo-notif-cron',
//          headers := jsonb_build_object(
//            'Content-Type',  'application/json',
//            'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'
//          ),
//          body    := '{}'::jsonb
//        )
//      $$
//    );
//
//  Logique par type :
//    relance  — clients inactifs depuis trigger_days jours (non déjà relancés récemment)
//    avis     — clients ayant acheté dans les trigger_mins minutes (non déjà notifiés/24h)
//    offre    — entre date_start et date_end, chaque client une seule fois par campagne
//    custom   — envoi unique selon le mode (immédiat / délai / date précise)
// ════════════════════════════════════════════════════════════════

// deno-lint-ignore-file
/// <reference lib="deno.ns" />

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FROM_EMAIL       = 'Keepo <notifications@keepo.app>';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ─── HTML email builder ───────────────────────────────────────
function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 12px 0;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function buildEmailHtml(bodyText: string, merchantName: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;max-width:600px;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:linear-gradient(135deg,#7c3aed 0%,#00e8cc 100%);padding:28px 32px;text-align:center;">
            <div style="font-size:26px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">Keepo</div>
            <div style="color:rgba(255,255,255,0.75);font-size:12px;margin-top:4px;letter-spacing:0.5px;">PROGRAMME DE FIDÉLITÉ DIGITAL</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px;color:#333333;font-size:15px;line-height:1.7;">
            ${textToHtml(bodyText)}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 36px 24px;background:#f8f8fb;font-size:11px;color:#aaaaaa;text-align:center;border-top:1px solid #eeeeee;">
            Vous recevez cet e-mail car vous êtes membre du programme de fidélité
            <strong style="color:#888888;">${merchantName}</strong> via Keepo.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Envoyer un e-mail + logger dans notification_sends ───────
async function sendAndLog(
  supabase: SupabaseClient,
  automationId: number,
  merchantId: string,
  merchantName: string,
  recipient: { email: string; name: string; client_id: string | null },
  subjectTemplate: string,
  bodyTemplate: string,
): Promise<void> {
  const clientName   = recipient.name || 'cher client';
  const finalSubject = subjectTemplate.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, merchantName);
  const finalBody    = bodyTemplate.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, merchantName);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [recipient.email],
      subject: finalSubject,
      html:    buildEmailHtml(finalBody, merchantName),
    }),
  });

  const status   = res.ok ? 'sent' : 'failed';
  const errorMsg = res.ok ? null : (await res.text()).substring(0, 400);
  if (!res.ok) console.error(`Resend error ${recipient.email}:`, errorMsg);

  await supabase.from('notification_sends').insert({
    automation_id:   automationId,
    merchant_id:     merchantId,
    client_id:       recipient.client_id,
    recipient_email: recipient.email,
    subject:         finalSubject,
    status,
    error_msg:       errorMsg,
  });
}

// ─── Récupérer tous les clients d'un commerçant (avec email) ──
async function getMerchantClients(
  supabase: SupabaseClient,
  merchantId: string,
): Promise<{ id: string; email: string; name: string }[]> {
  const { data } = await supabase
    .from('loyalty_balances')
    .select('client_id, profiles!client_id(id, email, name)')
    .eq('merchant_id', merchantId);

  return (data ?? [])
    .map((row: any) => row.profiles)
    .filter((p: any) => p?.email);
}

// ─── RELANCE : clients inactifs depuis N jours ────────────────
async function processRelance(supabase: SupabaseClient, auto: any, merchantName: string) {
  const days   = auto.trigger_days ?? 30;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();

  const clients = await getMerchantClients(supabase, auto.merchant_id);
  if (!clients.length) return;

  const { data: activeTx } = await supabase
    .from('transactions')
    .select('client_id')
    .eq('merchant_id', auto.merchant_id)
    .gte('created_at', cutoff)
    .in('client_id', clients.map((c: any) => c.id));

  const activeIds  = new Set((activeTx ?? []).map((t: any) => t.client_id));
  const inactive   = clients.filter((c: any) => !activeIds.has(c.id));
  if (!inactive.length) return;

  // Dédupliquer : ne pas renvoyer à un client déjà relancé dans la même fenêtre
  const { data: recentSends } = await supabase
    .from('notification_sends')
    .select('client_id')
    .eq('automation_id', auto.id)
    .gte('sent_at', cutoff)
    .in('client_id', inactive.map((c: any) => c.id));

  const sentIds   = new Set((recentSends ?? []).map((s: any) => s.client_id));
  const toNotify  = inactive.filter((c: any) => !sentIds.has(c.id));

  for (const client of toNotify) {
    await sendAndLog(supabase, auto.id, auto.merchant_id, merchantName,
      { email: client.email, name: client.name, client_id: client.id },
      auto.subject, auto.body);
  }
}

// ─── AVIS : clients ayant acheté dans les N minutes ───────────
async function processAvis(supabase: SupabaseClient, auto: any, merchantName: string) {
  const mins       = auto.trigger_mins ?? 30;
  const cutoff     = new Date(Date.now() - mins * 60000).toISOString();
  const dedupCutoff = new Date(Date.now() - 864e5).toISOString(); // 24 h

  const { data: recentTx } = await supabase
    .from('transactions')
    .select('client_id')
    .eq('merchant_id', auto.merchant_id)
    .eq('type', 'credit')
    .gte('created_at', cutoff);

  if (!recentTx?.length) return;
  const clientIds = [...new Set(recentTx.map((t: any) => t.client_id))] as string[];

  const { data: recentSends } = await supabase
    .from('notification_sends')
    .select('client_id')
    .eq('automation_id', auto.id)
    .gte('sent_at', dedupCutoff)
    .in('client_id', clientIds);

  const sentIds  = new Set((recentSends ?? []).map((s: any) => s.client_id));
  const toNotify = clientIds.filter(id => !sentIds.has(id));
  if (!toNotify.length) return;

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email, name')
    .in('id', toNotify);

  for (const p of (profiles ?? [])) {
    if (!p.email) continue;
    await sendAndLog(supabase, auto.id, auto.merchant_id, merchantName,
      { email: p.email, name: p.name, client_id: p.id },
      auto.subject, auto.body);
  }
}

// ─── OFFRE : entre date_start et date_end (envoi unique/client) ─
async function processOffre(supabase: SupabaseClient, auto: any, merchantName: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (!auto.date_start || !auto.date_end) return;
  if (today < auto.date_start || today > auto.date_end) return;

  const clients = await getMerchantClients(supabase, auto.merchant_id);
  if (!clients.length) return;

  const { data: alreadySent } = await supabase
    .from('notification_sends')
    .select('client_id')
    .eq('automation_id', auto.id)
    .in('client_id', clients.map((c: any) => c.id));

  const sentIds  = new Set((alreadySent ?? []).map((s: any) => s.client_id));
  const toNotify = clients.filter((c: any) => !sentIds.has(c.id));

  for (const client of toNotify) {
    await sendAndLog(supabase, auto.id, auto.merchant_id, merchantName,
      { email: client.email, name: client.name, client_id: client.id },
      auto.subject, auto.body);
  }
}

// ─── CUSTOM : envoi unique selon le mode ──────────────────────
async function processCustom(supabase: SupabaseClient, auto: any, merchantName: string) {
  if (auto.last_run_at) return; // déjà envoyé

  const now = Date.now();
  let shouldFire = false;

  if (auto.trigger_mode === 'imm') {
    shouldFire = true;
  } else if (auto.trigger_mode === 'delay') {
    const units: Record<string, number> = { min: 60000, h: 3600000, d: 864e5 };
    const delayMs = (auto.delay_val ?? 30) * (units[auto.delay_unit ?? 'h'] ?? 3600000);
    shouldFire = new Date(auto.created_at).getTime() + delayMs <= now;
  } else if (auto.trigger_mode === 'date') {
    shouldFire = !!auto.send_date && new Date(auto.send_date).getTime() <= now;
  }

  if (!shouldFire) return;

  const clients = await getMerchantClients(supabase, auto.merchant_id);
  for (const client of clients) {
    await sendAndLog(supabase, auto.id, auto.merchant_id, merchantName,
      { email: client.email, name: client.name, client_id: client.id },
      auto.subject, auto.body);
  }
}

// ─── Boucle principale ────────────────────────────────────────
async function runCron(supabase: SupabaseClient): Promise<{ processed: number; total: number }> {
  const { data: automations } = await supabase
    .from('notification_automations')
    .select('*')
    .eq('active', true);

  if (!automations?.length) return { processed: 0, total: 0 };

  let processed = 0;
  for (const auto of automations) {
    const { data: merchant } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', auto.merchant_id)
      .single();
    const merchantName = merchant?.name ?? 'votre enseigne';

    try {
      if      (auto.type === 'relance') await processRelance(supabase, auto, merchantName);
      else if (auto.type === 'avis')    await processAvis(supabase, auto, merchantName);
      else if (auto.type === 'offre')   await processOffre(supabase, auto, merchantName);
      else if (auto.type === 'custom')  await processCustom(supabase, auto, merchantName);

      await supabase
        .from('notification_automations')
        .update({ last_run_at: new Date().toISOString() })
        .eq('id', auto.id);

      processed++;
    } catch (err) {
      console.error(`Automation ${auto.id} error:`, err);
    }
  }

  return { processed, total: automations.length };
}

// ─── Handler HTTP ─────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY non configurée' }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  if (!SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY manquante' }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const result   = await runCron(supabase);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('keepo-notif-cron fatal error:', err);
    return new Response(JSON.stringify({ error: 'Erreur serveur', details: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
