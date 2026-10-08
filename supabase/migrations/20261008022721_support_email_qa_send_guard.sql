begin;
-- QA-only one-attended-test latch. Not a reusable production delivery queue.
create table private_support_email.send_intents (
  draft_id uuid primary key references private_support_email.drafts(id)
    check(draft_id='1afe67e6-78e7-4df9-a69a-cbb066351d9d'::uuid),
  nonce uuid not null unique default gen_random_uuid(),
  mailbox text not null default 'alphy@alphasourceai.com' check(mailbox='alphy@alphasourceai.com'),
  recipient text not null default 'jason@gardner.ltd' check(recipient='jason@gardner.ltd'),
  state text not null default 'reserved' check(state in ('reserved','submitting','accepted','unknown','cancelled')),
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  original_thread_id text not null check(original_thread_id ~ '^[a-f0-9]{1,40}$'),
  wire_hash text not null check(wire_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  lease_expires_at timestamptz not null default now()+interval '3 minutes',
  updated_at timestamptz not null default now(),
  gmail_id text check(gmail_id ~ '^[a-f0-9]{1,40}$'),
  returned_thread_id text check(returned_thread_id ~ '^[a-f0-9]{1,40}$'),
  check(state<>'accepted' or (gmail_id is not null and returned_thread_id is not null and returned_thread_id=original_thread_id))
);
alter table private_support_email.send_intents enable row level security;
revoke all on private_support_email.send_intents from public,anon,authenticated,service_role;

-- Every definer stays private and checks the request role, not current_user.
create function private_support_email.read_send_draft(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then raise exception 'denied'; end if;
  if p_id is distinct from '1afe67e6-78e7-4df9-a69a-cbb066351d9d'::uuid then return null; end if;
  return (select jsonb_build_object('id',d.id,'status',d.status,'body',d.body,'audience',d.audience,'human_review',d.human_review,
    'knowledge_version',d.knowledge_version,'knowledge_hash',d.knowledge_hash,'body_expires_at',d.body_expires_at,
    'thread_key',d.thread_key,'message_key',d.message_key,'gmail_key',d.gmail_key,
    'has_intent',exists(select 1 from private_support_email.send_intents s where s.draft_id=d.id))
    from private_support_email.drafts d where d.id=p_id);
end;
$$;

create function private_support_email.reserve_send(p_id uuid,p_fingerprint text,p_thread_id text,p_wire_hash text)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then raise exception 'denied'; end if;
  if p_id is distinct from '1afe67e6-78e7-4df9-a69a-cbb066351d9d'::uuid or
    coalesce(p_fingerprint !~ '^[a-f0-9]{64}$',true) or coalesce(p_wire_hash !~ '^[a-f0-9]{64}$',true) or
    coalesce(p_thread_id !~ '^[a-f0-9]{1,40}$',true) then return null; end if;
  insert into private_support_email.send_intents(draft_id,fingerprint,original_thread_id,wire_hash)
    select d.id,p_fingerprint,p_thread_id,p_wire_hash from private_support_email.drafts d
    where d.id=p_id and d.status='draft' and d.human_review=true and d.body is not null and d.body_expires_at>clock_timestamp()
      and md5(convert_to(d.body,'UTF8'))='3b5b4fcd3e944481c150ba00eb3ff5a2'
      and encode(sha256(convert_to(d.body,'UTF8')),'hex')='25796fcabdd1ea631b88a60e83d9c7bc0351c6b1f08acc6f36e3e2bdbdfb6f38'
      and d.audience='client' and d.knowledge_version='2026-09-11.5'
      and d.knowledge_hash='0239a37514af14d82144450226469790f64e37f5bc5123b4d0edb0bb64332925'
    on conflict do nothing returning nonce into result;
  return result;
end;
$$;

create function private_support_email.start_send(p_id uuid,p_nonce uuid,p_fingerprint text,p_wire_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then raise exception 'denied'; end if;
  update private_support_email.send_intents s set state='submitting',updated_at=clock_timestamp()
    where s.draft_id=p_id and s.nonce=p_nonce and s.state='reserved' and s.lease_expires_at>clock_timestamp()
      and s.fingerprint=p_fingerprint and s.wire_hash=p_wire_hash and exists(select 1 from private_support_email.drafts d
      where d.id=s.draft_id and d.status='draft' and d.human_review=true and d.body is not null and d.body_expires_at>clock_timestamp()
        and md5(convert_to(d.body,'UTF8'))='3b5b4fcd3e944481c150ba00eb3ff5a2'
        and encode(sha256(convert_to(d.body,'UTF8')),'hex')='25796fcabdd1ea631b88a60e83d9c7bc0351c6b1f08acc6f36e3e2bdbdfb6f38'
        and d.audience='client' and d.knowledge_version='2026-09-11.5'
        and d.knowledge_hash='0239a37514af14d82144450226469790f64e37f5bc5123b4d0edb0bb64332925');
  get diagnostics affected=row_count; return affected=1;
end;
$$;

create function private_support_email.cancel_send(p_id uuid,p_nonce uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then raise exception 'denied'; end if;
  update private_support_email.send_intents set state='cancelled',updated_at=clock_timestamp() where draft_id=p_id and nonce=p_nonce and state='reserved';
  get diagnostics affected=row_count;return affected=1;
end;
$$;

create function private_support_email.finish_send(p_id uuid,p_nonce uuid,p_status text,p_gmail_id text,p_thread_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then raise exception 'denied'; end if;
  if p_status is null or p_status not in ('accepted','unknown') then return false; end if;
  if p_status='accepted' and (coalesce(p_gmail_id !~ '^[a-f0-9]{1,40}$',true) or coalesce(p_thread_id !~ '^[a-f0-9]{1,40}$',true)) then return false; end if;
  if p_status='unknown' and (p_gmail_id is not null or p_thread_id is not null) then return false; end if;
  update private_support_email.send_intents set state=p_status,updated_at=clock_timestamp(),gmail_id=p_gmail_id,returned_thread_id=p_thread_id
    where draft_id=p_id and nonce=p_nonce and state='submitting' and (p_status='unknown' or p_thread_id=original_thread_id);
  get diagnostics affected=row_count;return affected=1;
end;
$$;

create function public.read_support_email_send_draft(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private_support_email.read_send_draft(p_id);$$;
create function public.reserve_support_email_send(p_id uuid,p_fingerprint text,p_thread_id text,p_wire_hash text) returns uuid language sql security invoker set search_path='' as $$select private_support_email.reserve_send(p_id,p_fingerprint,p_thread_id,p_wire_hash);$$;
create function public.start_support_email_send(p_id uuid,p_nonce uuid,p_fingerprint text,p_wire_hash text) returns boolean language sql security invoker set search_path='' as $$select private_support_email.start_send(p_id,p_nonce,p_fingerprint,p_wire_hash);$$;
create function public.cancel_support_email_send(p_id uuid,p_nonce uuid) returns boolean language sql security invoker set search_path='' as $$select private_support_email.cancel_send(p_id,p_nonce);$$;
create function public.finish_support_email_send(p_id uuid,p_nonce uuid,p_status text,p_gmail_id text,p_thread_id text) returns boolean language sql security invoker set search_path='' as $$select private_support_email.finish_send(p_id,p_nonce,p_status,p_gmail_id,p_thread_id);$$;

revoke all on function private_support_email.read_send_draft(uuid),private_support_email.reserve_send(uuid,text,text,text),private_support_email.start_send(uuid,uuid,text,text),private_support_email.cancel_send(uuid,uuid),private_support_email.finish_send(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function private_support_email.read_send_draft(uuid),private_support_email.reserve_send(uuid,text,text,text),private_support_email.start_send(uuid,uuid,text,text),private_support_email.cancel_send(uuid,uuid),private_support_email.finish_send(uuid,uuid,text,text,text) to service_role;
revoke all on function public.read_support_email_send_draft(uuid),public.reserve_support_email_send(uuid,text,text,text),public.start_support_email_send(uuid,uuid,text,text),public.cancel_support_email_send(uuid,uuid),public.finish_support_email_send(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.read_support_email_send_draft(uuid),public.reserve_support_email_send(uuid,text,text,text),public.start_support_email_send(uuid,uuid,text,text),public.cancel_support_email_send(uuid,uuid),public.finish_support_email_send(uuid,uuid,text,text,text) to service_role;
commit;
