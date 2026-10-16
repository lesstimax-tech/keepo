// ════════════════════════════════════════════════════════════════
//  KEEPO — Edge Function : Cron d'envoi automatique des e-mails
// ════════════════════════════════════════════════════════════════
//
//  Déploiement :
//    supabase functions deploy KEEPO-notif-cron --no-verify-jwt
//
//  Planification (pg_cron — toutes les 15 min) :
//    Dans Supabase SQL Editor :
//
//    select cron.schedule(
//      'KEEPO-notif-cron',
//      '*/15 * * * *',
//      $$
//        select net.http_post(
//          url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/KEEPO-notif-cron',
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
//
//  Rappels d'essai (commerçants, essai gratuit sans carte) :
//    3 jours avant la fin, puis le jour de la fin — voir supabase/rappels-essai.sql
// ════════════════════════════════════════════════════════════════

// deno-lint-ignore-file
/// <reference lib="deno.ns" />

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Expéditeur : domaine vérifié keepo.eu par défaut. Le secret RESEND_FROM peut
// surcharger l'adresse ; le NOM affiché est toujours celui du commerce.
const FROM_EMAIL       = Deno.env.get('RESEND_FROM') ?? 'notifications@keepo.eu';

function senderFor(merchantName: string): string {
  const raw  = FROM_EMAIL.trim();
  const m    = raw.match(/<([^>]+)>/);
  const addr = m ? m[1].trim() : (raw.includes('@') ? raw : 'notifications@keepo.eu');
  const safe = (merchantName || 'KEEPO').replace(/["<>\r\n]/g, '').trim() || 'KEEPO';
  return `${safe} <${addr}>`;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ─── HTML email builder ───────────────────────────────────────
function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkified = escaped.replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#0E7C8C;font-weight:bold;">$1</a>');
  return linkified
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 12px 0;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function buildEmailHtml(
  bodyText: string,
  merchantName: string,
  merchantId: string,
  cta?: { url: string; label: string },
): string {
  const safeName = merchantName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const logoUrl  = `https://keepo.eu/logo/${merchantId}`;
  const ctaBlock = cta
    ? `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 18px;"><tr><td style="border-radius:50px;background:linear-gradient(135deg,#5B3AA0,#16B8C4);background-color:#5B3AA0;">
         <a href="${cta.url}" style="display:inline-block;padding:14px 34px;color:#ffffff;font-weight:bold;font-size:15px;text-decoration:none;border-radius:50px;">${cta.label}</a>
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
            ${textToHtml(bodyText)}
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

// ─── Envoyer un e-mail + logger dans notification_sends ───────
async function sendAndLog(
  supabase: SupabaseClient,
  automationId: number,
  merchantId: string,
  merchantName: string,
  recipient: { email: string; name: string; client_id: string | null },
  subjectTemplate: string,
  bodyTemplate: string,
  opts?: { ctaLabel?: string },
): Promise<void> {
  const clientName   = recipient.name || 'cher client';
  const finalSubject = subjectTemplate.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, merchantName);
  let   finalBody    = bodyTemplate.replace(/\[Client\]/gi, clientName).replace(/\[Enseigne\]/gi, merchantName);

  // CTA : si demandé (ex. avis Google), la première URL du message devient
  // un vrai bouton — et disparaît du texte brut.
  let cta: { url: string; label: string } | undefined;
  if (opts?.ctaLabel) {
    const urlMatch = finalBody.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      cta = { url: urlMatch[0], label: opts.ctaLabel };
      finalBody = finalBody.replace(urlMatch[0], '').replace(/[ \t]*:\s*$/m, '').replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    senderFor(merchantName),
      to:      [recipient.email],
      subject: finalSubject,
      html:    buildEmailHtml(finalBody, merchantName, merchantId, cta),
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

// ─── Push : notifie une liste de clients via la fonction keepo-push ──
// Best-effort : un échec push ne doit JAMAIS bloquer l'envoi des e-mails.
// Un seul appel groupé par automation (le push est générique, contrairement
// à l'e-mail personnalisé). keepo-push ne touche que les clients abonnés.
async function pushToClients(
  clientIds: string[],
  merchantId: string,
  merchantName: string,
  subject: string,
): Promise<void> {
  if (!clientIds.length) return;
  const cleanBody = (subject || '')
    .replace(/\[Client\]/gi, '')
    .replace(/\[Enseigne\]/gi, merchantName)
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Vous avez du nouveau sur votre carte de fidélité.';
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/keepo-push`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        client_ids:  clientIds,
        // Les destinataires restent ceux de client_ids ; merchant_id ne sert
        // ici qu'à habiller la notification du logo du commerce.
        merchant_id: merchantId,
        title: merchantName,
        body:  cleanBody,
        url:   '/dashboard-client',
      }),
    });
  } catch (err) {
    console.error('pushToClients error:', err);
  }
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
  await pushToClients(toNotify.map((c: any) => c.id), auto.merchant_id, merchantName, auto.subject);
}

// ─── AVIS : N minutes APRÈS un achat ──────────────────────────
// Sémantique : l'e-mail part une fois le délai écoulé (le client a quitté
// la boutique), pas avant. Fenêtre = achats dont l'âge est compris entre
// [délai, délai + 6 h] — la borne haute couvre les pannes/espacements du
// cron, et la déduplication 24 h empêche tout doublon.
async function processAvis(supabase: SupabaseClient, auto: any, merchantName: string) {
  const mins        = Math.max(1, Number(auto.trigger_mins) || 30);
  const newestEdge  = new Date(Date.now() - mins * 60000).toISOString();          // âge ≥ délai
  const oldestEdge  = new Date(Date.now() - (mins * 60000 + 6 * 3600000)).toISOString(); // pas plus vieux que délai + 6 h
  const dedupCutoff = new Date(Date.now() - 864e5).toISOString(); // 24 h

  const { data: recentTx } = await supabase
    .from('transactions')
    .select('client_id')
    .eq('merchant_id', auto.merchant_id)
    .eq('type', 'credit')
    .lte('created_at', newestEdge)
    .gte('created_at', oldestEdge);

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
      auto.subject, auto.body,
      { ctaLabel: '⭐ Laisser mon avis sur Google' });
  }
  await pushToClients(toNotify, auto.merchant_id, merchantName, auto.subject);
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
  await pushToClients(toNotify.map((c: any) => c.id), auto.merchant_id, merchantName, auto.subject);
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
  await pushToClients(clients.map((c: any) => c.id), auto.merchant_id, merchantName, auto.subject);
}

// ─── Rappels de fin d'essai (KEEPO → commerçant) ──────────────
// L'essai sans carte n'a pas d'abonnement Stripe, donc pas de rappel Stripe.
// keepo_rappels_essai() choisit les comptes et les marque avant de les
// rendre : un e-mail ne part qu'une fois, même si deux passages du cron se
// chevauchent. En cas d'échec d'envoi, on efface la marque pour réessayer.
const URL_FORMULES = 'https://keepo.eu/upgrade';
const REPONDRE_A   = Deno.env.get('KEEPO_REPLY_TO') ?? 'contact@keepo.eu';

function echapperHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Habillage KEEPO (et non celui d'un commerce) : c'est KEEPO qui écrit au commerçant.
function buildKeepoEmailHtml(bodyText: string, cta: { url: string; label: string }): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F4F4F8;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="background:#ffffff;border-radius:18px;overflow:hidden;max-width:600px;box-shadow:0 4px 24px rgba(20,20,27,0.07);">
        <tr>
          <td style="padding:28px 36px 20px;text-align:center;border-bottom:1px solid #EFEFF4;">
            <img src="https://keepo.eu/img/logo.png" width="120" alt="KEEPO" style="display:inline-block;max-width:120px;height:auto;">
          </td>
        </tr>
        <tr>
          <td style="padding:30px 36px 18px;color:#34333F;font-size:15px;line-height:1.7;">
            ${textToHtml(bodyText)}
            <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 18px;"><tr><td style="border-radius:50px;background:linear-gradient(135deg,#5B3AA0,#16B8C4);background-color:#5B3AA0;">
              <a href="${cta.url}" style="display:inline-block;padding:14px 34px;color:#ffffff;font-weight:bold;font-size:15px;text-decoration:none;border-radius:50px;">${echapperHtml(cta.label)}</a>
            </td></tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 36px 22px;background:#FAFAFC;font-size:11px;color:#A6A4B2;text-align:center;border-top:1px solid #EFEFF4;">
            Vous recevez cet e-mail car vous avez créé un compte commerçant sur
            <a href="https://keepo.eu" style="color:#0E7C8C;text-decoration:none;font-weight:bold;">KEEPO</a>.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

type RappelEssai = {
  merchant_id: string; type: 'j3' | 'fin'; nom: string | null; email: string;
  fin: string; membres: number; passages: number;
};

// Le texte des deux e-mails. Pur : testé à part, sans réseau.
export function texteRappelEssai(r: RappelEssai, maintenant: Date = new Date()): { sujet: string; corps: string } {
  const prenom = String(r.nom || '').trim() || 'Bonjour';
  const salut  = prenom === 'Bonjour' ? 'Bonjour,' : `Bonjour ${prenom},`;
  const date   = new Date(r.fin).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
  const pl     = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`;
  const bilan  = r.membres > 0
    ? `Depuis le début de votre essai, ${pl(r.membres, 'client')} ${r.membres > 1 ? 'ont' : 'a'} rejoint votre programme et ${pl(r.passages, 'passage')} ${r.passages > 1 ? 'ont été enregistrés' : 'a été enregistré'}.`
    : `Votre carte est prête : il ne manque que l'affiche sur votre comptoir pour que vos clients s'inscrivent. Vous l'imprimez depuis l'onglet Code QR de votre tableau de bord.`;

  if (r.type === 'j3') {
    const heures = (Date.parse(r.fin) - maintenant.getTime()) / 3600000;
    const quand  = heures <= 24 ? 'demain' : `dans ${Math.max(2, Math.round(heures / 24))} jours`;
    return {
      sujet: `Votre essai KEEPO se termine ${quand}`,
      corps: `${salut}

Votre essai gratuit de KEEPO se termine ${quand}, ${date}.

${bilan}

Pour continuer sans interruption, choisissez votre formule, à partir de 24,90 € par mois, sans engagement. Si vous la choisissez avant la fin de l'essai, les jours restants sont conservés : le premier prélèvement n'a lieu qu'à la fin de l'essai.

Aucune carte bancaire n'a été enregistrée : rien ne sera prélevé sans votre accord. Sans formule, votre tableau de bord sera mis en pause à la fin de l'essai ; vos clients garderont leurs cartes et leurs points.

Une question ? Répondez simplement à cet e-mail.

Sami, fondateur de KEEPO`
    };
  }

  const bilanFin = r.membres > 0
    ? `Vos ${pl(r.membres, 'client')} ${r.membres > 1 ? 'gardent leurs cartes' : 'garde sa carte'} et ${r.membres > 1 ? 'leurs' : 'ses'} points : rien n'est perdu.`
    : `Votre carte et vos réglages sont conservés : rien n'est perdu.`;
  return {
    sujet: 'Votre essai KEEPO est terminé',
    corps: `${salut}

Votre essai gratuit de KEEPO s'est terminé ${date}. Votre tableau de bord est en pause.

${bilanFin}

Pour retrouver votre terminal et continuer à fidéliser vos clients, choisissez votre formule, à partir de 24,90 € par mois, sans engagement.

Un doute sur la formule qui vous convient ? Répondez à cet e-mail, je vous réponds personnellement.

Sami, fondateur de KEEPO`
  };
}

async function processRappelsEssai(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc('keepo_rappels_essai');
  if (error) {
    // Migration supabase/rappels-essai.sql pas encore jouée : on n'envoie rien.
    console.warn('Rappels d\'essai indisponibles :', error.message);
    return 0;
  }
  let envoyes = 0;
  for (const r of (data ?? []) as RappelEssai[]) {
    const { sujet, corps } = texteRappelEssai(r);
    let ok = false;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:     senderFor('KEEPO'),
          to:       [r.email],
          reply_to: REPONDRE_A,
          subject:  sujet,
          html:     buildKeepoEmailHtml(corps, { url: URL_FORMULES, label: 'Choisir ma formule' }),
        }),
      });
      ok = res.ok;
      if (!ok) console.error(`Rappel d'essai ${r.type} → ${r.email} :`, (await res.text()).substring(0, 300));
    } catch (e) {
      console.error(`Rappel d'essai ${r.type} → ${r.email} :`, e);
    }
    if (ok) { envoyes++; continue; }
    // Échec : on retire la marque, le passage suivant (15 min) réessaiera.
    const colonne = r.type === 'j3' ? 'rappel_essai_j3_at' : 'rappel_essai_fin_at';
    await supabase.from('profiles').update({ [colonne]: null }).eq('id', r.merchant_id);
  }
  return envoyes;
}

// ─── Boucle principale ────────────────────────────────────────
async function runCron(supabase: SupabaseClient): Promise<{ processed: number; total: number }> {
  // ─── Essais Pro expirés → retour au plan Essentiel ───
  // Les abonnés payants ont un stripe_subscription_id (posé par le webhook
  // Stripe) ; les comptes en essai n'en ont pas. Les comptes sans
  // trial_ends_at (anciens / passés Pro manuellement) ne sont jamais touchés.
  await supabase
    .from('profiles')
    .update({ plan: 'essential' })
    .eq('plan', 'pro scale')
    .is('stripe_subscription_id', null)
    .lt('trial_ends_at', new Date().toISOString());

  // ─── Rappels de fin d'essai : avant les automations, qui peuvent
  // s'arrêter tôt quand aucune n'est active.
  try { await processRappelsEssai(supabase); }
  catch (err) { console.error('Rappels d\'essai :', err); }

  const { data: automations } = await supabase
    .from('notification_automations')
    .select('*')
    .eq('active', true);

  if (!automations?.length) return { processed: 0, total: 0 };

  let processed = 0;
  for (const auto of automations) {
    const { data: merchant } = await supabase
      .from('profiles')
      .select('name, plan')
      .eq('id', auto.merchant_id)
      .single();

    // Les envois programmés commencent à l'Essentiel. Le refus est ici et
    // pas seulement dans le navigateur : une automation créée avant un
    // changement de formule continuerait sinon de partir, aux frais de KEEPO.
    if (String(merchant?.plan ?? '').toLowerCase() === 'smart') continue;

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
    console.error('KEEPO-notif-cron fatal error:', err);
    return new Response(JSON.stringify({ error: 'Erreur serveur', details: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
