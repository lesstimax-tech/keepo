-- ════════════════════════════════════════════════════════
--  POINTS DE VENTE — Smart 1, Essentiel 2, Pro Scale 3 (+ option)
-- ════════════════════════════════════════════════════════
-- À exécuter une fois dans Supabase → SQL Editor. Rejouable sans risque.
--
-- Le compte : l'établissement principal n'a pas de ligne dans boutiques
-- (transactions.boutique_id reste null pour lui). Les formules se comptent
-- donc en lignes supplémentaires :
--   Smart       1 point de vente   → 0 ligne
--   Essentiel   2 points de vente  → 1 ligne
--   Pro Scale   3 points de vente  → 2 lignes, + points_de_vente_sup
-- Rien n'est supprimé : un commerçant qui descend de formule garde ses
-- points de vente existants ; il ne peut simplement plus en créer.


-- ── 1. L'option achetée ────────────────────────────────
-- Tenue à jour par le Worker (/api/points-de-vente et webhook Stripe),
-- jamais par le navigateur (voir 2).
alter table public.profiles
  add column if not exists points_de_vente_sup int not null default 0;
alter table public.profiles
  add column if not exists trial_ends_at timestamptz;

do $$ begin
  alter table public.profiles add constraint profiles_points_de_vente_sup_borne
    check (points_de_vente_sup between 0 and 50);
exception when duplicate_object then null;
end $$;


-- ── 2. Les colonnes de facturation n'appartiennent qu'au serveur ──
-- profiles_update_own laisse un commerçant modifier sa propre ligne sans
-- distinguer les colonnes : depuis la console du navigateur,
-- update({ plan: 'pro scale' }) passait. Une limite fondée sur plan ne
-- vaudrait rien sans ce verrou. Les autres colonnes (nom, avatar, code de
-- parrainage) restent modifiables comme avant.
--
-- La fonction n'est PAS security definer, exprès : current_user y reste
-- le rôle de l'appelant — authenticated pour le navigateur, service_role
-- pour le Worker et les Edge Functions, postgres pour l'éditeur SQL et
-- les tâches cron.
create or replace function public.keepo_proteger_facturation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.plan                   := old.plan;
    new.stripe_customer_id     := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.plan_renews_at         := old.plan_renews_at;
    new.trial_ends_at          := old.trial_ends_at;
    new.points_de_vente_sup    := old.points_de_vente_sup;
  end if;
  return new;
end;
$$;

drop trigger if exists keepo_proteger_facturation on public.profiles;
create trigger keepo_proteger_facturation
  before update on public.profiles
  for each row execute function public.keepo_proteger_facturation();

-- À l'inscription, handle_new_user recopie le plan des métadonnées : un
-- signUp forgé avec data: { plan: 'pro scale' } obtenait la formule sans
-- payer. connexion.html n'en envoie jamais ; on neutralise à l'arrivée.
-- handle_new_user est security definer (current_user y vaut postgres) :
-- la règle ne peut donc pas distinguer l'inscription de l'éditeur SQL, et
-- s'applique à toute création de profil, sauf depuis le service_role.
create or replace function public.keepo_inscription_sans_formule()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'service_role' then
    if new.plan is distinct from 'client' then
      new.plan := 'essential';
    end if;
    new.stripe_customer_id     := null;
    new.stripe_subscription_id := null;
    new.points_de_vente_sup    := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists keepo_inscription_sans_formule on public.profiles;
create trigger keepo_inscription_sans_formule
  before insert on public.profiles
  for each row execute function public.keepo_inscription_sans_formule();


-- ── 3. Le plafond, tranché par la base ─────────────────
-- Le tableau de bord prévient avant ; la base décide. Sans ce déclencheur,
-- boutiques_write laissait créer des lignes sans limite depuis la console.
-- Toutes les lignes comptent, actives ou non : sinon désactiver, créer,
-- puis réactiver contournerait la limite.
create or replace function public.keepo_limite_points_de_vente()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_plan   text;
  v_sup    int;
  v_total  int;
  v_lignes int;
begin
  -- Le serveur et l'éditeur SQL gardent la main (reprise, support).
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- Deux créations simultanées compteraient la même base : on les aligne.
  perform pg_advisory_xact_lock(hashtext('keepo_boutiques:' || new.merchant_id::text));

  select lower(plan), coalesce(points_de_vente_sup, 0)
    into v_plan, v_sup
    from public.profiles
   where id = new.merchant_id;

  v_total := case
    when v_plan in ('pro', 'pro scale') then 3 + v_sup
    when v_plan = 'smart'               then 1
    else 2
  end;

  select count(*) into v_lignes
    from public.boutiques
   where merchant_id = new.merchant_id;

  -- L'établissement principal occupe la première place, sans ligne.
  if v_lignes + 1 >= v_total then
    raise exception using
      errcode = 'P0001',
      message = 'Tous les points de vente de votre formule sont déjà utilisés.',
      hint    = 'KEEPO_LIMITE_POINTS_DE_VENTE';
  end if;

  return new;
end;
$$;

drop trigger if exists keepo_limite_points_de_vente on public.boutiques;
create trigger keepo_limite_points_de_vente
  before insert on public.boutiques
  for each row execute function public.keepo_limite_points_de_vente();


-- ── 4. Ce que ça change pour les commerçants actuels ───
-- Seuls les commerçants ayant déjà créé des points de vente apparaissent.
-- « au_dela » > 0 : ils gardent ce qu'ils ont, mais ne peuvent plus en
-- créer. Si un commerce a enregistré son établissement principal comme
-- boutique, il est compté deux fois : c'est ici qu'on le voit.
select p.name                                   as commerce,
       p.plan,
       p.points_de_vente_sup                    as options,
       count(b.id) + 1                          as points_de_vente,
       case when lower(p.plan) in ('pro', 'pro scale') then 3 + p.points_de_vente_sup
            when lower(p.plan) = 'smart'               then 1
            else 2 end                          as compris,
       greatest(0, count(b.id) + 1 - case
            when lower(p.plan) in ('pro', 'pro scale') then 3 + p.points_de_vente_sup
            when lower(p.plan) = 'smart'               then 1
            else 2 end)                         as au_dela
  from public.profiles p
  join public.boutiques b on b.merchant_id = p.id
 where p.role = 'commercant'
 group by p.id, p.name, p.plan, p.points_de_vente_sup
 order by au_dela desc, points_de_vente desc;
