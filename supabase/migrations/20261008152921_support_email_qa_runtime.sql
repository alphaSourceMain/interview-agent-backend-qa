begin;
-- Separate QA cursor and kill switch. No credentials or mail bodies stored here.
create table private_support_email.qa_runtime (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  mode text not null default 'qa-draft' check(mode in ('qa-draft','qa-owner-auto')),
  original_baseline text check(original_baseline ~ '^[0-9]{1,30}$'),
  history_id text check(history_id ~ '^[0-9]{1,30}$'),
  cutover_at timestamptz,
  nonce uuid,
  lease_until timestamptz,
  last_completed_at timestamptz,
  last_counts jsonb,
  check ((history_id is null and original_baseline is null and cutover_at is null)
    or (history_id is not null and original_baseline is not null and cutover_at is not null))
);
insert into private_support_email.qa_runtime(singleton) values(true);
create table private_support_email.qa_runtime_items (
  draft_id uuid primary key references private_support_email.drafts(id),
  creator_nonce uuid not null,
  model_review boolean not null default true,
  body_hash text check(body_hash ~ '^[a-f0-9]{64}$'),
  knowledge_hash text check(knowledge_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'claimed' check(state in ('claimed','draft','cancelled')),
  updated_at timestamptz not null default clock_timestamp()
);
create table private_support_email.qa_runtime_processed (
  gmail_key text primary key check(gmail_key ~ '^[a-f0-9]{64}$'),
  reason text not null check(reason in ('excluded','not_owner','policy','duplicate','accepted_copy')),
  created_at timestamptz not null default clock_timestamp()
);
create table private_support_email.qa_runtime_deliveries (
  draft_id uuid primary key references private_support_email.qa_runtime_items(draft_id),
  state text not null default 'reserved' check(state in ('reserved','submitting','accepted','unknown','cancelled')),
  nonce uuid not null,
  fingerprint text check(fingerprint ~ '^[a-f0-9]{64}$'),
  wire_hash text check(wire_hash ~ '^[a-f0-9]{64}$'),
  original_thread_id text not null unique check(original_thread_id ~ '^[a-f0-9]{1,40}$'),
  gmail_id text check(gmail_id ~ '^[a-f0-9]{1,40}$'),
  updated_at timestamptz not null default clock_timestamp(),
  check(state <> 'accepted' or gmail_id is not null)
);
alter table private_support_email.qa_runtime enable row level security;
alter table private_support_email.qa_runtime_items enable row level security;
alter table private_support_email.qa_runtime_processed enable row level security;
alter table private_support_email.qa_runtime_deliveries enable row level security;
revoke all on private_support_email.qa_runtime,private_support_email.qa_runtime_items,private_support_email.qa_runtime_processed,private_support_email.qa_runtime_deliveries from public,anon,authenticated,service_role;

create function private_support_email.qa_worker(p_op text,p_nonce uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private_support_email.qa_runtime%rowtype; result_id uuid; changed integer; d private_support_email.drafts%rowtype;
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then raise exception 'denied'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text)>10000 then raise exception 'invalid'; end if;
  select * into r from private_support_email.qa_runtime where singleton for update;
  if p_op='health' then return jsonb_build_object('enabled',r.enabled,'mode',r.mode,'initialized',r.history_id is not null,'last_completed_at',r.last_completed_at,'counts',r.last_counts); end if;
  -- Operator-only control uses the same service-role boundary; worker never calls it.
  if p_op='control' then
    if jsonb_typeof(p_data->'enabled') is distinct from 'boolean' or coalesce(p_data->>'mode' not in ('qa-draft','qa-owner-auto'),true) then raise exception 'invalid'; end if;
    update private_support_email.qa_runtime set enabled=(p_data->>'enabled')::boolean,mode=p_data->>'mode',nonce=null,lease_until=null where singleton;
    return 'true'::jsonb;
  end if;
  if not r.enabled or p_data->>'mode' is distinct from r.mode then return null; end if;
  if p_op='acquire' then
    if coalesce(p_data->>'baseline' !~ '^[0-9]{1,30}$',true) then raise exception 'invalid'; end if;
    if r.original_baseline is not null and r.original_baseline is distinct from p_data->>'baseline' then raise exception 'baseline changed'; end if;
    if r.lease_until>clock_timestamp() then return null; end if;
    update private_support_email.qa_runtime set nonce=gen_random_uuid(),lease_until=clock_timestamp()+interval '180 seconds' where singleton returning * into r;
    return jsonb_build_object('nonce',r.nonce,'cursor',r.history_id,'cutover_ms',floor(extract(epoch from r.cutover_at)*1000),
      'now_ms',floor(extract(epoch from clock_timestamp())*1000),'lease_ms',floor(extract(epoch from r.lease_until)*1000));
  end if;
  if p_nonce is null or r.nonce is distinct from p_nonce or r.lease_until <= clock_timestamp() then return null; end if;
  if p_op='check' then return 'true'::jsonb; end if;
  if p_op='seed' then
    if r.history_id is not null or coalesce(p_data->>'baseline' !~ '^[0-9]{1,30}$',true) or coalesce(p_data->>'current' !~ '^[0-9]{1,30}$',true)
      or (p_data->>'current')::numeric < (p_data->>'baseline')::numeric then raise exception 'invalid'; end if;
    update private_support_email.qa_runtime set original_baseline=p_data->>'baseline',history_id=p_data->>'current',cutover_at=clock_timestamp(),nonce=null,lease_until=null,last_completed_at=clock_timestamp(),last_counts='{}'::jsonb where singleton;
    return 'true'::jsonb;
  end if;
  if p_op='seen' then
    if exists(select 1 from private_support_email.qa_runtime_processed where gmail_key=p_data->>'gmail') then return '"processed"'::jsonb; end if;
    if exists(select 1 from private_support_email.qa_runtime_deliveries where state='accepted' and gmail_id=p_data->>'gmail_id')
      or exists(select 1 from private_support_email.send_intents where state='accepted' and gmail_id=p_data->>'gmail_id') then return '"accepted_copy"'::jsonb; end if;
    return null;
  end if;
  if p_op='processed' then
    if coalesce(p_data->>'gmail' !~ '^[a-f0-9]{64}$',true) or coalesce(p_data->>'reason' not in ('excluded','not_owner','policy','duplicate','accepted_copy'),true) then raise exception 'invalid'; end if;
    insert into private_support_email.qa_runtime_processed(gmail_key,reason) values(p_data->>'gmail',p_data->>'reason') on conflict do nothing;
    return 'true'::jsonb;
  end if;
  if p_op='complete' then
    if coalesce(p_data->>'next' !~ '^[0-9]{1,30}$',true) or (p_data->>'next')::numeric < r.history_id::numeric
      or jsonb_typeof(p_data->'counts') is distinct from 'object' or octet_length((p_data->'counts')::text)>1000 then raise exception 'invalid'; end if;
    update private_support_email.qa_runtime set history_id=p_data->>'next',last_counts=p_data->'counts',last_completed_at=clock_timestamp(),nonce=null,lease_until=null where singleton;
    return 'true'::jsonb;
  end if;
  if p_op='claim' then
    if coalesce(p_data->>'thread' !~ '^[a-f0-9]{64}$',true) or coalesce(p_data->>'message' !~ '^[a-f0-9]{64}$',true) or coalesce(p_data->>'gmail' !~ '^[a-f0-9]{64}$',true) then raise exception 'invalid'; end if;
    insert into private_support_email.drafts(thread_key,message_key,gmail_key) values(p_data->>'thread',p_data->>'message',p_data->>'gmail')
      on conflict do nothing returning id into result_id;
    if result_id is null then return null; end if;
    insert into private_support_email.qa_runtime_items(draft_id,creator_nonce) values(result_id,p_nonce);
    return to_jsonb(result_id);
  end if;
  result_id=(p_data->>'id')::uuid;
  select * into d from private_support_email.drafts where id=result_id for update;
  if not found then return null; end if;
  if p_op='draft' then
    if jsonb_typeof(p_data->'model_review') is distinct from 'boolean' or coalesce(p_data->>'audience' not in ('public','client'),true)
      or coalesce(p_data->>'knowledge_hash' !~ '^[a-f0-9]{64}$',true) or coalesce(p_data->>'knowledge_version' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$',true)
      or p_data->>'body' is null or octet_length(p_data->>'body') not between 1 and 4500 then raise exception 'invalid'; end if;
    update private_support_email.qa_runtime_items set state='draft',model_review=(p_data->>'model_review')::boolean,
      body_hash=encode(sha256(convert_to(p_data->>'body','UTF8')),'hex'),knowledge_hash=p_data->>'knowledge_hash',updated_at=clock_timestamp()
      where draft_id=result_id and state='claimed' and creator_nonce=p_nonce;
    get diagnostics changed=row_count; if changed <> 1 or d.status <> 'claimed' then raise exception 'invalid state'; end if;
    update private_support_email.drafts set status='draft',body=p_data->>'body',audience=p_data->>'audience',human_review=true,
      knowledge_version=p_data->>'knowledge_version',knowledge_hash=p_data->>'knowledge_hash' where id=result_id;
    return 'true'::jsonb;
  end if;
  if p_op='review' then
    update private_support_email.qa_runtime_items set state='cancelled',updated_at=clock_timestamp() where draft_id=result_id and state='claimed' and creator_nonce=p_nonce;
    get diagnostics changed=row_count; if changed <> 1 or d.status <> 'claimed' then return null; end if;
    update private_support_email.drafts set status='review',reason='runtime_recheck_or_generation_failed' where id=result_id;
    return 'true'::jsonb;
  end if;
  if p_op='reserve' then
    if r.mode<>'qa-owner-auto' or coalesce(p_data->>'fingerprint' !~ '^[a-f0-9]{64}$',true) or coalesce(p_data->>'wire' !~ '^[a-f0-9]{64}$',true)
      or coalesce(p_data->>'thread_id' !~ '^[a-f0-9]{1,40}$',true) then return null; end if;
    insert into private_support_email.qa_runtime_deliveries(draft_id,nonce,fingerprint,wire_hash,original_thread_id)
      select i.draft_id,p_nonce,p_data->>'fingerprint',p_data->>'wire',p_data->>'thread_id' from private_support_email.qa_runtime_items i
      where i.draft_id=result_id and i.state='draft' and not i.model_review and i.creator_nonce=p_nonce and d.status='draft' and d.human_review and d.body_expires_at>clock_timestamp()
        and encode(sha256(convert_to(d.body,'UTF8')),'hex')=i.body_hash and i.body_hash=p_data->>'body_hash' and i.knowledge_hash=d.knowledge_hash
        and i.knowledge_hash=p_data->>'knowledge_hash' and not exists(select 1 from private_support_email.send_intents where draft_id=result_id)
      on conflict do nothing;
    get diagnostics changed=row_count; return to_jsonb(changed=1);
  end if;
  if p_op='start' then
    if r.mode<>'qa-owner-auto' or r.lease_until<clock_timestamp()+interval '20 seconds' then return null; end if;
    update private_support_email.qa_runtime_deliveries s set state='submitting',updated_at=clock_timestamp()
      from private_support_email.qa_runtime_items i
      where s.draft_id=result_id and i.draft_id=s.draft_id and s.state='reserved' and s.nonce=p_nonce and not i.model_review and i.creator_nonce=p_nonce
        and s.fingerprint=p_data->>'fingerprint' and s.wire_hash=p_data->>'wire' and d.status='draft' and d.human_review and d.body_expires_at>clock_timestamp()
        and encode(sha256(convert_to(d.body,'UTF8')),'hex')=i.body_hash and i.body_hash=p_data->>'body_hash'
        and i.knowledge_hash=p_data->>'knowledge_hash' and d.knowledge_hash=i.knowledge_hash
        and not exists(select 1 from private_support_email.send_intents where draft_id=result_id);
    get diagnostics changed=row_count; return to_jsonb(changed=1);
  end if;
  if p_op='cancel' then
    update private_support_email.qa_runtime_deliveries set state='cancelled',updated_at=clock_timestamp() where draft_id=result_id and state='reserved' and nonce=p_nonce;
    get diagnostics changed=row_count; return to_jsonb(changed=1);
  end if;
  if p_op='finish' then
    if coalesce(p_data->>'state' not in ('accepted','unknown'),true) then return null; end if;
    if p_data->>'state'='accepted' and (coalesce(p_data->>'gmail_id' !~ '^[a-f0-9]{1,40}$',true) or coalesce(p_data->>'thread_id' !~ '^[a-f0-9]{1,40}$',true)) then return null; end if;
    if p_data->>'state'='unknown' and (p_data->>'gmail_id' is not null or p_data->>'thread_id' is not null) then return null; end if;
    update private_support_email.qa_runtime_deliveries set state=p_data->>'state',gmail_id=p_data->>'gmail_id',updated_at=clock_timestamp()
      where draft_id=result_id and state='submitting' and nonce=p_nonce and (p_data->>'state'='unknown' or original_thread_id=p_data->>'thread_id');
    get diagnostics changed=row_count; return to_jsonb(changed=1);
  end if;
  raise exception 'invalid operation';
end;
$$;
create function public.support_email_qa_worker(p_op text,p_nonce uuid,p_data jsonb)
returns jsonb language sql security invoker set search_path='' as $$select private_support_email.qa_worker(p_op,p_nonce,p_data);$$;
revoke all on function private_support_email.qa_worker(text,uuid,jsonb),public.support_email_qa_worker(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private_support_email.qa_worker(text,uuid,jsonb),public.support_email_qa_worker(text,uuid,jsonb) to service_role;
commit;
