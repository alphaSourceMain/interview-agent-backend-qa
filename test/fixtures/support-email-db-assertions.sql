\set ON_ERROR_STOP on
set role service_role;
select public.claim_support_email_draft(repeat('a',64),repeat('b',64),repeat('c',64)) as claim_id \gset
do $$ begin
  if public.claim_support_email_draft(repeat('a',64),repeat('d',64),repeat('e',64)) is not null then raise exception 'thread duplicate'; end if;
  if public.claim_support_email_draft(repeat('f',64),repeat('b',64),repeat('e',64)) is not null then raise exception 'RFC duplicate'; end if;
  if public.claim_support_email_draft(repeat('f',64),repeat('d',64),repeat('c',64)) is not null then raise exception 'Gmail duplicate'; end if;
  if public.support_email_confirmed_user('client@example.invalid') is null then raise exception 'confirmed lookup'; end if;
  if public.support_email_confirmed_user('unknown@example.invalid') is not null then raise exception 'unknown lookup'; end if;
end $$;
select public.finish_support_email_draft(:'claim_id', '{"status":"draft","body":"synthetic answer","audience":"client","humanReview":false}') as finished \gset
\if :finished
\else
  \quit 1
\endif
update private_support_email.drafts set body_expires_at = now() - interval '1 second';
select public.purge_support_email_draft_bodies();
do $$ begin
  if exists(select 1 from private_support_email.drafts where body is not null) then raise exception 'body purge'; end if;
  if (select count(*) from private_support_email.drafts) <> 1 then raise exception 'purge lost tombstone'; end if;
  if public.claim_support_email_draft(repeat('a',64),repeat('b',64),repeat('c',64)) is not null then raise exception 'purge permits retry'; end if;
end $$;
reset role;
insert into auth.users values ('00000000-0000-4000-8000-000000000002','client@example.invalid',now(),null,null);
insert into auth.users values ('00000000-0000-4000-8000-000000000003','banned@example.invalid',now(),null,now() + interval '1 day');
insert into auth.users values ('00000000-0000-4000-8000-000000000004','unconfirmed@example.invalid',null,null,null);
set role service_role;
do $$ begin
  if public.support_email_confirmed_user('client@example.invalid') is not null then raise exception 'multiple canonical matches'; end if;
  if public.support_email_confirmed_user('banned@example.invalid') is not null then raise exception 'banned user'; end if;
  if public.support_email_confirmed_user('unconfirmed@example.invalid') is not null then raise exception 'unconfirmed user'; end if;
end $$;
reset role;
do $$ begin
  if has_schema_privilege('anon','private_support_email','usage') or has_table_privilege('authenticated','private_support_email.drafts','select') or has_function_privilege('anon','public.support_email_confirmed_user(text)','execute') or has_function_privilege('authenticated','public.claim_support_email_draft(text,text,text)','execute') then raise exception 'public exposure'; end if;
  if not (select relrowsecurity from pg_class where oid = 'private_support_email.drafts'::regclass) then raise exception 'RLS missing'; end if;
end $$;
