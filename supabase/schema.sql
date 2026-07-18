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

drop policy if exists "profiles_select_own"            on public.profiles;
drop policy if exists "profiles_update_own"             on public.profiles;
drop policy if exists "profiles_insert_own_client"      on public.profiles;
drop policy if exists "profiles_insert_any"             on public.profiles;
drop policy if exists "profiles_merchant_read_members"  on public.profiles;

-- Lecture de son propre profil
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

-- Un commerçant peut lire le profil de ses membres (pour la caisse)
create policy "profiles_merchant_read_members" on public.profiles
  for select using (
    exists (
      select 1 from public.loyalty_balances lb
      where lb.client_id = id
        and lb.merchant_id = auth.uid()
    )
  );

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_insert_any" on public.profiles
  for insert with check (auth.uid() = id);

-- ── TRIGGER : créer le profil à l'inscription ─────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role     text := coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'client');
  v_ref_code text := nullif(upper(trim(new.raw_user_meta_data->>'ref_code')), '');
  v_referrer uuid;
begin
  insert into public.profiles (id, name, email, role, plan, referral_code)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', 'Utilisateur'),
    new.email,
    v_role,
    coalesce(nullif(new.raw_user_meta_data->>'plan', ''), 'essential'),
    -- Code de parrainage unique pour les commerçants (dérivé de l'id → jamais de collision)
    case when v_role = 'commercant' then upper(substr(md5(new.id::text), 1, 8)) else null end
  )
  on conflict (id) do nothing;

  -- Parrainage commerçant : si un code de parrain valide accompagne l'inscription,
  -- on enregistre le lien (statut 'pending' — la récompense est versée au 1er paiement).
  if v_role = 'commercant' and v_ref_code is not null then
    select id into v_referrer from public.profiles
      where referral_code = v_ref_code and role = 'commercant' and id <> new.id
      limit 1;
    if v_referrer is not null then
      insert into public.merchant_referrals (referrer_id, referred_id, status)
      values (v_referrer, new.id, 'pending')
      on conflict (referred_id) do nothing;
    end if;
  end if;

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
-- plan dupliqué depuis profiles pour lecture publique (profiles est RLS-restreint aux propriétaires)
alter table public.merchant_cards add column if not exists plan            text not null default 'essential';

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

grant execute on function public.apply_loyalty_credit(uuid, uuid, numeric, int) to authenticated;
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

-- ════════════════════════════════════════════════════════
--  PHASE 3 — Marketing & Engagement
-- ════════════════════════════════════════════════════════

-- ── Colonnes ajoutées au profil client ────────────────
alter table public.profiles add column if not exists birthday      date;
alter table public.profiles add column if not exists referral_code text unique;

-- Génère un code aléatoire à 6 caractères pour les profils qui n'en ont pas
update public.profiles
   set referral_code = upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6))
 where referral_code is null;

-- ── Colonnes config par commerçant (sur merchant_cards) ─
alter table public.merchant_cards add column if not exists referral_bonus           int  default 50;
alter table public.merchant_cards add column if not exists birthday_bonus           int  default 100;
alter table public.merchant_cards add column if not exists wheel_visits_required    int  default 10;
alter table public.merchant_cards add column if not exists wheel_enabled            boolean default true;
alter table public.merchant_cards add column if not exists tier_silver_threshold    int  default 500;
alter table public.merchant_cards add column if not exists tier_gold_threshold      int  default 2000;
alter table public.merchant_cards add column if not exists tier_silver_multiplier   numeric default 1.2;
alter table public.merchant_cards add column if not exists tier_gold_multiplier     numeric default 1.5;

-- ── Compteur de points cumulés (lifetime) pour calculer le tier ─
alter table public.loyalty_balances add column if not exists lifetime_points        int  not null default 0;
alter table public.loyalty_balances add column if not exists last_birthday_bonus    date;
alter table public.loyalty_balances add column if not exists wheel_last_spin_visits int  not null default 0;

-- ── PARRAINAGES ──────────────────────────────────────
create table if not exists public.referrals (
  id           bigserial primary key,
  referrer_id  uuid not null references public.profiles(id) on delete cascade,
  referred_id  uuid not null references public.profiles(id) on delete cascade,
  merchant_id  uuid not null references public.profiles(id) on delete cascade,
  bonus_given  int  not null default 50,
  created_at   timestamptz default now(),
  unique (referred_id, merchant_id)  -- un client ne peut être parrainé qu'une fois par commerce
);

alter table public.referrals enable row level security;

drop policy if exists "referrals_select_own" on public.referrals;
drop policy if exists "referrals_insert_any" on public.referrals;

create policy "referrals_select_own" on public.referrals
  for select using (auth.uid() = referrer_id or auth.uid() = referred_id or auth.uid() = merchant_id);

create policy "referrals_insert_any" on public.referrals
  for insert with check (true);

-- ── ROUE DE LA FORTUNE — historique des tirages ──
create table if not exists public.wheel_spins (
  id          bigserial primary key,
  client_id   uuid not null references public.profiles(id) on delete cascade,
  merchant_id uuid not null references public.profiles(id) on delete cascade,
  prize_type  text not null,    -- 'bonus_pts', 'reward', 'nothing'
  prize_value int  not null default 0,
  prize_label text,
  spun_at     timestamptz default now()
);

alter table public.wheel_spins enable row level security;

drop policy if exists "wheel_spins_select_own"  on public.wheel_spins;
drop policy if exists "wheel_spins_insert_own"  on public.wheel_spins;

create policy "wheel_spins_select_own" on public.wheel_spins
  for select using (auth.uid() = client_id or auth.uid() = merchant_id);

create policy "wheel_spins_insert_own" on public.wheel_spins
  for insert with check (auth.uid() = client_id);

-- ── CARTES CADEAUX ─────────────────────────────────
create table if not exists public.gift_cards (
  id            bigserial primary key,
  code          text not null unique,
  sender_id     uuid not null references public.profiles(id) on delete cascade,
  merchant_id   uuid not null references public.profiles(id) on delete cascade,
  points_amount int  not null check (points_amount > 0),
  sender_msg    text,
  redeemed_by   uuid references public.profiles(id) on delete set null,
  redeemed_at   timestamptz,
  created_at    timestamptz default now()
);

alter table public.gift_cards enable row level security;

drop policy if exists "gift_cards_select_involved" on public.gift_cards;
drop policy if exists "gift_cards_insert_sender"   on public.gift_cards;
drop policy if exists "gift_cards_update_redeem"   on public.gift_cards;

create policy "gift_cards_select_involved" on public.gift_cards
  for select using (auth.uid() = sender_id or auth.uid() = merchant_id or auth.uid() = redeemed_by);

create policy "gift_cards_insert_sender" on public.gift_cards
  for insert with check (auth.uid() = sender_id);

create policy "gift_cards_update_redeem" on public.gift_cards
  for update using (true);  -- toute personne authentifiée peut tenter de redeem; RPC contrôle

-- ════════════════════════════════════════════════════════
--  RPC — Réclamer un code de parrainage
-- ════════════════════════════════════════════════════════
drop function if exists public.claim_referral_code(text, uuid);

create or replace function public.claim_referral_code(
  p_code        text,
  p_merchant_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_referrer    uuid;
  v_client      uuid;
  v_bonus       int;
begin
  v_client := auth.uid();
  if v_client is null then raise exception 'Non authentifié'; end if;

  -- Trouve le parrain via son code
  select id into v_referrer from public.profiles where upper(referral_code) = upper(p_code);
  if v_referrer is null then raise exception 'Code de parrainage invalide'; end if;
  if v_referrer = v_client then raise exception 'Vous ne pouvez pas vous parrainer vous-même'; end if;

  -- Vérifie qu'il n'y a pas déjà un parrainage pour ce client/commerce
  if exists (select 1 from public.referrals where referred_id = v_client and merchant_id = p_merchant_id) then
    raise exception 'Vous avez déjà été parrainé chez ce commerce';
  end if;

  -- Récupère le bonus configuré chez ce commerçant
  select coalesce(referral_bonus, 50) into v_bonus from public.merchant_cards where merchant_id = p_merchant_id;
  if v_bonus is null then v_bonus := 50; end if;

  -- Enregistre le parrainage
  insert into public.referrals (referrer_id, referred_id, merchant_id, bonus_given)
  values (v_referrer, v_client, p_merchant_id, v_bonus);

  -- Crédite les deux (filleul + parrain)
  insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
  values (p_merchant_id, v_client,   0, v_bonus, 'credit'),
         (p_merchant_id, v_referrer, 0, v_bonus, 'credit');

  insert into public.loyalty_balances (merchant_id, client_id, points_balance, lifetime_points)
  values (p_merchant_id, v_client, v_bonus, v_bonus)
  on conflict (merchant_id, client_id)
  do update set points_balance  = loyalty_balances.points_balance  + v_bonus,
                lifetime_points = loyalty_balances.lifetime_points + v_bonus;

  insert into public.loyalty_balances (merchant_id, client_id, points_balance, lifetime_points)
  values (p_merchant_id, v_referrer, v_bonus, v_bonus)
  on conflict (merchant_id, client_id)
  do update set points_balance  = loyalty_balances.points_balance  + v_bonus,
                lifetime_points = loyalty_balances.lifetime_points + v_bonus;

  return jsonb_build_object('bonus', v_bonus, 'referrer_id', v_referrer);
end;
$$;

grant execute on function public.claim_referral_code to authenticated;

-- ════════════════════════════════════════════════════════
--  Colonne lots personnalisés de la roue
-- ════════════════════════════════════════════════════════
alter table public.merchant_cards
  add column if not exists wheel_prizes jsonb;

-- ════════════════════════════════════════════════════════
--  RPC — Spin de la Roue de la Fortune
-- ════════════════════════════════════════════════════════
drop function if exists public.spin_wheel(uuid);

create or replace function public.spin_wheel(
  p_merchant_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client         uuid;
  v_visits         int;
  v_required       int;
  v_last_spin      int;
  v_enabled        boolean;
  v_prizes         jsonb;
  v_default_prizes jsonb;
  v_prize_roll     int;
  v_cumulative     int := 0;
  v_prize_type     text := 'nothing';
  v_prize_value    int  := 0;
  v_prize_label    text := 'Pas de chance';
  v_item           jsonb;
begin
  v_client := auth.uid();
  if v_client is null then raise exception 'Non authentifié'; end if;

  v_default_prizes := '[
    {"label":"Jackpot 500 pts","points":500,"probability":5,"color":"#ffc34d"},
    {"label":"150 pts bonus","points":150,"probability":15,"color":"#7c6af7"},
    {"label":"50 pts bonus","points":50,"probability":25,"color":"#00e8cc"},
    {"label":"20 pts bonus","points":20,"probability":30,"color":"#ff8a5c"},
    {"label":"Pas de chance","points":0,"probability":25,"color":"#3a3556"}
  ]'::jsonb;

  select coalesce(wheel_visits_required, 10),
         coalesce(wheel_enabled, true),
         coalesce(wheel_prizes, v_default_prizes)
  into   v_required, v_enabled, v_prizes
  from   public.merchant_cards where merchant_id = p_merchant_id;

  if not v_enabled then raise exception 'La roue n''est pas activée par ce commerce'; end if;

  select count(*) into v_visits
  from   public.transactions
  where  merchant_id = p_merchant_id and client_id = v_client and type = 'credit';

  select coalesce(wheel_last_spin_visits, 0) into v_last_spin
  from   public.loyalty_balances
  where  merchant_id = p_merchant_id and client_id = v_client;

  if (v_visits - v_last_spin) < v_required then
    raise exception 'Pas encore éligible (% / % visites)', v_visits - v_last_spin, v_required;
  end if;

  -- Tirage aléatoire 0-99
  v_prize_roll := floor(random() * 100)::int;

  -- Détermine le lot gagnant selon les probabilités cumulées
  for v_item in select * from jsonb_array_elements(v_prizes) loop
    v_cumulative := v_cumulative + (v_item->>'probability')::int;
    if v_prize_roll < v_cumulative then
      v_prize_value := coalesce((v_item->>'points')::int, 0);
      v_prize_label := coalesce(v_item->>'label', 'Résultat');
      v_prize_type  := case when v_prize_value > 0 then 'bonus_pts' else 'nothing' end;
      exit;
    end if;
  end loop;

  insert into public.wheel_spins (client_id, merchant_id, prize_type, prize_value, prize_label)
  values (v_client, p_merchant_id, v_prize_type, v_prize_value, v_prize_label);

  update public.loyalty_balances
  set wheel_last_spin_visits = v_visits
  where merchant_id = p_merchant_id and client_id = v_client;

  if v_prize_value > 0 then
    insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
    values (p_merchant_id, v_client, 0, v_prize_value, 'credit');

    update public.loyalty_balances
    set points_balance  = points_balance  + v_prize_value,
        lifetime_points = lifetime_points + v_prize_value
    where merchant_id = p_merchant_id and client_id = v_client;
  end if;

  return jsonb_build_object(
    'prize_type',  v_prize_type,
    'prize_value', v_prize_value,
    'prize_label', v_prize_label,
    'roll',        v_prize_roll,
    'prizes',      v_prizes
  );
end;
$$;

grant execute on function public.spin_wheel(uuid) to authenticated;

-- ════════════════════════════════════════════════════════
--  RPC — Acheter / Échanger une carte cadeau
-- ════════════════════════════════════════════════════════
drop function if exists public.create_gift_card(uuid, int, text);

create or replace function public.create_gift_card(
  p_merchant_id uuid,
  p_points      int,
  p_message     text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sender uuid;
  v_balance int;
  v_code text;
begin
  v_sender := auth.uid();
  if v_sender is null then raise exception 'Non authentifié'; end if;
  if p_points <= 0 then raise exception 'Montant invalide'; end if;

  -- Vérifie le solde
  select points_balance into v_balance
  from public.loyalty_balances
  where merchant_id = p_merchant_id and client_id = v_sender
  for update;

  if v_balance is null or v_balance < p_points then
    raise exception 'Solde insuffisant (% disponibles, % requis)', coalesce(v_balance, 0), p_points;
  end if;

  -- Code unique 8 caractères
  v_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  -- Débite l'expéditeur
  insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
  values (p_merchant_id, v_sender, 0, -p_points, 'debit');

  update public.loyalty_balances
  set points_balance = points_balance - p_points
  where merchant_id = p_merchant_id and client_id = v_sender;

  -- Crée la carte cadeau
  insert into public.gift_cards (code, sender_id, merchant_id, points_amount, sender_msg)
  values (v_code, v_sender, p_merchant_id, p_points, p_message);

  return jsonb_build_object('code', v_code, 'points', p_points);
end;
$$;

grant execute on function public.create_gift_card to authenticated;

drop function if exists public.redeem_gift_card(text);

create or replace function public.redeem_gift_card(
  p_code text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client      uuid;
  v_card        record;
begin
  v_client := auth.uid();
  if v_client is null then raise exception 'Non authentifié'; end if;

  select * into v_card from public.gift_cards where upper(code) = upper(p_code) for update;
  if v_card is null then raise exception 'Carte cadeau introuvable'; end if;
  if v_card.redeemed_by is not null then raise exception 'Cette carte cadeau a déjà été utilisée'; end if;
  if v_card.sender_id = v_client then raise exception 'Vous ne pouvez pas utiliser votre propre carte cadeau'; end if;

  -- Marque comme utilisée
  update public.gift_cards
  set redeemed_by = v_client, redeemed_at = now()
  where id = v_card.id;

  -- Crédite le destinataire
  insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
  values (v_card.merchant_id, v_client, 0, v_card.points_amount, 'credit');

  insert into public.loyalty_balances (merchant_id, client_id, points_balance, lifetime_points)
  values (v_card.merchant_id, v_client, v_card.points_amount, v_card.points_amount)
  on conflict (merchant_id, client_id)
  do update set points_balance  = loyalty_balances.points_balance  + v_card.points_amount,
                lifetime_points = loyalty_balances.lifetime_points + v_card.points_amount;

  return jsonb_build_object('points', v_card.points_amount, 'merchant_id', v_card.merchant_id);
end;
$$;

grant execute on function public.redeem_gift_card to authenticated;

-- ════════════════════════════════════════════════════════
--  RPC — Anniversaire : crédite le bonus si applicable
-- ════════════════════════════════════════════════════════
drop function if exists public.claim_birthday_bonus(uuid);

create or replace function public.claim_birthday_bonus(
  p_merchant_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client    uuid;
  v_birthday  date;
  v_today     date := current_date;
  v_last      date;
  v_bonus     int;
begin
  v_client := auth.uid();
  if v_client is null then raise exception 'Non authentifié'; end if;

  select birthday into v_birthday from public.profiles where id = v_client;
  if v_birthday is null then return jsonb_build_object('claimed', false, 'reason', 'no_birthday'); end if;

  -- Date d'anniversaire cette année
  if extract(month from v_today) <> extract(month from v_birthday)
     or extract(day from v_today) <> extract(day from v_birthday) then
    return jsonb_build_object('claimed', false, 'reason', 'not_today');
  end if;

  -- Déjà crédité cette année ?
  select last_birthday_bonus into v_last
  from public.loyalty_balances
  where merchant_id = p_merchant_id and client_id = v_client;
  if v_last is not null and extract(year from v_last) = extract(year from v_today) then
    return jsonb_build_object('claimed', false, 'reason', 'already_claimed_this_year');
  end if;

  -- Bonus config
  select coalesce(birthday_bonus, 100) into v_bonus from public.merchant_cards where merchant_id = p_merchant_id;
  if v_bonus is null or v_bonus <= 0 then return jsonb_build_object('claimed', false, 'reason', 'disabled'); end if;

  -- Crédite
  insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
  values (p_merchant_id, v_client, 0, v_bonus, 'credit');

  insert into public.loyalty_balances (merchant_id, client_id, points_balance, lifetime_points, last_birthday_bonus)
  values (p_merchant_id, v_client, v_bonus, v_bonus, v_today)
  on conflict (merchant_id, client_id)
  do update set points_balance      = loyalty_balances.points_balance  + v_bonus,
                lifetime_points     = loyalty_balances.lifetime_points + v_bonus,
                last_birthday_bonus = v_today;

  return jsonb_build_object('claimed', true, 'bonus', v_bonus);
end;
$$;

grant execute on function public.claim_birthday_bonus to authenticated;

-- ════════════════════════════════════════════════════════
--  Mise à jour automatique du compteur lifetime_points
--  via trigger sur transactions (type = credit)
-- ════════════════════════════════════════════════════════
create or replace function public.bump_lifetime_points()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'credit' and new.points_changed > 0 then
    update public.loyalty_balances
    set lifetime_points = lifetime_points + new.points_changed
    where merchant_id = new.merchant_id and client_id = new.client_id
      and not exists (
        -- évite double-bump pour les RPC qui maintiennent déjà lifetime_points (referral, wheel, gift)
        select 1 from public.transactions
        where id = new.id and false
      );
  end if;
  return new;
end;
$$;
-- (Trigger optionnel : les RPC actuelles gèrent déjà lifetime_points elles-mêmes,
--  donc on n'active PAS de trigger global ici pour éviter les doubles comptages.
--  La RPC apply_loyalty_credit standard sera modifiée pour incrémenter lifetime_points.)

-- ── Mise à jour de apply_loyalty_credit pour gérer le tier + lifetime
drop function if exists public.apply_loyalty_credit(uuid, uuid, numeric, int);

create or replace function public.apply_loyalty_credit(
  p_merchant_id uuid,
  p_client_id   uuid,
  p_amount      numeric,
  p_points      int
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_new                  int;
  v_lifetime_before      int;
  v_silver_threshold     int;
  v_gold_threshold       int;
  v_silver_mult          numeric;
  v_gold_mult            numeric;
  v_final_points         int := p_points;
begin
  if auth.uid() is distinct from p_merchant_id then
    raise exception 'Non autorisé';
  end if;

  -- Récupère le tier actuel du client (avant ce crédit)
  select coalesce(lifetime_points, 0) into v_lifetime_before
  from public.loyalty_balances
  where merchant_id = p_merchant_id and client_id = p_client_id;
  v_lifetime_before := coalesce(v_lifetime_before, 0);

  -- Récupère config tier du commerçant
  select coalesce(tier_silver_threshold, 500), coalesce(tier_gold_threshold, 2000),
         coalesce(tier_silver_multiplier, 1.2), coalesce(tier_gold_multiplier, 1.5)
  into   v_silver_threshold, v_gold_threshold, v_silver_mult, v_gold_mult
  from   public.merchant_cards where merchant_id = p_merchant_id;

  -- Applique le multiplicateur selon le tier
  if v_lifetime_before >= coalesce(v_gold_threshold, 2000) then
    v_final_points := round(p_points * coalesce(v_gold_mult, 1.5))::int;
  elsif v_lifetime_before >= coalesce(v_silver_threshold, 500) then
    v_final_points := round(p_points * coalesce(v_silver_mult, 1.2))::int;
  end if;

  insert into public.transactions (merchant_id, client_id, amount, points_changed, type)
  values (p_merchant_id, p_client_id, p_amount, v_final_points, 'credit');

  insert into public.loyalty_balances (merchant_id, client_id, points_balance, lifetime_points)
  values (p_merchant_id, p_client_id, v_final_points, v_final_points)
  on conflict (merchant_id, client_id)
  do update set points_balance  = loyalty_balances.points_balance  + v_final_points,
                lifetime_points = loyalty_balances.lifetime_points + v_final_points
  returning points_balance into v_new;

  return v_new;
end;
$$;

grant execute on function public.apply_loyalty_credit(uuid, uuid, numeric, int) to authenticated;


-- ════════════════════════════════════════════════════════
--  PHASE 4 — Architecture pro
-- ════════════════════════════════════════════════════════

-- ── #21 GÉOLOCALISATION : lat/lng sur les commerces ──
alter table public.merchant_cards add column if not exists latitude  numeric(9,6);
alter table public.merchant_cards add column if not exists longitude numeric(9,6);

create index if not exists idx_merchant_cards_geo
  on public.merchant_cards(latitude, longitude)
  where latitude is not null and longitude is not null;

-- ── #15 MULTI-CAISSIERS : employés rattachés à un commerce ──
create table if not exists public.cashiers (
  id           bigserial primary key,
  merchant_id  uuid not null references public.profiles(id) on delete cascade,
  name         text not null,
  pin_hash     text not null,
  role         text not null default 'cashier' check (role in ('cashier','manager')),
  active       boolean not null default true,
  created_at   timestamptz default now()
);

alter table public.cashiers enable row level security;

drop policy if exists "cashiers_select_own" on public.cashiers;
drop policy if exists "cashiers_write_own"  on public.cashiers;

create policy "cashiers_select_own" on public.cashiers
  for select using (auth.uid() = merchant_id);

create policy "cashiers_write_own" on public.cashiers
  for all using (auth.uid() = merchant_id)
  with check (auth.uid() = merchant_id);

create table if not exists public.cashier_audit (
  id           bigserial primary key,
  merchant_id  uuid not null references public.profiles(id) on delete cascade,
  cashier_id   bigint references public.cashiers(id) on delete set null,
  cashier_name text,
  action       text not null,
  client_id    uuid,
  meta         jsonb,
  created_at   timestamptz default now()
);

alter table public.cashier_audit enable row level security;

drop policy if exists "audit_select_own" on public.cashier_audit;
drop policy if exists "audit_insert_any" on public.cashier_audit;

create policy "audit_select_own" on public.cashier_audit
  for select using (auth.uid() = merchant_id);

create policy "audit_insert_any" on public.cashier_audit
  for insert with check (true);

-- ── #14 STRIPE : références client + abonnement ──
alter table public.profiles add column if not exists stripe_customer_id     text;
alter table public.profiles add column if not exists stripe_subscription_id text;
alter table public.profiles add column if not exists plan_renews_at         timestamptz;

-- ════════════════════════════════════════════════════════
--  PHASE 5 — Multi-boutique
-- ════════════════════════════════════════════════════════

-- ── BOUTIQUES ────────────────────────────────────────────
-- Un commerçant peut avoir plusieurs points de vente physiques.
-- La fidélité (loyalty_balances) reste partagée par merchant_id.
create table if not exists public.boutiques (
    id          uuid primary key default gen_random_uuid(),
    merchant_id uuid not null references public.profiles(id) on delete cascade,
    name        text not null,
    address     text,
    is_active   boolean not null default true,
    created_at  timestamptz default now()
);

alter table public.boutiques enable row level security;

drop policy if exists "boutiques_read"  on public.boutiques;
drop policy if exists "boutiques_write" on public.boutiques;

-- Tout le monde peut lire (client qui scanne le QR d'une boutique)
create policy "boutiques_read" on public.boutiques
    for select using (true);

-- Seul le commerçant propriétaire peut écrire
create policy "boutiques_write" on public.boutiques
    for all using (auth.uid() = merchant_id)
    with check (auth.uid() = merchant_id);

-- ── Colonne boutique_id sur les transactions ─────────────
-- Permet de savoir dans quelle boutique chaque transaction a eu lieu.
alter table public.transactions add column if not exists boutique_id uuid references public.boutiques(id) on delete set null;

-- ── Mise à jour de apply_loyalty_credit pour passer boutique_id ──
drop function if exists public.apply_loyalty_credit(uuid, uuid, numeric, int, uuid);
drop function if exists public.apply_loyalty_credit(uuid, uuid, numeric, int);

create or replace function public.apply_loyalty_credit(
  p_merchant_id uuid,
  p_client_id   uuid,
  p_amount      numeric,
  p_points      int,
  p_boutique_id uuid default null
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_new                  int;
  v_lifetime_before      int;
  v_silver_threshold     int;
  v_gold_threshold       int;
  v_silver_mult          numeric;
  v_gold_mult            numeric;
  v_final_points         int := p_points;
begin
  if auth.uid() is distinct from p_merchant_id then
    raise exception 'Non autorisé';
  end if;

  -- Récupère le tier actuel du client (avant ce crédit)
  select coalesce(lifetime_points, 0) into v_lifetime_before
  from public.loyalty_balances
  where merchant_id = p_merchant_id and client_id = p_client_id;
  v_lifetime_before := coalesce(v_lifetime_before, 0);

  -- Récupère config tier du commerçant
  select coalesce(tier_silver_threshold, 500), coalesce(tier_gold_threshold, 2000),
         coalesce(tier_silver_multiplier, 1.2), coalesce(tier_gold_multiplier, 1.5)
  into   v_silver_threshold, v_gold_threshold, v_silver_mult, v_gold_mult
  from   public.merchant_cards where merchant_id = p_merchant_id;

  -- Applique le multiplicateur selon le tier
  if v_lifetime_before >= coalesce(v_gold_threshold, 2000) then
    v_final_points := round(p_points * coalesce(v_gold_mult, 1.5))::int;
  elsif v_lifetime_before >= coalesce(v_silver_threshold, 500) then
    v_final_points := round(p_points * coalesce(v_silver_mult, 1.2))::int;
  end if;

  insert into public.transactions (merchant_id, client_id, amount, points_changed, type, boutique_id)
  values (p_merchant_id, p_client_id, p_amount, v_final_points, 'credit', p_boutique_id);

  insert into public.loyalty_balances (merchant_id, client_id, points_balance, lifetime_points)
  values (p_merchant_id, p_client_id, v_final_points, v_final_points)
  on conflict (merchant_id, client_id)
  do update set points_balance  = loyalty_balances.points_balance  + v_final_points,
                lifetime_points = loyalty_balances.lifetime_points + v_final_points
  returning points_balance into v_new;

  return v_new;
end;
$$;

grant execute on function public.apply_loyalty_credit(uuid, uuid, numeric, int, uuid) to authenticated;

-- ── PHASE 6 — Lecture publique du plan commerçant ──────────
-- Les clients ne peuvent pas lire profiles (RLS restreint au propriétaire).
-- Cette fonction SECURITY DEFINER contourne le RLS pour exposer uniquement
-- le champ `plan` des commerçants demandés.
create or replace function public.get_merchant_plans(p_merchant_ids uuid[])
returns table(merchant_id uuid, plan text)
language sql
security definer
stable
set search_path = public
as $$
  select id as merchant_id, coalesce(plan, 'essential') as plan
  from public.profiles
  where id = any(p_merchant_ids);
$$;

grant execute on function public.get_merchant_plans(uuid[]) to authenticated, anon;

-- ════════════════════════════════════════════════════════
--  PHASE 7 — Pages publiques commerçants (/c/[slug])
-- ════════════════════════════════════════════════════════
alter table public.merchant_cards add column if not exists slug text unique;

create index if not exists idx_merchant_cards_slug
  on public.merchant_cards(slug)
  where slug is not null;

-- ════════════════════════════════════════════════════════
--  PHASE 8 — Notifications Push (Web Push / VAPID)
-- ════════════════════════════════════════════════════════
-- Un client peut avoir plusieurs abonnements (un par appareil / navigateur).
-- L'endpoint est unique : on remplace l'abonnement si le même navigateur
-- se ré-abonne (upsert on conflict). Le serveur (cron / Edge Function avec
-- service role) lit toutes les lignes pour envoyer ; le RLS ci-dessous ne
-- concerne que les accès depuis le client (chacun ne voit que les siens).
create table if not exists public.push_subscriptions (
  id          bigserial primary key,
  client_id   uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz default now()
);

create index if not exists idx_push_subscriptions_client
  on public.push_subscriptions(client_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subs_select_own" on public.push_subscriptions;
drop policy if exists "push_subs_insert_own" on public.push_subscriptions;
drop policy if exists "push_subs_update_own" on public.push_subscriptions;
drop policy if exists "push_subs_delete_own" on public.push_subscriptions;

create policy "push_subs_select_own" on public.push_subscriptions
  for select using (auth.uid() = client_id);

create policy "push_subs_insert_own" on public.push_subscriptions
  for insert with check (auth.uid() = client_id);

-- Nécessaire pour l'upsert on conflict (endpoint) côté client.
create policy "push_subs_update_own" on public.push_subscriptions
  for update using (auth.uid() = client_id)
  with check (auth.uid() = client_id);

create policy "push_subs_delete_own" on public.push_subscriptions
  for delete using (auth.uid() = client_id);


-- ════════════════════════════════════════════════════════════════
--  PHASE 9 — PARRAINAGE COMMERÇANT (affiliation)
--  Un commerçant parraine un confrère : le filleul a un essai prolongé
--  (30 j au lieu de 14, appliqué au checkout), et le parrain gagne 1 mois
--  gratuit dès que le filleul effectue son 1er vrai paiement (webhook).
-- ════════════════════════════════════════════════════════════════

-- Code de parrainage unique par commerçant (dérivé de l'id → sans collision).
alter table public.profiles add column if not exists referral_code text;
create unique index if not exists idx_profiles_referral_code
  on public.profiles(referral_code) where referral_code is not null;

-- Backfill des commerçants existants.
update public.profiles
   set referral_code = upper(substr(md5(id::text), 1, 8))
 where role = 'commercant' and referral_code is null;

-- Table de suivi des parrainages.
create table if not exists public.merchant_referrals (
  id           bigserial primary key,
  referrer_id  uuid not null references public.profiles(id) on delete cascade,
  referred_id  uuid not null references public.profiles(id) on delete cascade unique,
  status       text not null default 'pending' check (status in ('pending','rewarded','cancelled')),
  created_at   timestamptz default now(),
  rewarded_at  timestamptz
);
create index if not exists idx_merchant_referrals_referrer on public.merchant_referrals(referrer_id);

alter table public.merchant_referrals enable row level security;

-- Le parrain peut lire ses propres parrainages (pour l'encart du dashboard).
-- L'écriture est réservée au serveur (trigger security definer + webhook service role).
drop policy if exists "mref_select_referrer" on public.merchant_referrals;
create policy "mref_select_referrer" on public.merchant_referrals
  for select using (auth.uid() = referrer_id);

-- Le parrain doit voir le NOM de ses filleuls, mais le RLS de profiles interdit
-- de lire le profil d'un autre commerçant. Cette fonction SECURITY DEFINER ne
-- renvoie que les parrainages de l'appelant, avec le nom du filleul joint.
create or replace function public.get_my_referrals()
returns table (referred_name text, status text, created_at timestamptz)
language sql security definer set search_path = public stable as $$
  select coalesce(p.name, 'Commerçant'), r.status, r.created_at
  from public.merchant_referrals r
  left join public.profiles p on p.id = r.referred_id
  where r.referrer_id = auth.uid()
  order by r.created_at desc;
$$;
grant execute on function public.get_my_referrals() to authenticated;
