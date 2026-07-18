// ════════════════════════════════════════════════════════════════
//  KEEPO — Edge Function : Envoi de notifications Push (Web Push / VAPID)
// ════════════════════════════════════════════════════════════════
//
//  Déploiement :
//    supabase functions deploy keepo-push --no-verify-jwt
//
//  Secrets requis :
//    supabase secrets set VAPID_PUBLIC_KEY=B...      # 65 octets base64url
//    supabase secrets set VAPID_PRIVATE_KEY=...      # 32 octets base64url
//    supabase secrets set VAPID_SUBJECT=mailto:contact@keepo.eu
//    (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectés par la plateforme)
//
//  Appel (serveur uniquement — exige le service role en Bearer) :
//    POST { client_ids?: string[], merchant_id?: string,
//           title: string, body: string, url?: string }
//
//  Réponse : { sent, failed, total, cleaned }
//  Les abonnements expirés (404/410) sont supprimés automatiquement.
// ════════════════════════════════════════════════════════════════

// deno-lint-ignore-file
/// <reference lib="deno.ns" />

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VAPID_PUBLIC     = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE    = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT    = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:contact@keepo.eu';

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

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')   return json({ error: 'Méthode non autorisée' }, 405);

  // Garde-fou : appel serveur uniquement (cron / Worker avec service role).
  const authHeader = req.headers.get('Authorization') || '';
  if (!SERVICE_ROLE_KEY || authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return json({ error: 'Non autorisé' }, 401);
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return json({ error: 'VAPID non configuré (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)' }, 500);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Corps invalide' }, 400); }

  let { client_ids, merchant_id, title, body: msgBody, url } = body ?? {};
  if (!title || !msgBody) return json({ error: 'title et body requis' }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Si pas de liste explicite : tous les clients du commerçant.
  if ((!Array.isArray(client_ids) || !client_ids.length) && merchant_id) {
    const { data } = await supabase
      .from('loyalty_balances')
      .select('client_id')
      .eq('merchant_id', merchant_id);
    client_ids = [...new Set((data ?? []).map((r: any) => r.client_id))];
  }
  if (!Array.isArray(client_ids) || !client_ids.length) {
    return json({ sent: 0, failed: 0, total: 0, cleaned: 0 });
  }

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('client_id', client_ids.slice(0, 1000));

  if (!subs?.length) return json({ sent: 0, failed: 0, total: 0, cleaned: 0 });

  const payload = JSON.stringify({
    title: String(title).slice(0, 120),
    body:  String(msgBody).slice(0, 300),
    url:   url || '/dashboard-client',
  });

  let sent = 0, failed = 0;
  const deadIds: number[] = [];

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 86400 },
      );
      sent++;
    } catch (e: any) {
      failed++;
      const code = e?.statusCode;
      // 404 = endpoint inconnu, 410 = abonnement expiré → on nettoie.
      if (code === 404 || code === 410) deadIds.push(s.id);
      else console.error('Push error', code, String(e?.body || e).slice(0, 200));
    }
  }

  if (deadIds.length) {
    await supabase.from('push_subscriptions').delete().in('id', deadIds);
  }

  return json({ sent, failed, total: subs.length, cleaned: deadIds.length });
});
