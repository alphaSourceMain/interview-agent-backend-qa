-- Route all four company sales lines through one reusable Grok Voice entrypoint.
-- GHL records the line reached before forwarding the call. The shared agent then
-- exchanges the caller number for a short-lived, single-use routing reference.

alter table public.sales_phone_numbers
  add column if not exists shared_voice_entrypoint boolean not null default false;

create unique index if not exists sales_phone_numbers_single_shared_voice_entrypoint_uidx
  on public.sales_phone_numbers (shared_voice_entrypoint)
  where shared_voice_entrypoint = true;

update public.sales_phone_numbers
set shared_voice_entrypoint = (id = '21000000-0000-4000-8000-000000000004'::uuid),
    updated_at = now()
where id in (
  '21000000-0000-4000-8000-000000000001'::uuid,
  '21000000-0000-4000-8000-000000000002'::uuid,
  '21000000-0000-4000-8000-000000000003'::uuid,
  '21000000-0000-4000-8000-000000000004'::uuid
);

create table if not exists public.sales_voice_route_events (
  id uuid primary key default gen_random_uuid(),
  phone_number_id uuid not null references public.sales_phone_numbers(id) on delete restrict,
  caller_phone_e164 text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  constraint sales_voice_route_events_caller_phone_check check (caller_phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  constraint sales_voice_route_events_expiry_check check (expires_at > created_at)
);

create index if not exists sales_voice_route_events_lookup_idx
  on public.sales_voice_route_events (caller_phone_e164, created_at desc);

create table if not exists public.sales_voice_call_contexts (
  id uuid primary key default gen_random_uuid(),
  route_event_id uuid not null unique references public.sales_voice_route_events(id) on delete cascade,
  assignment_id uuid not null references public.sales_phone_assignments(id) on delete restrict,
  token_sha256 text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  claimed_at timestamptz,
  constraint sales_voice_call_contexts_token_check check (token_sha256 ~ '^[a-f0-9]{64}$'),
  constraint sales_voice_call_contexts_expiry_check check (expires_at > created_at),
  constraint sales_voice_call_contexts_claim_check check (claimed_at is null or claimed_at >= created_at)
);

create index if not exists sales_voice_call_contexts_active_idx
  on public.sales_voice_call_contexts (token_sha256)
  where claimed_at is null;

alter table public.sales_voice_route_events enable row level security;
alter table public.sales_voice_call_contexts enable row level security;
revoke all on table public.sales_voice_route_events from public, anon, authenticated;
revoke all on table public.sales_voice_call_contexts from public, anon, authenticated;
grant select, insert, update, delete on table public.sales_voice_route_events to service_role;
grant select, insert, update, delete on table public.sales_voice_call_contexts to service_role;

create or replace function public.record_sales_voice_route(
  p_phone_number_id uuid,
  p_caller_phone_e164 text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  if p_caller_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'sales_voice_caller_phone_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_caller_phone_e164, 0));
  if not exists (
    select 1
    from public.sales_phone_assignments
    where phone_number_id = p_phone_number_id and status = 'active'
  ) then
    raise exception 'sales_voice_line_unassigned';
  end if;
  delete from public.sales_voice_call_contexts where expires_at <= now();
  delete from public.sales_voice_route_events as route
  where route.expires_at <= now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id and context.expires_at > now()
    );
  select route.id into v_event_id
  from public.sales_voice_route_events as route
  where route.phone_number_id = p_phone_number_id
    and route.caller_phone_e164 = p_caller_phone_e164
    and route.expires_at > now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id
    )
  order by route.created_at desc
  limit 1
  for update;
  if found then return v_event_id; end if;
  insert into public.sales_voice_route_events (phone_number_id, caller_phone_e164)
  values (p_phone_number_id, p_caller_phone_e164)
  returning id into v_event_id;
  return v_event_id;
end;
$$;

create or replace function public.create_sales_voice_call_context(
  p_caller_phone_e164 text,
  p_token_sha256 text
)
returns table (assignment_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.sales_voice_route_events%rowtype;
  v_event_count integer;
  v_assignment_id uuid;
begin
  if p_caller_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'sales_voice_caller_phone_invalid';
  end if;
  if p_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_context_token_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_caller_phone_e164, 0));
  select count(*) into v_event_count
  from public.sales_voice_route_events as route
  where route.caller_phone_e164 = p_caller_phone_e164
    and route.expires_at > now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id
    );
  if v_event_count = 0 then raise exception 'sales_voice_route_not_found'; end if;
  if v_event_count > 1 then raise exception 'sales_voice_route_ambiguous'; end if;
  select route.* into v_event
  from public.sales_voice_route_events as route
  where route.caller_phone_e164 = p_caller_phone_e164
    and route.expires_at > now()
    and not exists (
      select 1 from public.sales_voice_call_contexts as context
      where context.route_event_id = route.id
    )
  for update;
  if not found then raise exception 'sales_voice_route_not_found'; end if;

  select assignment.id into v_assignment_id
  from public.sales_phone_assignments as assignment
  join public.sales_team_members as member on member.id = assignment.team_member_id
  where assignment.phone_number_id = v_event.phone_number_id
    and assignment.status = 'active'
    and member.status = 'active'
  for update of assignment;
  if not found then raise exception 'sales_voice_route_unavailable'; end if;

  insert into public.sales_voice_call_contexts (route_event_id, assignment_id, token_sha256)
  values (v_event.id, v_assignment_id, p_token_sha256);
  return query select v_assignment_id;
end;
$$;

create or replace function public.claim_sales_voice_call_context(
  p_token_sha256 text
)
returns table (assignment_id uuid, caller_phone_e164 text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_context_token_invalid';
  end if;
  return query
  with claimed as (
    update public.sales_voice_call_contexts as context
    set claimed_at = now()
    where context.token_sha256 = p_token_sha256
      and context.claimed_at is null
      and context.expires_at > now()
    returning context.assignment_id, context.route_event_id
  )
  select claimed.assignment_id, route.caller_phone_e164
  from claimed
  join public.sales_voice_route_events as route on route.id = claimed.route_event_id;
end;
$$;

revoke all on function public.record_sales_voice_route(uuid, text) from public, anon, authenticated;
revoke all on function public.create_sales_voice_call_context(text, text) from public, anon, authenticated;
revoke all on function public.claim_sales_voice_call_context(text) from public, anon, authenticated;
grant execute on function public.record_sales_voice_route(uuid, text) to service_role;
grant execute on function public.create_sales_voice_call_context(text, text) to service_role;
grant execute on function public.claim_sales_voice_call_context(text) to service_role;
