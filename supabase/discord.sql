-- ════════════════════════════════════════════════════════════════
--  KEEPO — les salons #inscriptions et #quotidien
--
--  À coller dans l'éditeur SQL de Supabase :
--    https://supabase.com/dashboard/project/kvtsjylnwgexfywvxnwz/sql
--
--  AVANT DE LANCER : remplacez COLLEZ_VOTRE_KEEPO_RELAI_TOKEN par la valeur
--  de KEEPO_RELAI_TOKEN — celle que vous avez posée chez Cloudflare et dans
--  les secrets Supabase.
--
--  Pourquoi pas la clé service_role : ce projet a migré vers le nouveau
--  système de clés Supabase, et les deux copies du service role ne sont plus
--  identiques selon l'endroit d'où l'on appelle. C'est ce qui a fait échouer
--  le relais du Worker pendant une heure. Le jeton de relais, lui, ne dépend
--  d'aucune migration — et il ne porte aucun privilège sur la base, ce qui
--  vaut mieux pour une valeur stockée dans la définition d'une fonction.
--
--  Extensions nécessaires (déjà actives sur ce projet, la tâche
--  keepo-notif-cron s'en sert) :
--    pg_net   — appels HTTP depuis Postgres
--    pg_cron  — planification
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
--  1. Un point d'envoi unique, comme côté application
--
--  net.http_post ne bloque pas : il dépose la requête dans une file que
--  l'extension vide de son côté. Une inscription n'attend donc jamais
--  Discord, et un Discord en panne ne peut pas faire échouer une
--  inscription. C'est la propriété qui rend ce déclencheur sûr.
-- ────────────────────────────────────────────────────────────────
create or replace function public.keepo_discord(charge jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform net.http_post(
    url     := 'https://kvtsjylnwgexfywvxnwz.supabase.co/functions/v1/keepo-discord',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer COLLEZ_VOTRE_KEEPO_RELAI_TOKEN'
    ),
    body    := charge
  );
exception when others then
  -- Une notification ratée n'a jamais le droit d'annuler ce qu'elle raconte.
  raise warning 'keepo_discord : %', sqlerrm;
end;
$$;

-- ────────────────────────────────────────────────────────────────
--  2. #inscriptions — un commerçant vient de créer son compte
--
--  On n'envoie ni e-mail ni nom de famille : huit caractères de
--  l'identifiant suffisent à retrouver la fiche dans Supabase, et Discord
--  n'a pas à héberger les coordonnées de vos commerçants.
-- ────────────────────────────────────────────────────────────────
create or replace function public.keepo_prevenir_inscription()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.keepo_discord(jsonb_build_object(
    'salon',  'inscriptions',
    'titre',  'Nouveau commerçant — ' || coalesce(new.name, 'sans nom'),
    'texte',  'Un compte commerçant vient d''être créé.',
    'champs', jsonb_build_array(
      jsonb_build_object('nom', 'Enseigne', 'valeur', coalesce(new.name, '—'), 'ligne', false),
      jsonb_build_object('nom', 'Formule',  'valeur', coalesce(new.plan, '—')),
      jsonb_build_object('nom', 'Fiche',    'valeur', left(new.id::text, 8))
    )
  ));
  return new;
end;
$$;

drop trigger if exists keepo_inscription_discord on public.profiles;
create trigger keepo_inscription_discord
  after insert on public.profiles
  for each row
  when (new.role = 'commercant')
  execute function public.keepo_prevenir_inscription();

-- ────────────────────────────────────────────────────────────────
--  3. #quotidien — le chiffre du jour
--
--  Le total cumulé accompagne toujours le chiffre de la veille : une
--  journée à zéro arrive souvent au début, et un salon qui n'affiche que
--  des zéros finit par ne plus être ouvert.
-- ────────────────────────────────────────────────────────────────
create or replace function public.keepo_digest_quotidien()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  depuis   timestamptz := date_trunc('day', now() at time zone 'Europe/Paris') - interval '1 day';
  jusqua   timestamptz := date_trunc('day', now() at time zone 'Europe/Paris');
  n_com    int;
  n_cli    int;
  n_cartes int;
  n_tamp   int;
  n_recomp int;
  t_com    int;
  t_cli    int;
begin
  select count(*) into n_com  from public.profiles
    where role = 'commercant' and created_at >= depuis and created_at < jusqua;
  select count(*) into n_cli  from public.profiles
    where role = 'client'     and created_at >= depuis and created_at < jusqua;
  select count(*) into n_cartes from public.loyalty_balances
    where created_at >= depuis and created_at < jusqua;
  select count(*) into n_tamp from public.transactions
    where type = 'credit' and created_at >= depuis and created_at < jusqua;
  select count(*) into n_recomp from public.transactions
    where type = 'debit'  and created_at >= depuis and created_at < jusqua;

  select count(*) into t_com from public.profiles where role = 'commercant';
  select count(*) into t_cli from public.profiles where role = 'client';

  perform public.keepo_discord(jsonb_build_object(
    'salon',  'quotidien',
    'titre',  'Hier — ' || to_char(depuis, 'DD/MM'),
    'texte',  'Au total : ' || t_com || ' commerçants, ' || t_cli || ' clients.',
    'champs', jsonb_build_array(
      jsonb_build_object('nom', 'Commerçants',  'valeur', n_com::text),
      jsonb_build_object('nom', 'Clients',      'valeur', n_cli::text),
      jsonb_build_object('nom', 'Cartes prises','valeur', n_cartes::text),
      jsonb_build_object('nom', 'Tampons posés','valeur', n_tamp::text),
      jsonb_build_object('nom', 'Récompenses',  'valeur', n_recomp::text)
    )
  ));
end;
$$;

-- Planification : 18 h UTC, soit 20 h à Paris en été et 19 h en hiver.
-- pg_cron ne connaît que l'heure UTC ; le décalage d'une heure l'hiver est
-- sans conséquence pour un résumé de la veille.
select cron.unschedule('keepo-digest-quotidien')
  where exists (select 1 from cron.job where jobname = 'keepo-digest-quotidien');

select cron.schedule(
  'keepo-digest-quotidien',
  '0 18 * * *',
  $$ select public.keepo_digest_quotidien() $$
);

-- ────────────────────────────────────────────────────────────────
--  4. Vérifier tout de suite, sans attendre demain
-- ────────────────────────────────────────────────────────────────
-- select public.keepo_discord('{"salon":"inscriptions","titre":"Essai depuis Postgres"}'::jsonb);
-- select public.keepo_digest_quotidien();

-- ────────────────────────────────────────────────────────────────
--  5. Quand rien n'arrive
--
--  keepo_discord avale ses erreurs — c'est voulu : une notification ratée
--  n'a pas le droit d'annuler l'inscription qu'elle raconte. La contrepartie
--  est qu'elle ne dit rien. La vérité est ici : pg_net conserve la réponse
--  de chaque appel.
-- ────────────────────────────────────────────────────────────────
-- Qu'a répondu la fonction ? (401 = jeton refusé, 200 = regardez « envoye »)
-- select id, status_code, left(content, 300) as reponse, created
--   from net._http_response order by created desc limit 6;

-- Aucune ligne du tout ? Alors la requête n'a jamais été déposée.
-- select extname from pg_extension where extname in ('pg_net', 'pg_cron');

-- Le déclencheur est-il bien en place sur profiles ?
-- select tgname, tgenabled from pg_trigger
--   where tgrelid = 'public.profiles'::regclass and not tgisinternal;

-- La tâche quotidienne est-elle planifiée ?
-- select jobname, schedule, active from cron.job;
