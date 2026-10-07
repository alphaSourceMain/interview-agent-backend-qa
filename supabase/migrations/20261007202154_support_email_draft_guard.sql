begin;
create schema if not exists private_support_email;
revoke all on schema private_support_email from public, anon, authenticated;
grant usage on schema private_support_email to service_role;

create table private_support_email.drafts (
  id uuid primary key default gen_random_uuid(),
  thread_key text not null unique check (thread_key ~ '^[a-f0-9]{64}$'),
  message_key text not null unique check (message_key ~ '^[a-f0-9]{64}$'),
  gmail_key text not null unique check (gmail_key ~ '^[a-f0-9]{64}$'),
  status text not null default 'claimed' check (status in ('claimed', 'draft', 'review')),
  body text check (octet_length(body) <= 4500),
  audience text check (audience in ('public', 'client')),
  human_review boolean not null default true,
  reason text,
  knowledge_version text,
  knowledge_hash text,
  created_at timestamptz not null default now(),
  body_expires_at timestamptz not null default now() + interval '7 days'
);
alter table private_support_email.drafts enable row level security;
revoke all on private_support_email.drafts from public, anon, authenticated;
grant select, insert, update on private_support_email.drafts to service_role;

create function public.claim_support_email_draft(p_thread_key text, p_message_key text, p_gmail_key text)
returns uuid language sql security invoker set search_path = '' as $$
  insert into private_support_email.drafts(thread_key, message_key, gmail_key)
  values (p_thread_key, p_message_key, p_gmail_key)
  on conflict do nothing returning id;
$$;

create function public.finish_support_email_draft(p_id uuid, p_draft jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if p_draft->>'status' not in ('draft', 'review') or p_draft->>'status' is null then
    raise exception 'invalid draft status';
  end if;
  update private_support_email.drafts set
    status = p_draft->>'status',
    body = case when p_draft->>'status' = 'draft' then p_draft->>'body' else null end,
    audience = p_draft->>'audience',
    human_review = coalesce((p_draft->>'humanReview')::boolean, true),
    reason = p_draft->>'reason',
    knowledge_version = p_draft->>'knowledgeVersion',
    knowledge_hash = p_draft->>'knowledgeHash'
  where id = p_id and status = 'claimed';
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

-- Narrow privileged lookup kept in an unexposed schema. It reveals only one confirmed UUID
-- to the trusted service role, never an auth row or an email to a browser.
create function private_support_email.confirmed_user(p_email text)
returns uuid language sql security definer set search_path = '' as $$
  select case when count(*) = 1 then (array_agg(id))[1] else null end
  from auth.users where current_setting('role', true) = 'service_role' and auth.uid() is null
    and lower(email) = p_email and email_confirmed_at is not null
    and deleted_at is null and (banned_until is null or banned_until <= now());
$$;
create function public.support_email_confirmed_user(p_email text)
returns uuid language sql security invoker set search_path = '' as $$
  select private_support_email.confirmed_user(p_email);
$$;

create function public.purge_support_email_draft_bodies()
returns integer language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  update private_support_email.drafts set body = null where body is not null and body_expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function private_support_email.confirmed_user(text) from public, anon, authenticated;
grant execute on function private_support_email.confirmed_user(text) to service_role;
revoke all on function public.claim_support_email_draft(text,text,text) from public, anon, authenticated;
revoke all on function public.finish_support_email_draft(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.support_email_confirmed_user(text) from public, anon, authenticated;
revoke all on function public.purge_support_email_draft_bodies() from public, anon, authenticated;
grant execute on function public.claim_support_email_draft(text,text,text) to service_role;
grant execute on function public.finish_support_email_draft(uuid,jsonb) to service_role;
grant execute on function public.support_email_confirmed_user(text) to service_role;
grant execute on function public.purge_support_email_draft_bodies() to service_role;
commit;
