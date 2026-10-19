-- ════════════════════════════════════════════════════════
--  PROGRAMME AMBASSADEUR — affiliation KEEPO
-- ════════════════════════════════════════════════════════
-- À exécuter une fois dans Supabase → SQL Editor. Rejouable sans risque.
--
-- Un ambassadeur (créateur TikTok ou n'importe qui, sans minimum
-- d'abonnés) partage son code ou son lien keepo.eu/a/CODE.
--   • Le commerce qui s'inscrit avec ce code paie -20 % pendant 3 mois
--     sur l'abonnement mensuel (coupon posé par le Worker au paiement).
--   • Quand ce commerce a payé son 2ᵉ mois (ou un abonnement annuel),
--     l'ambassadeur gagne une prime de 30 €.
--   • Sami verse les primes par virement, une fois par mois, dès 50 € dus :
--       select * from keepo_versements_a_faire();
--       select keepo_marquer_verse('CODE', 'virement novembre');
--
-- Le Worker compte les factures payées (webhook Stripe) via
-- keepo_affiliation_paiement(), réservée au service_role. Les rejeux de
-- Stripe (invoice.paid ET invoice.payment_succeeded pour la même facture)
-- ne comptent qu'une fois : la facture est mémorisée par son identifiant.


-- ── 1. Le rôle « ambassadeur » ──────────────────────────
-- La contrainte d'origine (role in ('client','commercant')) porte un nom
-- donné par Postgres : on retire toute contrainte de profiles qui parle
-- de role, puis on pose la nouvelle sous un nom fixe.
do $roles$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end
$roles$;

alter table public.profiles add constraint profiles_role_check
  check (role in ('client', 'commercant', 'ambassadeur'));


-- ── 2. Les tables ───────────────────────────────────────
create table if not exists public.ambassadeurs (
  id          uuid primary key references public.profiles(id) on delete cascade,
  code        text not null unique check (code ~ '^[A-Z0-9]{3,16}$'),
  pseudo      text,          -- nom affiché, par ex. @lea.food
  reseau      text,          -- lien de son compte principal, facultatif
  titulaire   text,          -- titulaire du compte bancaire
  iban        text,          -- lu seulement par le serveur et l'éditeur SQL
  actif       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.ambassadeur_versements (
  id              uuid primary key default gen_random_uuid(),
  ambassadeur_id  uuid not null references public.ambassadeurs(id) on delete cascade,
  montant_cents   int  not null check (montant_cents > 0),
  primes          int  not null check (primes > 0),
  reference       text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_versements_ambassadeur on public.ambassadeur_versements(ambassadeur_id);

-- merchant_id passe à vide si le commerce supprime son compte : une prime
-- déjà gagnée reste due à l'ambassadeur.
create table if not exists public.affiliations (
  id               uuid primary key default gen_random_uuid(),
  merchant_id      uuid unique references public.profiles(id) on delete set null,
  ambassadeur_id   uuid not null references public.ambassadeurs(id) on delete cascade,
  code             text not null,          -- le code saisi, pour l'historique
  factures_payees  int  not null default 0,
  prime_cents      int  not null default 3000,
  prime_due_at     timestamptz,            -- 2ᵉ mois payé : la prime est due
  versement_id     uuid references public.ambassadeur_versements(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_affiliations_ambassadeur on public.affiliations(ambassadeur_id);

create table if not exists public.affiliation_factures (
  invoice_id      text primary key,
  affiliation_id  uuid not null references public.affiliations(id) on delete cascade,
  montant_cents   int  not null default 0,
  created_at      timestamptz not null default now()
);


-- ── 3. Qui lit quoi ─────────────────────────────────────
-- Aucune écriture directe depuis le navigateur : tout passe par les
-- fonctions ci-dessous. L'IBAN ne sort jamais en entier vers le
-- navigateur (mon_espace_ambassadeur le renvoie masqué).
alter table public.ambassadeurs           enable row level security;
alter table public.ambassadeur_versements enable row level security;
alter table public.affiliations           enable row level security;
alter table public.affiliation_factures   enable row level security;

revoke all on public.ambassadeurs, public.ambassadeur_versements,
              public.affiliations, public.affiliation_factures
  from anon, authenticated;
grant select on public.ambassadeur_versements, public.affiliations to authenticated;

drop policy if exists "versements_select_own" on public.ambassadeur_versements;
create policy "versements_select_own" on public.ambassadeur_versements
  for select using (ambassadeur_id = auth.uid());

-- Le commerçant voit s'il est rattaché (bandeau -20 % du tableau de bord) ;
-- l'ambassadeur voit ses propres commerces.
drop policy if exists "affiliations_select_own" on public.affiliations;
create policy "affiliations_select_own" on public.affiliations
  for select using (merchant_id = auth.uid() or ambassadeur_id = auth.uid());


-- ── 4. Outils ───────────────────────────────────────────
-- Code lisible : majuscules, sans accent, lettres et chiffres seulement.
create or replace function public.keepo_code_propre(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           translate(upper(coalesce(p, '')),
                     'ÀÂÄÁÃÅÇÉÈÊËÎÏÍÌÔÖÓÒÕÛÜÚÙŸÑ',
                     'AAAAAACEEEEIIIIOOOOOUUUUYN'),
           '[^A-Z0-9]', '', 'g');
$$;

-- IBAN : format et clé de contrôle (modulo 97), comme les banques.
create or replace function public.keepo_iban_valide(p text)
returns boolean
language plpgsql
immutable
as $$
declare
  v   text := upper(regexp_replace(coalesce(p, ''), '\s', '', 'g'));
  r   text;
  n   text := '';
  ch  text;
  i   int;
begin
  if v !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then
    return false;
  end if;
  r := substr(v, 5) || substr(v, 1, 4);
  for i in 1 .. length(r) loop
    ch := substr(r, i, 1);
    if ch ~ '[0-9]' then n := n || ch;
    else n := n || (ascii(ch) - 55)::text;
    end if;
  end loop;
  return (n::numeric % 97) = 1;
end;
$$;

-- Rattache un commerce à un ambassadeur. Interne : appelée par
-- rattacher_ambassadeur (le commerçant saisit son code) et par le
-- déclencheur d'inscription (code reçu avec le formulaire).
create or replace function public.keepo_rattacher(p_merchant uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code  text := public.keepo_code_propre(p_code);
  v_prof  record;
  v_amb   record;
begin
  if v_code = '' then
    return jsonb_build_object('ok', false, 'erreur', 'code_vide');
  end if;

  select id, role, stripe_customer_id, stripe_subscription_id
    into v_prof
    from public.profiles where id = p_merchant;
  if not found or v_prof.role <> 'commercant' then
    return jsonb_build_object('ok', false, 'erreur', 'pas_commercant');
  end if;
  -- La réduction vaut pour un premier abonnement : un commerce qui a
  -- déjà payé ne peut plus être rattaché.
  if v_prof.stripe_customer_id is not null or v_prof.stripe_subscription_id is not null then
    return jsonb_build_object('ok', false, 'erreur', 'deja_abonne');
  end if;
  if exists (select 1 from public.affiliations where merchant_id = p_merchant) then
    return jsonb_build_object('ok', false, 'erreur', 'deja_rattache');
  end if;

  select id, code, pseudo into v_amb
    from public.ambassadeurs
   where code = v_code and actif;
  if not found then
    return jsonb_build_object('ok', false, 'erreur', 'code_inconnu');
  end if;
  if v_amb.id = p_merchant then
    return jsonb_build_object('ok', false, 'erreur', 'soi_meme');
  end if;

  insert into public.affiliations (merchant_id, ambassadeur_id, code)
  values (p_merchant, v_amb.id, v_amb.code)
  on conflict (merchant_id) do nothing;
  if not found then
    return jsonb_build_object('ok', false, 'erreur', 'deja_rattache');
  end if;

  return jsonb_build_object('ok', true, 'code', v_amb.code, 'pseudo', v_amb.pseudo);
end;
$$;

revoke all on function public.keepo_rattacher(uuid, text) from public, anon, authenticated;


-- ── 5. Inscription d'un commerce avec un code ───────────
-- connexion.html envoie le code dans les métadonnées (amb_code). On le
-- lit dès la création du profil : le rattachement ne dépend ni du
-- navigateur ni du premier passage sur le tableau de bord. Une erreur
-- ici ne doit jamais bloquer l'inscription.
create or replace function public.keepo_affiliation_inscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if new.role = 'commercant' then
    begin
      select nullif(btrim(raw_user_meta_data->>'amb_code'), '')
        into v_code
        from auth.users where id = new.id;
      if v_code is not null then
        perform public.keepo_rattacher(new.id, v_code);
      end if;
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists keepo_affiliation_inscription on public.profiles;
create trigger keepo_affiliation_inscription
  after insert on public.profiles
  for each row execute function public.keepo_affiliation_inscription();


-- ── 6. Pages publiques et commerçant ────────────────────
-- Le code existe-t-il ? (page d'inscription, lien /a/CODE). Ne renvoie
-- que le pseudo public de l'ambassadeur.
create or replace function public.verifier_code_ambassadeur(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object('valide', true, 'code', a.code, 'pseudo', a.pseudo)
       from public.ambassadeurs a
      where a.code = public.keepo_code_propre(p_code) and a.actif),
    jsonb_build_object('valide', false));
$$;

revoke all on function public.verifier_code_ambassadeur(text) from public;
grant execute on function public.verifier_code_ambassadeur(text) to anon, authenticated;

-- Le commerçant saisit un code après coup (tableau de bord, avant de payer).
create or replace function public.rattacher_ambassadeur(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'erreur', 'non_connecte');
  end if;
  return public.keepo_rattacher(auth.uid(), p_code);
end;
$$;

revoke all on function public.rattacher_ambassadeur(text) from public, anon;
grant execute on function public.rattacher_ambassadeur(text) to authenticated;


-- ── 7. L'espace de l'ambassadeur ────────────────────────
-- Tout ce qu'affiche dashboard-ambassadeur.html, en un appel. Au premier
-- passage, la fiche est créée avec un code tiré du nom (LEA, LEA27…).
create or replace function public.mon_espace_ambassadeur()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_prof  record;
  v_amb   record;
  v_base  text;
  v_code  text;
  i       int;
begin
  if v_uid is null then
    return jsonb_build_object('erreur', 'non_connecte');
  end if;

  select * into v_amb from public.ambassadeurs where id = v_uid;
  if not found then
    select id, name, role into v_prof from public.profiles where id = v_uid;
    if not found or v_prof.role <> 'ambassadeur' then
      return jsonb_build_object('erreur', 'pas_ambassadeur');
    end if;

    v_base := left(public.keepo_code_propre(v_prof.name), 10);
    if length(v_base) < 3 then v_base := 'KEEPO'; end if;
    for i in 0 .. 30 loop
      v_code := case when i = 0 then v_base
                     else v_base || lpad(floor(random() * 100)::int::text, 2, '0') end;
      begin
        insert into public.ambassadeurs (id, code, pseudo)
        values (v_uid, v_code, nullif(btrim(v_prof.name), ''));
        exit;
      exception when unique_violation then
        -- Code pris par un autre ambassadeur, ou fiche créée à l'instant
        -- par un second onglet : on regarde avant de réessayer.
        if exists (select 1 from public.ambassadeurs where id = v_uid) then exit; end if;
        if i = 30 then
          insert into public.ambassadeurs (id, code, pseudo)
          values (v_uid, 'AMB' || upper(substr(md5(v_uid::text), 1, 8)), nullif(btrim(v_prof.name), ''))
          on conflict (id) do nothing;
        end if;
      end;
    end loop;
    select * into v_amb from public.ambassadeurs where id = v_uid;
  end if;

  return jsonb_build_object(
    'code',       v_amb.code,
    'pseudo',     v_amb.pseudo,
    'reseau',     v_amb.reseau,
    'titulaire',  v_amb.titulaire,
    'iban',       case when v_amb.iban is null then null
                       else left(v_amb.iban, 4) || ' •••• ' || right(v_amb.iban, 4) end,
    'actif',      v_amb.actif,
    'prime_cents', 3000,
    'seuil_cents', 5000,
    'code_modifiable', not exists (select 1 from public.affiliations where ambassadeur_id = v_uid),
    'stats', (
      select jsonb_build_object(
        'inscrits',        count(*),
        'abonnes',         count(*) filter (where af.factures_payees >= 1),
        'primes_gagnees',  count(*) filter (where af.prime_due_at is not null),
        'a_verser_cents',  coalesce(sum(af.prime_cents) filter (where af.prime_due_at is not null and af.versement_id is null), 0),
        'verse_cents',     coalesce(sum(af.prime_cents) filter (where af.versement_id is not null), 0))
        from public.affiliations af
       where af.ambassadeur_id = v_uid),
    'commerces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'nom',        coalesce(nullif(btrim(mc.title), ''), nullif(btrim(p.name), ''),
                                      case when af.merchant_id is null then 'Commerce fermé' else 'Commerce' end),
               'depuis',     af.created_at,
               'mois_payes', af.factures_payees,
               'statut',     case when af.versement_id is not null then 'versee'
                                  when af.prime_due_at is not null then 'due'
                                  when af.factures_payees >= 1    then 'abonne'
                                  else 'inscrit' end)
             order by af.created_at desc)
        from public.affiliations af
        left join public.profiles       p  on p.id = af.merchant_id
        left join public.merchant_cards mc on mc.merchant_id = af.merchant_id
       where af.ambassadeur_id = v_uid), '[]'::jsonb),
    'versements', coalesce((
      select jsonb_agg(jsonb_build_object('date', v.created_at, 'montant_cents', v.montant_cents, 'primes', v.primes)
             order by v.created_at desc)
        from public.ambassadeur_versements v
       where v.ambassadeur_id = v_uid), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.mon_espace_ambassadeur() from public, anon;
grant execute on function public.mon_espace_ambassadeur() to authenticated;

-- Pseudo, lien et coordonnées bancaires. Un champ laissé à null ne change
-- pas ; une chaîne vide l'efface (sauf l'IBAN, qu'on remplace seulement).
create or replace function public.ambassadeur_enregistrer(
  p_pseudo    text default null,
  p_reseau    text default null,
  p_titulaire text default null,
  p_iban      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_iban text := upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g'));
begin
  if v_uid is null or not exists (select 1 from public.ambassadeurs where id = v_uid) then
    return jsonb_build_object('ok', false, 'erreur', 'pas_ambassadeur');
  end if;
  if v_iban <> '' and not public.keepo_iban_valide(v_iban) then
    return jsonb_build_object('ok', false, 'erreur', 'iban_invalide');
  end if;

  update public.ambassadeurs
     set pseudo     = case when p_pseudo    is null then pseudo    else nullif(left(btrim(p_pseudo), 60), '')     end,
         reseau     = case when p_reseau    is null then reseau    else nullif(left(btrim(p_reseau), 200), '')    end,
         titulaire  = case when p_titulaire is null then titulaire else nullif(left(btrim(p_titulaire), 100), '') end,
         iban       = case when v_iban = '' then iban else v_iban end,
         updated_at = now()
   where id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.ambassadeur_enregistrer(text, text, text, text) from public, anon;
grant execute on function public.ambassadeur_enregistrer(text, text, text, text) to authenticated;

-- Choisir son code (LEA20, SNACKTOK…), tant qu'aucun commerce ne l'a
-- utilisé : après, le changer casserait les liens déjà partagés.
create or replace function public.ambassadeur_changer_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := public.keepo_code_propre(p_code);
begin
  if v_uid is null or not exists (select 1 from public.ambassadeurs where id = v_uid) then
    return jsonb_build_object('ok', false, 'erreur', 'pas_ambassadeur');
  end if;
  if length(v_code) < 3 or length(v_code) > 16 then
    return jsonb_build_object('ok', false, 'erreur', 'format');
  end if;
  if exists (select 1 from public.affiliations where ambassadeur_id = v_uid) then
    return jsonb_build_object('ok', false, 'erreur', 'deja_utilise');
  end if;
  if exists (select 1 from public.ambassadeurs where code = v_code and id <> v_uid) then
    return jsonb_build_object('ok', false, 'erreur', 'pris');
  end if;
  update public.ambassadeurs set code = v_code, updated_at = now() where id = v_uid;
  return jsonb_build_object('ok', true, 'code', v_code);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'erreur', 'pris');
end;
$$;

revoke all on function public.ambassadeur_changer_code(text) from public, anon;
grant execute on function public.ambassadeur_changer_code(text) to authenticated;


-- ── 8. Le serveur compte les paiements ──────────────────
-- Appelée par le Worker à chaque facture payée (montant > 0). La prime
-- devient due à la 2ᵉ facture, ou dès la 1ʳᵉ si elle couvre plus d'un
-- mois (abonnement annuel : p_longue). Renvoie nouvelle_prime = true une
-- seule fois, pour la notification Discord.
create or replace function public.keepo_affiliation_paiement(
  p_merchant      uuid,
  p_invoice       text,
  p_montant_cents int     default 0,
  p_longue        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_aff   record;
  v_apres record;
  v_du    int;
begin
  if p_merchant is null or nullif(btrim(p_invoice), '') is null then
    return jsonb_build_object('affilie', false);
  end if;

  select * into v_aff from public.affiliations where merchant_id = p_merchant for update;
  if not found then
    return jsonb_build_object('affilie', false);
  end if;

  insert into public.affiliation_factures (invoice_id, affiliation_id, montant_cents)
  values (p_invoice, v_aff.id, greatest(coalesce(p_montant_cents, 0), 0))
  on conflict (invoice_id) do nothing;
  if not found then
    return jsonb_build_object('affilie', true, 'deja_comptee', true);
  end if;

  update public.affiliations
     set factures_payees = factures_payees + 1,
         prime_due_at    = case when prime_due_at is null
                                 and (factures_payees + 1 >= 2 or coalesce(p_longue, false))
                                then now() else prime_due_at end
   where id = v_aff.id
  returning * into v_apres;

  select coalesce(sum(prime_cents), 0) into v_du
    from public.affiliations
   where ambassadeur_id = v_aff.ambassadeur_id
     and prime_due_at is not null and versement_id is null;

  return jsonb_build_object(
    'affilie',        true,
    'factures',       v_apres.factures_payees,
    'nouvelle_prime', v_aff.prime_due_at is null and v_apres.prime_due_at is not null,
    'code',           v_aff.code,
    'a_verser_cents', v_du);
end;
$$;

revoke all on function public.keepo_affiliation_paiement(uuid, text, int, boolean) from public, anon, authenticated;
grant execute on function public.keepo_affiliation_paiement(uuid, text, int, boolean) to service_role;


-- ── 9. Les virements du mois (pour Sami, dans l'éditeur SQL) ─
-- Qui payer : les ambassadeurs à qui l'on doit au moins 50 €.
--   select * from keepo_versements_a_faire();
create or replace function public.keepo_versements_a_faire(p_seuil_cents int default 5000)
returns table (
  code       text,
  pseudo     text,
  email      text,
  titulaire  text,
  iban       text,
  primes     int,
  montant    text
)
language sql
stable
security definer
set search_path = public
as $$
  select a.code,
         a.pseudo,
         p.email,
         a.titulaire,
         a.iban,
         count(*)::int,
         replace(to_char(sum(af.prime_cents) / 100.0, 'FM999990.00'), '.', ',') || ' €'
    from public.ambassadeurs a
    join public.affiliations af on af.ambassadeur_id = a.id
    left join public.profiles p on p.id = a.id
   where af.prime_due_at is not null
     and af.versement_id is null
   group by a.id, a.code, a.pseudo, p.email, a.titulaire, a.iban
  having sum(af.prime_cents) >= p_seuil_cents
   order by sum(af.prime_cents) desc;
$$;

revoke all on function public.keepo_versements_a_faire(int) from public, anon, authenticated;
grant execute on function public.keepo_versements_a_faire(int) to service_role;

-- Après le virement : marque toutes les primes dues de cet ambassadeur
-- comme versées.
--   select keepo_marquer_verse('LEA27', 'virement novembre');
create or replace function public.keepo_marquer_verse(p_code text, p_reference text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amb    uuid;
  v_vers   uuid;
  v_total  int;
  v_primes int;
begin
  select id into v_amb from public.ambassadeurs where code = public.keepo_code_propre(p_code);
  if not found then
    return 'Code inconnu : ' || coalesce(p_code, '');
  end if;

  select coalesce(sum(prime_cents), 0), count(*) into v_total, v_primes
    from public.affiliations
   where ambassadeur_id = v_amb and prime_due_at is not null and versement_id is null;
  if v_primes = 0 then
    return 'Rien à verser pour ' || p_code;
  end if;

  insert into public.ambassadeur_versements (ambassadeur_id, montant_cents, primes, reference)
  values (v_amb, v_total, v_primes, p_reference)
  returning id into v_vers;

  update public.affiliations
     set versement_id = v_vers
   where ambassadeur_id = v_amb and prime_due_at is not null and versement_id is null;

  return 'Versement enregistré : ' || replace(to_char(v_total / 100.0, 'FM999990.00'), '.', ',') || ' € ('
         || v_primes || ' prime' || case when v_primes > 1 then 's' else '' end || ')';
end;
$$;

revoke all on function public.keepo_marquer_verse(text, text) from public, anon, authenticated;
grant execute on function public.keepo_marquer_verse(text, text) to service_role;
