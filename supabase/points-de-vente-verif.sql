-- ════════════════════════════════════════════════════════
--  VÉRIFICATION de points-de-vente.sql — sur la vraie base, sans trace
-- ════════════════════════════════════════════════════════
-- À lancer APRÈS points-de-vente.sql, dans une requête séparée.
--
-- Le bloc se met dans la peau du navigateur du dernier commerçant inscrit,
-- tente de changer sa formule, son option et son nom, puis de créer des
-- points de vente sans limite. Il finit par une erreur volontaire :
-- Postgres annule alors tout ce qui précède. Le message rouge affiché EST
-- le résultat.
--
-- Une modification peut être bloquée de deux façons, toutes deux valables :
-- par les droits de la base (« droits » : le rôle du navigateur n'a pas le
-- droit d'écrire la colonne) ou par le déclencheur (« déclencheur » :
-- l'écriture passe, la valeur est remise).
do $$
declare
  v_id         uuid;
  v_plan       text;
  v_sup        int;
  v_avant      int;
  v_attendu    int;
  v_crees      int := 0;
  v_lignes     int;
  v_colonnes   text;
  v_plan_apres text;
  v_sup_apres  int;
  v_nom_apres  text;
  r_plan       text;
  r_sup        text;
  r_nom        text;
  r_limite     text;
begin
  select id, plan, coalesce(points_de_vente_sup, 0)
    into v_id, v_plan, v_sup
    from public.profiles
   where role = 'commercant'
   order by created_at desc nulls last
   limit 1;
  if v_id is null then
    raise exception 'VÉRIFICATION IMPOSSIBLE : aucun commerçant en base.';
  end if;

  select count(*) into v_avant from public.boutiques where merchant_id = v_id;
  v_attendu := greatest(0, (case when lower(v_plan) in ('pro', 'pro scale') then 3 + v_sup
                                 when lower(v_plan) = 'smart'               then 1
                                 else 2 end) - 1 - v_avant);

  -- Les colonnes de profiles que le navigateur a le droit d'écrire.
  select coalesce(string_agg(column_name::text, ', ' order by column_name::text), 'aucune')
    into v_colonnes
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'profiles'
     and has_column_privilege('authenticated', 'public.profiles', column_name::text, 'UPDATE');

  -- Même rôle et même jeton que PostgREST pour une requête du navigateur.
  perform set_config('request.jwt.claims', json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  if auth.uid() is distinct from v_id then
    raise exception 'VÉRIFICATION IMPOSSIBLE : auth.uid() ne lit pas le jeton simulé.';
  end if;

  -- 1. Changer de formule.
  begin
    update public.profiles
       set plan = case when lower(v_plan) = 'pro scale' then 'smart' else 'pro scale' end
     where id = v_id;
    get diagnostics v_lignes = row_count;
    r_plan := case when v_lignes = 0 then 'NON TESTÉE (aucune ligne touchée)' else 'déclencheur' end;
  exception when insufficient_privilege then
    r_plan := 'OUI (droits)';
  end;

  -- 2. S'offrir des options.
  begin
    update public.profiles set points_de_vente_sup = 7 where id = v_id;
    get diagnostics v_lignes = row_count;
    r_sup := case when v_lignes = 0 then 'NON TESTÉE (aucune ligne touchée)' else 'déclencheur' end;
  exception when insufficient_privilege then
    r_sup := 'OUI (droits)';
  end;

  -- 3. Changer de nom, ce que le tableau de bord doit pouvoir faire.
  begin
    update public.profiles set name = coalesce(name, '') || ' (essai)' where id = v_id;
    get diagnostics v_lignes = row_count;
    r_nom := case when v_lignes = 0 then 'NON (aucune ligne touchée)' else 'écrit' end;
  exception when insufficient_privilege then
    r_nom := 'NON (' || sqlerrm || ')';
  end;

  -- 4. Créer des points de vente jusqu'au refus (60 au plus).
  begin
    for i in 1..60 loop
      insert into public.boutiques (merchant_id, name) values (v_id, 'Essai limite ' || i);
      v_crees := v_crees + 1;
    end loop;
    r_limite := 'NON (60 créations acceptées)';
  exception when others then
    if sqlerrm like 'Tous les points de vente%' then
      r_limite := case when v_crees = v_attendu then 'OUI' else 'NON' end
               || format(' (%s création(s) acceptée(s) sur %s attendue(s), formule %s)', v_crees, v_attendu, v_plan);
    else
      r_limite := 'NON TESTÉE (' || sqlerrm || ')';
    end if;
  end;

  -- Relecture avec les droits de l'éditeur SQL.
  execute 'set local role none';
  select plan, coalesce(points_de_vente_sup, 0), name
    into v_plan_apres, v_sup_apres, v_nom_apres
    from public.profiles
   where id = v_id;

  if r_plan = 'déclencheur' then
    r_plan := case when v_plan_apres = v_plan then 'OUI (déclencheur)' else 'NON' end;
  end if;
  if r_sup = 'déclencheur' then
    r_sup := case when v_sup_apres = v_sup then 'OUI (déclencheur)' else 'NON' end;
  end if;
  if r_nom = 'écrit' then
    r_nom := case when v_nom_apres like '% (essai)' then 'OUI' else 'NON (valeur remise)' end;
  end if;

  raise exception E'RÉSULTAT (rien n''a été modifié)\n· formule protégée : %\n· option protégée : %\n· nom modifiable : %\n· limite de points de vente : %\n· colonnes que le navigateur peut écrire : %',
    r_plan, r_sup, r_nom, r_limite, v_colonnes;
end $$;
