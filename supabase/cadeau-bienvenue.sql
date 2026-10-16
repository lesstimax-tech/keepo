-- ════════════════════════════════════════════════════════
--  CADEAU DE BIENVENUE — offert à chaque nouveau membre
-- ════════════════════════════════════════════════════════
-- À exécuter une fois dans Supabase → SQL Editor. Rejouable sans risque.
--
-- Le commerçant choisit, s'il le souhaite, un cadeau (produit offert) ou
-- une réduction. Chaque client qui rejoint le programme le reçoit une
-- seule fois : il s'affiche sur sa carte avec un code, et le commerçant
-- le marque comme remis en scannant le client ou en saisissant le code.
--
-- Une carte retirée puis remise dans le portefeuille n'en redonne pas :
-- la remise est un UPDATE, le cadeau n'est attribué qu'à l'INSERT.
-- Activer le cadeau ne concerne que les nouveaux membres.


-- ── 1. Le réglage du commerçant ─────────────────────────
alter table public.merchant_cards add column if not exists welcome_enabled boolean not null default false;
alter table public.merchant_cards add column if not exists welcome_type    text    not null default 'gift';
alter table public.merchant_cards add column if not exists welcome_label   text;

do $$ begin
  alter table public.merchant_cards add constraint merchant_cards_welcome_type_check
    check (welcome_type in ('gift', 'discount'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.merchant_cards add constraint merchant_cards_welcome_label_len
    check (welcome_label is null or char_length(welcome_label) <= 80);
exception when duplicate_object then null;
end $$;


-- ── 2. Le cadeau de chaque membre ───────────────────────
-- Le libellé est recopié à l'inscription : si le commerçant change son
-- offre ensuite, le client garde celle qu'on lui a promise.
alter table public.loyalty_balances add column if not exists welcome_gift     text;
alter table public.loyalty_balances add column if not exists welcome_type     text;
alter table public.loyalty_balances add column if not exists welcome_code     text;
alter table public.loyalty_balances add column if not exists welcome_given_at timestamptz;


-- ── 3. Attribution à l'inscription ──────────────────────
-- Le client peut insérer sa propre ligne (policy balances_client_join) :
-- le déclencheur écrase donc tout ce qu'il aurait pu y mettre.
create or replace function public.keepo_attribuer_cadeau_bienvenue()
returns trigger
language plpgsql
security definer
set search_path = public
as $cadeau$
declare
  v_actif boolean;
  v_type  text;
  v_label text;
begin
  new.welcome_gift     := null;
  new.welcome_type     := null;
  new.welcome_code     := null;
  new.welcome_given_at := null;

  select welcome_enabled, welcome_type, nullif(btrim(welcome_label), '')
    into v_actif, v_type, v_label
  from public.merchant_cards
  where merchant_id = new.merchant_id;

  if coalesce(v_actif, false) and v_label is not null then
    new.welcome_gift := v_label;
    new.welcome_type := coalesce(v_type, 'gift');
    new.welcome_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  end if;

  return new;
end;
$cadeau$;

drop trigger if exists loyalty_balances_cadeau_bienvenue on public.loyalty_balances;

create trigger loyalty_balances_cadeau_bienvenue
  before insert on public.loyalty_balances
  for each row execute function public.keepo_attribuer_cadeau_bienvenue();


-- ── 4. Remise du cadeau (côté commerçant) ───────────────
-- Par client (scan du QR) ou par code (saisi au terminal ou en caisse).
-- Retourne { client_name, gift, type }.
create or replace function public.remettre_cadeau_bienvenue(
  p_client_id uuid default null,
  p_code      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $remise$
declare
  v_merchant uuid := auth.uid();
  v_ligne    record;
begin
  if v_merchant is null then raise exception 'Non authentifié'; end if;
  if p_client_id is null and nullif(btrim(p_code), '') is null then
    raise exception 'Client ou code manquant';
  end if;

  select lb.id, lb.welcome_gift, lb.welcome_type, lb.welcome_given_at,
         p.name as client_name
    into v_ligne
  from public.loyalty_balances lb
  join public.profiles p on p.id = lb.client_id
  where lb.merchant_id = v_merchant
    and lb.welcome_gift is not null
    and (case when p_client_id is not null then lb.client_id = p_client_id
              else lb.welcome_code = upper(btrim(p_code)) end)
  for update of lb;

  if not found then
    raise exception 'Aucun cadeau de bienvenue pour ce client';
  end if;

  if v_ligne.welcome_given_at is not null then
    raise exception 'Cadeau de bienvenue déjà remis le %',
      to_char(v_ligne.welcome_given_at at time zone 'Europe/Paris', 'DD/MM/YYYY HH24:MI');
  end if;

  update public.loyalty_balances set welcome_given_at = now() where id = v_ligne.id;

  return jsonb_build_object(
    'client_name', v_ligne.client_name,
    'gift',        v_ligne.welcome_gift,
    'type',        v_ligne.welcome_type
  );
end;
$remise$;

revoke all on function public.remettre_cadeau_bienvenue(uuid, text) from public;
grant execute on function public.remettre_cadeau_bienvenue(uuid, text) to authenticated;
