-- ════════════════════════════════════════════════════════
--  RAPPELS DE FIN D'ESSAI — essai gratuit sans carte bancaire
-- ════════════════════════════════════════════════════════
-- À exécuter une fois dans Supabase → SQL Editor. Rejouable sans risque.
--
-- L'essai sans carte (/api/essai-gratuit) n'a pas d'abonnement Stripe :
-- Stripe ne prévient donc plus le commerçant. Le cron keepo-notif-cron
-- appelle keepo_rappels_essai() toutes les 15 minutes et envoie :
--   • un rappel 3 jours avant la fin de l'essai ;
--   • un e-mail le jour où l'essai se termine.
-- Chaque e-mail part une seule fois : la fonction marque le compte AVANT
-- de le rendre, si bien que deux passages simultanés du cron ne peuvent
-- pas prendre le même. Si l'envoi échoue, le cron efface la marque et le
-- passage suivant réessaie.


-- ── 1. La trace des envois ──────────────────────────────
alter table public.profiles add column if not exists rappel_essai_j3_at  timestamptz;
alter table public.profiles add column if not exists rappel_essai_fin_at timestamptz;


-- ── 2. Les rappels à envoyer maintenant ─────────────────
-- Seuls les essais sans carte sont concernés : aucun client Stripe, aucun
-- abonnement. Un ancien essai Stripe résilié a un stripe_customer_id et
-- n'est jamais repris. L'e-mail de fin ne part que dans les deux jours
-- qui suivent l'échéance : un essai terminé depuis longtemps (comptes
-- antérieurs à ce fichier) ne reçoit rien a posteriori.
create or replace function public.keepo_rappels_essai(p_maintenant timestamptz default now())
returns table (
  merchant_id uuid,
  type        text,
  nom         text,
  email       text,
  fin         timestamptz,
  membres     int,
  passages    int
)
language sql
security definer
set search_path = public
as $rappels$
  with j3 as (
    update public.profiles p
       set rappel_essai_j3_at = p_maintenant
     where p.role = 'commercant'
       and p.stripe_customer_id is null
       and p.stripe_subscription_id is null
       and nullif(btrim(p.email), '') is not null
       and p.rappel_essai_j3_at is null
       and p.trial_ends_at >  p_maintenant
       and p.trial_ends_at <= p_maintenant + interval '3 days'
    returning p.id, 'j3'::text as type, p.name, p.email, p.trial_ends_at
  ),
  fin as (
    update public.profiles p
       set rappel_essai_fin_at = p_maintenant
     where p.role = 'commercant'
       and p.stripe_customer_id is null
       and p.stripe_subscription_id is null
       and nullif(btrim(p.email), '') is not null
       and p.rappel_essai_fin_at is null
       and p.trial_ends_at <= p_maintenant
       and p.trial_ends_at >  p_maintenant - interval '2 days'
    returning p.id, 'fin'::text as type, p.name, p.email, p.trial_ends_at
  ),
  tous as (
    select * from j3
    union all
    select * from fin
  )
  select t.id,
         t.type,
         t.name,
         t.email,
         t.trial_ends_at,
         (select count(*)::int from public.loyalty_balances lb
           where lb.merchant_id = t.id and lb.hidden_at is null),
         (select count(*)::int from public.transactions tr
           where tr.merchant_id = t.id and tr.type = 'credit')
    from tous t;
$rappels$;

revoke all on function public.keepo_rappels_essai(timestamptz) from public, anon, authenticated;
grant execute on function public.keepo_rappels_essai(timestamptz) to service_role;
