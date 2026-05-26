-- ════════════════════════════════════════════════════════
--  KEEPO — Schéma complet
--  Exécuter dans Supabase → SQL Editor
--  (idempotent : peut être relancé sans risque)
-- ════════════════════════════════════════════════════════

-- ── PROFILES ──────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default 'Utilisateur',
  email      text,
  role       text not null default 'client' check (role in ('client', 'commercant')),
  plan       text not null default 'essential' check (plan in ('essential', 'pro', 'pro scale')),
  created_at timestamptz default now()
);

-- Colonnes ajoutées si migration depuis ancienne version
alter table public.profiles add column if not exists email      text;
alter table public.profiles add column if not exists plan       text not null default 'essential';
alter table public.profiles add column if not exists avatar_url text;  -- data URL base64 256x256

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own"       on public.profiles;
drop policy if exists "profiles_update_own"        on public.profiles;
drop policy if exists "profiles_insert_own_client" on public.profiles;
drop policy if exists "profiles_insert_any"        on public.profiles;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_insert_any" on public.profiles
  for insert with check (auth.uid() = id);

-- ── TRIGGER : créer le profil à l'inscription ─────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email, role, plan)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', 'Utilisateur'),
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'client'),
    coalesce(nullif(new.raw_user_meta_data->>'plan', ''), 'essential')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── CARTES COMMERÇANT ─────────────────────────────────
create table if not exists public.merchant_cards (
  merchant_id     uuid primary key references public.profiles(id) on delete cascade,
  title           text not null,
  color           text default '#00e8cc',
  address         text,
  points_per_euro numeric default 0.1,
  studio_json     text,     -- JSON: {txtColor, borderColor, opacity, bg (base64)}
  updated_at      timestamptz default now()
);

-- Migrations : colonnes ajoutées progressivement
alter table public.merchant_cards add column if not exists studio_json     text;
alter table public.merchant_cards add column if not exists points_per_euro numeric default 0.1;
alter table public.merchant_cards add column if not exists address         text;
alter table public.merchant_cards add column if not exists updated_at      timestamptz default now();

alter table public.merchant_cards enable row level security;

drop policy if exists "merchant_cards_read"  on public.merchant_cards;
drop policy if exists "merchant_cards_write" on public.merchant_cards;

create policy "merchant_cards_read" on public.merchant_cards
  for select using (true);

create policy "merchant_cards_write" on public.merchant_cards
  for all using (auth.uid() = merchant_id)
  with check (auth.uid() = merchant_id);

-- ── RÉCOMPENSES ──────────────────────────────────────
create table if not exists public.rewards (
  id               bigserial primary key,
  merchant_id      uuid not null references public.profiles(id) on delete cascade,
  name             text not null,
  points_required  int  not null check (points_required > 0),
  created_at       timestamptz default now()
);

alter table public.rewards enable row level security;

drop policy if exists "rewards_read"  on public.rewards;
drop policy if exists "rewards_write" on public.rewards;

create policy "rewards_read" on public.rewards
  for select using (true);

create policy "rewards_write" on public.rewards
  for all using (auth.uid() = merchant_id)
  with check (auth.uid() = merchant_id);

-- ── SOLDES DE FIDÉLITÉ ────────────────────────────────
-- ⚠️  Colonne : points_balance (pas "points")
create table if not exists public.loyalty_balances (
  id             uuid default gen_random_uuid() primary key,
  merchant_id    uuid not null references public.profiles(id) on delete cascade,
  client_id      uuid not null references public.profiles(id) on delete cascade,
  points_balance int  not null default 0 check (points_balance >= 0),
  created_at     timestamptz default now(),
  unique (merchant_id, client_id)
);

-- Migration : si la table existait avec la colonne "points" → la renommer
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'loyalty_balances'
      and column_name  = 'points'
  ) then
    alter table public.loyalty_balances rename column points to points_balance;
  end if;
end;
$$;

-- Ajouter la colonne "id" si elle manque (ancienne PK composite)
alter table public.loyalty_balances add column if not exists id uuid default gen_random_uuid();
alter table public.loyalty_balances add column if not exists points_balance int not null default 0;
alter table public.loyalty_balances add column if not exists created_at timestamptz default now();

alter table public.loyalty_balances enable row level security;

drop policy if exists "balances_read"            on public.loyalty_balances;
drop policy if exists "balances_client_read"     on public.loyalty_balances;
drop policy if exists "balances_client_join"     on public.loyalty_balances;
drop policy if exists "balances_merchant_update" on public.loyalty_balances;

create policy "balances_read" on public.loyalty_balances
  for select using (auth.uid() = client_id or auth.uid() = merchant_id);

create policy "balances_client_join" on public.loyalty_balances
  for insert with check (auth.uid() = client_id);

create policy "balances_merchant_update" on public.loyalty_balances
  for update using (auth.uid() = merchant_id);

-- ── TRANSACTIONS ─────────────────────────────────────
create table if not exists public.transactions (
  id             bigserial primary key,
  merchant_id    uuid     not null references public.profiles(id) on delete cascade,
  client_id      uuid     not null references public.profiles(id) on delete cascade,
  amount         numeric  default 0,
  points_changed int      not null,
  type           text     not null check (type in ('credit', 'debit')),
  claim_code     text,        -- code 6-chars généré lors d'un debit client
  validated_at   timestamptz, -- horodatage quand le commerçant valide le code
  created_at     timestamptz default now()
);

-- Migrations si table existait sans ces colonnes
alter table public.transactions add column if not exists claim_code   text;
alter table public.transactions add column if not exists validated_at timestamptz;

alter table public.transactions enable row level security;

drop policy if exists "transactions_read"            on public.transactions;
drop policy if exists "transactions_merchant_insert" on public.transactions;

create policy "transactions_read" on public.transactions
  for select using (auth.uid() = client_id or auth.uid() = merchant_id);

create policy "transactions_merchant_insert" on public.transactions
  for insert with check (auth.uid() = merchant_id);

-- ── RPC : créditer des points ─────────────────────────
create or replace function public.apply_loyalty_credit(
  p_merchant_id uuid,
  p_client_id   uuid,
  p_amount      numeric,
  p_points      int
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_new int;
begin
  if auth.uid() is distinct from p_merchant_id then
    raise exception 'Non autorisé';
  end if;

  insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
  values (p_merchant_id, p_client_id, p_amount, p_points, 'credit');

  insert into public.loyalty_balances (merchant_id, client_id, points_balance)
  values (p_merchant_id, p_client_id, p_points)
  on conflict (merchant_id, client_id)
  do update set points_balance = loyalty_balances.points_balance + excluded.points_balance
  returning points_balance into v_new;

  return v_new;
end;
$$;

-- ── RPC : débiter une récompense ──────────────────────
create or replace function public.apply_loyalty_debit(
  p_merchant_id uuid,
  p_client_id   uuid,
  p_points      int
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_current int;
  v_new     int;
begin
  if auth.uid() is distinct from p_merchant_id then
    raise exception 'Non autorisé';
  end if;

  select points_balance into v_current
  from public.loyalty_balances
  where merchant_id = p_merchant_id and client_id = p_client_id
  for update;

  if v_current is null or v_current < p_points then
    raise exception 'Solde insuffisant';
  end if;

  insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
  values (p_merchant_id, p_client_id, 0, -p_points, 'debit');

  update public.loyalty_balances
  set points_balance = points_balance - p_points
  where merchant_id = p_merchant_id and client_id = p_client_id
  returning points_balance into v_new;

  return v_new;
end;
$$;

grant execute on function public.apply_loyalty_credit to authenticated;
grant execute on function public.apply_loyalty_debit  to authenticated;

-- ── RPC : réclamer une récompense (côté client) ───────
-- Retourne jsonb { balance: int, code: text }
-- DROP obligatoire car le type de retour change (int → jsonb)
drop function if exists public.apply_reward_claim_by_client(uuid, integer);

create or replace function public.apply_reward_claim_by_client(
  p_merchant_id uuid,
  p_points      int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_current int;
  v_new     int;
  v_client  uuid;
  v_code    text;
begin
  v_client := auth.uid();
  if v_client is null then raise exception 'Non authentifié'; end if;
  if p_points <= 0 then raise exception 'Montant invalide'; end if;

  select points_balance into v_current
  from public.loyalty_balances
  where merchant_id = p_merchant_id and client_id = v_client
  for update;

  if v_current is null then
    raise exception 'Aucune carte trouvée pour ce commerçant';
  end if;
  if v_current < p_points then
    raise exception 'Solde insuffisant (% pts disponibles, % pts requis)', v_current, p_points;
  end if;

  -- Code court unique 6 chars (hex majuscule)
  v_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.transactions (merchant_id, client_id, amount, points_changed, type, claim_code)
  values (p_merchant_id, v_client, 0, -p_points, 'debit', v_code);

  update public.loyalty_balances
  set points_balance = points_balance - p_points
  where merchant_id = p_merchant_id and client_id = v_client
  returning points_balance into v_new;

  return jsonb_build_object('balance', v_new, 'code', v_code);
end;
$$;

grant execute on function public.apply_reward_claim_by_client to authenticated;

-- ── RPC : valider un code de récompense (côté commerçant) ─
create or replace function public.validate_claim_code(
  p_code text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_merchant uuid;
  v_tx       record;
begin
  v_merchant := auth.uid();
  if v_merchant is null then raise exception 'Non authentifié'; end if;

  select t.id, t.client_id, t.points_changed, t.created_at, t.validated_at,
         p.name as client_name
  into v_tx
  from public.transactions t
  join public.profiles p on p.id = t.client_id
  where t.merchant_id  = v_merchant
    and t.claim_code   = upper(p_code)
    and t.type         = 'debit'
  order by t.created_at desc
  limit 1;

  if v_tx is null then
    raise exception 'Code invalide ou ne correspond pas à votre commerce';
  end if;

  if v_tx.validated_at is not null then
    raise exception 'Ce code a déjà été validé le %',
      to_char(v_tx.validated_at at time zone 'Europe/Paris', 'DD/MM/YYYY HH24:MI');
  end if;

  -- Marquer comme validé
  update public.transactions
  set validated_at = now()
  where id = v_tx.id;

  return jsonb_build_object(
    'client_name',    v_tx.client_name,
    'points_debited', abs(v_tx.points_changed),
    'claimed_at',     to_char(v_tx.created_at at time zone 'Europe/Paris', 'DD/MM/YYYY HH24:MI')
  );
end;
$$;

grant execute on function public.validate_claim_code to authenticated;

-- ── ÉVÉNEMENTS MULTIPLICATEURS ────────────────────
create table if not exists public.events (
  id             bigserial primary key,
  merchant_id    uuid not null references public.profiles(id) on delete cascade,
  name           text not null,
  multiplier     int  not null default 2 check (multiplier in (2, 3, 5)),
  starts_at      date not null,
  ends_at        date not null,
  notify_clients boolean default false,
  created_at     timestamptz default now()
);

alter table public.events enable row level security;

drop policy if exists "events_read"  on public.events;
drop policy if exists "events_write" on public.events;

create policy "events_read" on public.events
  for select using (auth.uid() = merchant_id);

create policy "events_write" on public.events
  for all using (auth.uid() = merchant_id)
  with check (auth.uid() = merchant_id);

-- ── AUTOMATIONS DE NOTIFICATION ───────────────────────────
create table if not exists public.notification_automations (
  id            bigserial primary key,
  merchant_id   uuid     not null references public.profiles(id) on delete cascade,
  type          text     not null check (type in ('relance','avis','offre','custom')),
  subject       text     not null,
  body          text     not null,
  trigger_days  int,
  trigger_mins  int,
  date_start    date,
  date_end      date,
  trigger_mode  text     check (trigger_mode in ('imm','delay','date')),
  delay_val     int,
  delay_unit    text     check (delay_unit in ('min','h','d')),
  send_date     timestamptz,
  active        boolean  not null default true,
  last_run_at   timestamptz,
  created_at    timestamptz default now()
);

alter table public.notification_automations enable row level security;

drop policy if exists "notif_auto_select" on public.notification_automations;
drop policy if exists "notif_auto_write"  on public.notification_automations;

create policy "notif_auto_select" on public.notification_automations
  for select using (auth.uid() = merchant_id);

create policy "notif_auto_write" on public.notification_automations
  for all using (auth.uid() = merchant_id)
  with check (auth.uid() = merchant_id);

-- ── LOGS D'ENVOIS EMAIL ───────────────────────────────────
create table if not exists public.notification_sends (
  id              bigserial primary key,
  automation_id   bigint   references public.notification_automations(id) on delete set null,
  merchant_id     uuid     not null references public.profiles(id) on delete cascade,
  client_id       uuid     references public.profiles(id) on delete set null,
  recipient_email text     not null,
  subject         text     not null,
  status          text     not null default 'sent' check (status in ('sent','failed','test')),
  error_msg       text,
  sent_at         timestamptz default now()
);

alter table public.notification_sends enable row level security;

drop policy if exists "notif_sends_select" on public.notification_sends;
drop policy if exists "notif_sends_insert" on public.notification_sends;

create policy "notif_sends_select" on public.notification_sends
  for select using (auth.uid() = merchant_id);

create policy "notif_sends_insert" on public.notification_sends
  for insert with check (true);
