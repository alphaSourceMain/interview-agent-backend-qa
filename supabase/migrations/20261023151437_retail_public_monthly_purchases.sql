-- Prospective retail v3 monthly purchases through the existing intent writer.
-- No rows, prices, accepted contracts, payment proofs, roles or ACLs are changed.
begin;
set local lock_timeout='10s';
do $baseline$
declare spec text[]; p record;
begin
 foreach spec slice 1 in array array[
  array['retail_existing_terms_months(jsonb,jsonb)','d0f294c81224f4ddd5cd13594363ba6f','i','search_path=pg_catalog, public'],
  array['read_retail_existing_recurring_source(uuid,uuid)','f98097a6281ee14e132bd037f61ea04e','v','search_path=pg_catalog'],
  array['retail_linked_existing_member_schema_guard()','132a803f4c401d13d731d7f1b05e1601','s','search_path=pg_catalog']
 ] loop
  select * into p from pg_proc where oid=to_regprocedure('public.'||spec[1]);
  if not found or md5(p.prosrc) is distinct from spec[2] or p.prosecdef or p.proisstrict
   or p.provolatile::text is distinct from spec[3]
   or p.proowner is distinct from(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from(case when spec[1]='read_retail_existing_recurring_source(uuid,uuid)'
    then array[spec[4],'lock_timeout=10s'] else array[spec[4]] end)
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or not has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))
    where grantee not in(p.proowner,(select oid from pg_roles where rolname='service_role')))
   or (select count(*) from pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)<>1
   then raise exception 'retail_public_monthly_prerequisite_drift: %',spec[1];end if;
 end loop;
end $baseline$;
do $patch$
declare d text; old text:=$old$or (source='public_purchase_intent' and o->>'payment_option'<>'prepaid')$old$;
 replacement text:=$new$or (source='public_purchase_intent' and o->>'payment_option'<>'prepaid'
      and (o->>'offer_version' is distinct from 'retail-stripe-terms-2026-10-15-v3'
        or o->>'payment_option' is distinct from 'monthly_installments'))
    or (source='public_purchase_intent' and coalesce(length(btrim(i->>'promotion_code_id')),0)>0)$new$;
 new_hash text; sig text; self_marker text; self_hash text;
begin
 select pg_get_functiondef('public.retail_existing_terms_months(jsonb,jsonb)'::regprocedure) into d;
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'retail_public_monthly_predicate_drift';end if;
 execute replace(d,old,replacement);
 select md5(prosrc) into new_hash from pg_proc where oid='public.retail_existing_terms_months(jsonb,jsonb)'::regprocedure;
 foreach sig in array array['read_retail_existing_recurring_source(uuid,uuid)','retail_linked_existing_member_schema_guard()'] loop
  select pg_get_functiondef(to_regprocedure('public.'||sig)) into d;
  old:=quote_literal('d0f294c81224f4ddd5cd13594363ba6f');
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then raise exception 'retail_public_monthly_pin_drift: %',sig;end if;
  d:=replace(d,old,quote_literal(new_hash));
  execute d;
  if sig='retail_linked_existing_member_schema_guard()' then
   select substring(prosrc from 'SELF_MD5:[a-f0-9]{32}'),
    md5(regexp_replace(prosrc,'SELF_MD5:[a-f0-9]{32}','SELF_MD5:00000000000000000000000000000000','g'))
    into self_marker,self_hash from pg_proc where oid=to_regprocedure('public.'||sig);
   if self_marker is null or (length(d)-length(replace(d,self_marker,'')))/length(self_marker)<>1
    then raise exception 'retail_public_monthly_self_pin_drift';end if;
   execute replace(d,self_marker,'SELF_MD5:'||self_hash);
  end if;
 end loop;
end $patch$;
-- Exercise the existing transitive checks before this transaction can commit.
select public.retail_existing_funding_schema_guard();
select public.retail_admin_existing_billing_schema_guard();
select public.retail_admin_existing_member_schema_guard();
select public.retail_linked_existing_member_schema_guard();
commit;
