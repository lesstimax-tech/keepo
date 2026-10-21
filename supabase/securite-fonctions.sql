-- ════════════════════════════════════════════════════════
--  SÉCURITÉ — qui peut appeler quelles fonctions de la base
-- ════════════════════════════════════════════════════════
-- Rejouable sans risque. Suite au contrôle de sécurité de Supabase
-- (octobre 2026) : 25 fonctions « security definer » restaient appelables
-- par n'importe qui, sans compte, via /rest/v1/rpc/…
--
-- Les fonctions qui touchent aux points (crédit, débit, carte cadeau…)
-- vérifient déjà l'identité de l'appelant : aucune n'était exploitable
-- pour s'offrir des points. Deux vrais trous, en revanche :
--   • keepo_discord(charge) : n'importe qui pouvait poster le message de
--     son choix dans le Discord de KEEPO ;
--   • verify_cashier_pin : n'importe qui pouvait essayer des PIN de
--     caissier à volonté, sur les caissiers de tous les commerces.


-- ── 1. Fonctions internes : personne ne les appelle depuis le site ──
-- Les déclencheurs et les tâches planifiées continuent de les exécuter :
-- le droit EXECUTE ne compte que pour un appel direct.
do $internes$
declare f text;
begin
  foreach f in array array[
    'public.keepo_discord(jsonb)',
    'public.keepo_digest_quotidien()',
    'public.keepo_prevenir_inscription()',
    'public.keepo_affiliation_inscription()',
    'public.handle_new_user()',
    'public.bump_lifetime_points()',
    'public.enforce_member_limit()',
    'public.rls_auto_enable()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end
$internes$;


-- ── 2. Fonctions du site : réservées aux personnes connectées ──
-- Toutes sont appelées depuis un tableau de bord ou la caisse, donc avec
-- une session. Seule verifier_code_ambassadeur reste ouverte à tous
-- (accueil et inscription, avant toute connexion).
do $connectes$
declare f text;
begin
  foreach f in array array[
    'public.apply_loyalty_credit(uuid, uuid, numeric, integer, uuid)',
    'public.apply_loyalty_debit(uuid, uuid, integer)',
    'public.apply_reward_claim_by_client(uuid, integer)',
    'public.claim_birthday_bonus(uuid)',
    'public.claim_referral_code(text, uuid)',
    'public.create_gift_card(uuid, integer, text)',
    'public.get_merchant_plans(uuid[])',
    'public.get_my_referrals()',
    'public.hide_loyalty_card(uuid)',
    'public.join_loyalty_card(uuid)',
    'public.my_member_usage()',
    'public.peut_envoyer_campagne(uuid)',
    'public.redeem_gift_card(text)',
    'public.spin_wheel(uuid)',
    'public.validate_claim_code(text)',
    'public.verify_cashier_pin(bigint, text)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon', f);
      execute format('grant execute on function %s to authenticated, service_role', f);
    end if;
  end loop;
end
$connectes$;


-- ── 3. Le PIN d'un caissier ne se vérifie que dans SON commerce ──
-- La caisse tourne avec la session du commerçant : un autre compte ne
-- peut plus tester les PIN de ses caissiers.
create or replace function public.verify_cashier_pin(p_cashier_id bigint, p_pin text)
returns boolean
language sql
security definer
set search_path to 'public', 'extensions'
as $$
  select exists (
    select 1 from public.cashiers
    where id = p_cashier_id
      and merchant_id = auth.uid()
      and active = true
      and pin_hash = encode(extensions.digest(p_pin, 'sha256'), 'hex')
  );
$$;
revoke execute on function public.verify_cashier_pin(bigint, text) from public, anon;
grant execute on function public.verify_cashier_pin(bigint, text) to authenticated, service_role;


-- ── 4. Chemin de recherche figé (avertissement « search_path mutable ») ──
do $chemins$
begin
  if to_regprocedure('public.keepo_code_propre(text)') is not null then
    alter function public.keepo_code_propre(text) set search_path = public;
  end if;
  if to_regprocedure('public.keepo_iban_valide(text)') is not null then
    alter function public.keepo_iban_valide(text) set search_path = public;
  end if;
end
$chemins$;
