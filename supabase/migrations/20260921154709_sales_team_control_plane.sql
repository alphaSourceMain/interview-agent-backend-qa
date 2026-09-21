-- Admin-managed sales staffing, phone routing, and voice-agent configuration.
-- These tables are service-role only. Browser callers must use authenticated,
-- global-admin Express routes so provider credentials never reach the client.

create table if not exists public.sales_team_members (
  id uuid primary key default gen_random_uuid(),
  sales_rep_user_id uuid unique references public.sales_reps(user_id) on delete set null,
  display_name text not null,
  workspace_email text,
  mobile_phone_e164 text,
  ghl_user_id text,
  slack_user_id text,
  status text not null default 'draft',
  active_from date,
  inactive_at timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  updated_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_team_members_display_name_length check (char_length(display_name) between 1 and 120),
  constraint sales_team_members_workspace_email_check check (
    workspace_email is null or (
      char_length(workspace_email) between 3 and 254
      and workspace_email = lower(workspace_email)
      and workspace_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    )
  ),
  constraint sales_team_members_mobile_check check (
    mobile_phone_e164 is null or mobile_phone_e164 ~ '^\+1[2-9][0-9]{9}$'
  ),
  constraint sales_team_members_ghl_user_id_length check (
    ghl_user_id is null or char_length(ghl_user_id) between 3 and 120
  ),
  constraint sales_team_members_slack_user_id_check check (
    slack_user_id is null or slack_user_id ~ '^[UW][A-Z0-9]{8,20}$'
  ),
  constraint sales_team_members_status_check check (status in ('draft', 'active', 'inactive')),
  constraint sales_team_members_inactive_state_check check (
    (status = 'inactive' and inactive_at is not null)
    or (status <> 'inactive' and inactive_at is null)
  )
);

create unique index if not exists sales_team_members_workspace_email_uidx
  on public.sales_team_members (lower(workspace_email))
  where workspace_email is not null;

create unique index if not exists sales_team_members_ghl_user_uidx
  on public.sales_team_members (ghl_user_id)
  where ghl_user_id is not null;

create unique index if not exists sales_team_members_slack_user_uidx
  on public.sales_team_members (slack_user_id)
  where slack_user_id is not null;

create table if not exists public.sales_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null unique,
  provider text not null default 'ghl',
  provider_phone_number_id text,
  label text,
  a2p_status text not null default 'unknown',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_phone_numbers_e164_check check (e164 ~ '^\+1[2-9][0-9]{9}$'),
  constraint sales_phone_numbers_provider_check check (provider = 'ghl'),
  constraint sales_phone_numbers_provider_id_length check (
    provider_phone_number_id is null or char_length(provider_phone_number_id) between 3 and 160
  ),
  constraint sales_phone_numbers_label_length check (label is null or char_length(label) <= 120),
  constraint sales_phone_numbers_a2p_status_check check (
    a2p_status in ('unknown', 'pending', 'verified', 'rejected', 'not_required')
  )
);

create unique index if not exists sales_phone_numbers_provider_id_uidx
  on public.sales_phone_numbers (provider_phone_number_id)
  where provider_phone_number_id is not null;

create table if not exists public.sales_phone_assignments (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references public.sales_team_members(id) on delete restrict,
  phone_number_id uuid not null references public.sales_phone_numbers(id) on delete restrict,
  xai_agent_id text,
  xai_phone_number_e164 text,
  handoff_token_sha256 text,
  handoff_token_rotated_at timestamptz,
  ghl_location_id text,
  ghl_notification_workflow_id text,
  ring_seconds integer not null default 20,
  call_connect_required boolean not null default true,
  transfer_enabled boolean not null default false,
  backup_transfer_phone_e164 text,
  status text not null default 'draft',
  effective_from timestamptz,
  effective_to timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  updated_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_phone_assignments_xai_agent_length check (
    xai_agent_id is null or char_length(xai_agent_id) between 3 and 160
  ),
  constraint sales_phone_assignments_xai_phone_check check (
    xai_phone_number_e164 is null or xai_phone_number_e164 ~ '^\+1[2-9][0-9]{9}$'
  ),
  constraint sales_phone_assignments_handoff_token_check check (
    handoff_token_sha256 is null or handoff_token_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint sales_phone_assignments_ghl_location_length check (
    ghl_location_id is null or char_length(ghl_location_id) between 3 and 160
  ),
  constraint sales_phone_assignments_ghl_workflow_length check (
    ghl_notification_workflow_id is null or char_length(ghl_notification_workflow_id) between 3 and 160
  ),
  constraint sales_phone_assignments_ring_seconds_check check (ring_seconds between 10 and 25),
  constraint sales_phone_assignments_call_connect_check check (call_connect_required = true),
  constraint sales_phone_assignments_transfer_target_check check (
    (transfer_enabled = false and backup_transfer_phone_e164 is null)
    or (transfer_enabled = true and backup_transfer_phone_e164 ~ '^\+1[2-9][0-9]{9}$')
  ),
  constraint sales_phone_assignments_status_check check (status in ('draft', 'active', 'inactive')),
  constraint sales_phone_assignments_effective_state_check check (
    (status = 'active' and effective_from is not null and effective_to is null)
    or (status = 'inactive' and effective_to is not null)
    or status = 'draft'
  )
);

create unique index if not exists sales_phone_assignments_active_member_uidx
  on public.sales_phone_assignments (team_member_id)
  where status = 'active';

create unique index if not exists sales_phone_assignments_active_phone_uidx
  on public.sales_phone_assignments (phone_number_id)
  where status = 'active';

create unique index if not exists sales_phone_assignments_active_xai_agent_uidx
  on public.sales_phone_assignments (xai_agent_id)
  where status = 'active' and xai_agent_id is not null;

create unique index if not exists sales_phone_assignments_handoff_token_uidx
  on public.sales_phone_assignments (handoff_token_sha256)
  where handoff_token_sha256 is not null;

create table if not exists public.sales_voice_configs (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.sales_phone_assignments(id) on delete restrict,
  version integer not null,
  is_current boolean not null default false,
  status text not null default 'draft',
  voice_id text not null default 'eve',
  greeting_override text,
  approved_context text not null default '',
  timezone text not null default 'America/Denver',
  business_hours jsonb not null default '{}'::jsonb,
  answer_approved_faqs boolean not null default true,
  schedule_demos boolean not null default true,
  notify_slack boolean not null default true,
  notify_sms boolean not null default true,
  notify_email boolean not null default true,
  generated_prompt text not null,
  prompt_checksum text not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint sales_voice_configs_version_check check (version > 0),
  constraint sales_voice_configs_status_check check (status in ('draft', 'applied', 'superseded')),
  constraint sales_voice_configs_voice_id_length check (char_length(voice_id) between 1 and 80),
  constraint sales_voice_configs_greeting_length check (greeting_override is null or char_length(greeting_override) <= 500),
  constraint sales_voice_configs_context_length check (char_length(approved_context) <= 6000),
  constraint sales_voice_configs_timezone_length check (char_length(timezone) between 1 and 80),
  constraint sales_voice_configs_business_hours_object check (jsonb_typeof(business_hours) = 'object'),
  constraint sales_voice_configs_prompt_length check (char_length(generated_prompt) between 100 and 12000),
  constraint sales_voice_configs_checksum_check check (prompt_checksum ~ '^[a-f0-9]{64}$'),
  unique (assignment_id, version)
);

create unique index if not exists sales_voice_configs_current_assignment_uidx
  on public.sales_voice_configs (assignment_id)
  where is_current;

create table if not exists public.sales_integration_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references public.sales_team_members(id) on delete restrict,
  assignment_id uuid references public.sales_phone_assignments(id) on delete restrict,
  voice_config_id uuid references public.sales_voice_configs(id) on delete restrict,
  provider text not null,
  operation text not null default 'apply',
  status text not null default 'queued',
  attempt_count integer not null default 0,
  provider_reference text,
  last_error_code text,
  last_error_detail text,
  requested_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint sales_integration_sync_jobs_provider_check check (
    provider in ('sales_dashboard', 'ghl', 'xai', 'slack')
  ),
  constraint sales_integration_sync_jobs_operation_check check (
    operation in ('apply', 'verify', 'deactivate', 'test')
  ),
  constraint sales_integration_sync_jobs_status_check check (
    status in ('queued', 'running', 'synced', 'action_required', 'failed')
  ),
  constraint sales_integration_sync_jobs_attempt_check check (attempt_count between 0 and 20),
  constraint sales_integration_sync_jobs_reference_length check (
    provider_reference is null or char_length(provider_reference) <= 240
  ),
  constraint sales_integration_sync_jobs_error_code_length check (
    last_error_code is null or char_length(last_error_code) <= 80
  ),
  constraint sales_integration_sync_jobs_error_detail_length check (
    last_error_detail is null or char_length(last_error_detail) <= 500
  )
);

create index if not exists sales_integration_sync_jobs_member_created_idx
  on public.sales_integration_sync_jobs (team_member_id, created_at desc);

create index if not exists sales_integration_sync_jobs_pending_idx
  on public.sales_integration_sync_jobs (status, created_at)
  where status in ('queued', 'running', 'failed');

create table if not exists public.sales_team_config_drafts (
  team_member_id uuid primary key references public.sales_team_members(id) on delete cascade,
  payload jsonb not null,
  generated_prompt text not null,
  prompt_checksum text not null,
  updated_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_team_config_drafts_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint sales_team_config_drafts_prompt_length check (char_length(generated_prompt) between 100 and 12000),
  constraint sales_team_config_drafts_checksum_check check (prompt_checksum ~ '^[a-f0-9]{64}$')
);

create table if not exists public.sales_team_audit_events (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid references public.sales_team_members(id) on delete restrict,
  assignment_id uuid references public.sales_phone_assignments(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint sales_team_audit_events_action_length check (char_length(action) between 1 and 80),
  constraint sales_team_audit_events_metadata_object check (jsonb_typeof(safe_metadata) = 'object')
);

create index if not exists sales_team_audit_events_member_created_idx
  on public.sales_team_audit_events (team_member_id, created_at desc);

alter table public.sales_team_members enable row level security;
alter table public.sales_phone_numbers enable row level security;
alter table public.sales_phone_assignments enable row level security;
alter table public.sales_voice_configs enable row level security;
alter table public.sales_integration_sync_jobs enable row level security;
alter table public.sales_team_config_drafts enable row level security;
alter table public.sales_team_audit_events enable row level security;

revoke all on table public.sales_team_members from public, anon, authenticated;
revoke all on table public.sales_phone_numbers from public, anon, authenticated;
revoke all on table public.sales_phone_assignments from public, anon, authenticated;
revoke all on table public.sales_voice_configs from public, anon, authenticated;
revoke all on table public.sales_integration_sync_jobs from public, anon, authenticated;
revoke all on table public.sales_team_config_drafts from public, anon, authenticated;
revoke all on table public.sales_team_audit_events from public, anon, authenticated;

grant select, insert, update on table public.sales_team_members to service_role;
grant select, insert, update on table public.sales_phone_numbers to service_role;
grant select, insert, update on table public.sales_phone_assignments to service_role;
grant select, insert, update on table public.sales_voice_configs to service_role;
grant select, insert, update on table public.sales_integration_sync_jobs to service_role;
grant select, insert, update, delete on table public.sales_team_config_drafts to service_role;
grant select, insert on table public.sales_team_audit_events to service_role;

-- Known company-owned Denver-area numbers and initial Grok Voice drafts.
insert into public.sales_phone_numbers (id, e164, label, a2p_status)
values
  ('21000000-0000-4000-8000-000000000001', '+17207904187', 'Michael Afesi sales line', 'verified'),
  ('21000000-0000-4000-8000-000000000002', '+17198818074', 'Christopher Turean sales line', 'verified'),
  ('21000000-0000-4000-8000-000000000003', '+17192592989', 'Epifanio Sierra sales line', 'verified'),
  ('21000000-0000-4000-8000-000000000004', '+17192495855', 'Daniel Broyles sales line', 'verified')
on conflict (e164) do nothing;

insert into public.sales_team_members (id, display_name, status)
values
  ('22000000-0000-4000-8000-000000000001', 'Michael Afesi', 'draft'),
  ('22000000-0000-4000-8000-000000000002', 'Christopher Turean', 'draft'),
  ('22000000-0000-4000-8000-000000000003', 'Epifanio Sierra', 'draft'),
  ('22000000-0000-4000-8000-000000000004', 'Daniel Broyles', 'draft')
on conflict (id) do nothing;

insert into public.sales_phone_assignments (
  id,
  team_member_id,
  phone_number_id,
  xai_agent_id,
  ring_seconds,
  call_connect_required,
  status
)
values
  ('23000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'agent_1LDTasuwSoOhfbsZ', 20, true, 'draft'),
  ('23000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'agent_yWdm5vpifYr2z62K', 20, true, 'draft'),
  ('23000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000003', 'agent_b32kYrh6mSVlrSK3', 20, true, 'draft'),
  ('23000000-0000-4000-8000-000000000004', '22000000-0000-4000-8000-000000000004', '21000000-0000-4000-8000-000000000004', 'agent_QzE6yzA9ZHC6P0wN', 20, true, 'draft')
on conflict (id) do nothing;

create or replace function public.save_sales_team_draft(
  p_member_id uuid,
  p_actor_user_id uuid,
  p_create boolean,
  p_member jsonb,
  p_payload jsonb,
  p_generated_prompt text,
  p_prompt_checksum text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_create then
    insert into public.sales_team_members (
      id, sales_rep_user_id, display_name, workspace_email, mobile_phone_e164,
      ghl_user_id, slack_user_id, status, created_by_user_id, updated_by_user_id
    ) values (
      p_member_id, nullif(p_member->>'sales_rep_user_id', '')::uuid,
      p_member->>'display_name', nullif(p_member->>'workspace_email', ''),
      nullif(p_member->>'mobile_phone_e164', ''), nullif(p_member->>'ghl_user_id', ''),
      nullif(p_member->>'slack_user_id', ''), 'draft', p_actor_user_id, p_actor_user_id
    );
    v_status := 'draft';
  else
    select status into v_status
    from public.sales_team_members where id = p_member_id for update;
    if not found then raise exception 'sales_team_member_not_found'; end if;
    if v_status = 'inactive' then raise exception 'sales_team_member_inactive'; end if;
  end if;

  insert into public.sales_team_config_drafts (
    team_member_id, payload, generated_prompt, prompt_checksum, updated_by_user_id, updated_at
  ) values (
    p_member_id, p_payload, p_generated_prompt, p_prompt_checksum, p_actor_user_id, now()
  )
  on conflict (team_member_id) do update
  set payload = excluded.payload,
      generated_prompt = excluded.generated_prompt,
      prompt_checksum = excluded.prompt_checksum,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at;

  insert into public.sales_team_audit_events (team_member_id, actor_user_id, action, safe_metadata)
  values (
    p_member_id,
    p_actor_user_id,
    case when p_create then 'sales_team_member_created' else 'sales_team_draft_saved' end,
    jsonb_build_object('status', v_status)
  );
  return p_member_id;
end;
$$;

create or replace function public.apply_sales_team_configuration(
  p_member_id uuid,
  p_existing_assignment_id uuid,
  p_actor_user_id uuid,
  p_member jsonb,
  p_assignment jsonb,
  p_config jsonb,
  p_generated_prompt text,
  p_prompt_checksum text,
  p_replace_assignment boolean,
  p_handoff_token_sha256 text default null
)
returns table (assignment_id uuid, voice_config_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_assignment public.sales_phone_assignments%rowtype;
  v_assignment_id uuid;
  v_config_id uuid;
  v_version integer;
  v_token_sha256 text;
begin
  perform 1 from public.sales_team_members where id = p_member_id for update;
  if not found then raise exception 'sales_team_member_not_found'; end if;

  if p_existing_assignment_id is not null then
    select * into v_assignment
    from public.sales_phone_assignments
    where id = p_existing_assignment_id and team_member_id = p_member_id
    for update;
  end if;

  update public.sales_team_members
  set sales_rep_user_id = nullif(p_member->>'sales_rep_user_id', '')::uuid,
      display_name = p_member->>'display_name',
      workspace_email = nullif(p_member->>'workspace_email', ''),
      mobile_phone_e164 = nullif(p_member->>'mobile_phone_e164', ''),
      ghl_user_id = nullif(p_member->>'ghl_user_id', ''),
      slack_user_id = nullif(p_member->>'slack_user_id', ''),
      status = 'active',
      active_from = coalesce(active_from, (v_now at time zone 'America/Denver')::date),
      inactive_at = null,
      updated_by_user_id = p_actor_user_id,
      updated_at = v_now
  where id = p_member_id;

  v_token_sha256 := coalesce(p_handoff_token_sha256, v_assignment.handoff_token_sha256);
  if v_token_sha256 is null then raise exception 'sales_voice_handoff_token_required'; end if;

  if p_replace_assignment and v_assignment.id is not null then
    update public.sales_phone_assignments
    set status = 'inactive', effective_to = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_assignment.id;
    v_assignment.id := null;
  end if;

  if v_assignment.id is null then
    insert into public.sales_phone_assignments (
      team_member_id, phone_number_id, xai_agent_id, xai_phone_number_e164,
      handoff_token_sha256, handoff_token_rotated_at, ghl_location_id,
      ghl_notification_workflow_id, ring_seconds, call_connect_required,
      transfer_enabled, backup_transfer_phone_e164, status, effective_from,
      created_by_user_id, updated_by_user_id
    ) values (
      p_member_id, (p_assignment->>'phone_number_id')::uuid,
      nullif(p_assignment->>'xai_agent_id', ''), nullif(p_assignment->>'xai_phone_number_e164', ''),
      v_token_sha256, case when p_handoff_token_sha256 is not null then v_now else null end,
      nullif(p_assignment->>'ghl_location_id', ''), nullif(p_assignment->>'ghl_notification_workflow_id', ''),
      (p_assignment->>'ring_seconds')::integer, true,
      (p_assignment->>'transfer_enabled')::boolean, nullif(p_assignment->>'backup_transfer_phone_e164', ''),
      'active', v_now, p_actor_user_id, p_actor_user_id
    ) returning id into v_assignment_id;
  else
    update public.sales_phone_assignments
    set phone_number_id = (p_assignment->>'phone_number_id')::uuid,
        xai_agent_id = nullif(p_assignment->>'xai_agent_id', ''),
        xai_phone_number_e164 = nullif(p_assignment->>'xai_phone_number_e164', ''),
        handoff_token_sha256 = v_token_sha256,
        handoff_token_rotated_at = case when p_handoff_token_sha256 is not null then v_now else handoff_token_rotated_at end,
        ghl_location_id = nullif(p_assignment->>'ghl_location_id', ''),
        ghl_notification_workflow_id = nullif(p_assignment->>'ghl_notification_workflow_id', ''),
        ring_seconds = (p_assignment->>'ring_seconds')::integer,
        call_connect_required = true,
        transfer_enabled = (p_assignment->>'transfer_enabled')::boolean,
        backup_transfer_phone_e164 = nullif(p_assignment->>'backup_transfer_phone_e164', ''),
        status = 'active', effective_from = coalesce(effective_from, v_now), effective_to = null,
        updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_assignment.id
    returning id into v_assignment_id;
  end if;

  update public.sales_voice_configs as svc
  set is_current = false,
      status = case when status = 'applied' then 'superseded' else status end
  where svc.assignment_id = v_assignment_id and svc.is_current;

  select coalesce(max(version), 0) + 1 into v_version
  from public.sales_voice_configs as svc where svc.assignment_id = v_assignment_id;

  insert into public.sales_voice_configs (
    assignment_id, version, is_current, status, voice_id, greeting_override,
    approved_context, timezone, business_hours, answer_approved_faqs,
    schedule_demos, notify_slack, notify_sms, notify_email, generated_prompt,
    prompt_checksum, created_by_user_id, applied_at
  ) values (
    v_assignment_id, v_version, true, 'applied', p_config->>'voice_id',
    nullif(p_config->>'greeting_override', ''), coalesce(p_config->>'approved_context', ''),
    p_config->>'timezone', p_config->'business_hours',
    (p_config->>'answer_approved_faqs')::boolean, (p_config->>'schedule_demos')::boolean,
    (p_config->>'notify_slack')::boolean, (p_config->>'notify_sms')::boolean,
    (p_config->>'notify_email')::boolean, p_generated_prompt, p_prompt_checksum,
    p_actor_user_id, v_now
  ) returning id into v_config_id;

  update public.sales_reps
  set email = p_member->>'workspace_email', display_name = p_member->>'display_name',
      slack_user_id = nullif(p_member->>'slack_user_id', ''), active = true, updated_at = v_now
  where user_id = nullif(p_member->>'sales_rep_user_id', '')::uuid;

  insert into public.sales_integration_sync_jobs (
    team_member_id, assignment_id, voice_config_id, provider, operation, status,
    provider_reference, last_error_code, last_error_detail, requested_by_user_id, completed_at
  ) values
    (p_member_id, v_assignment_id, v_config_id, 'sales_dashboard', 'apply', 'synced', p_member->>'sales_rep_user_id', null, null, p_actor_user_id, v_now),
    (p_member_id, v_assignment_id, v_config_id, 'slack', 'apply', 'action_required', null, 'slack_member_verification_required', 'Verify the saved Slack member mapping.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'ghl', 'apply', 'action_required', null, 'ghl_routing_apply_required', 'Apply and verify the saved number routing in GHL.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'xai', 'apply', 'action_required', null, 'xai_agent_publish_required', 'Apply the generated prompt and verify the published Grok Voice agent.', p_actor_user_id, null);

  delete from public.sales_team_config_drafts where team_member_id = p_member_id;
  insert into public.sales_team_audit_events (team_member_id, assignment_id, actor_user_id, action, safe_metadata)
  values (p_member_id, v_assignment_id, p_actor_user_id, 'sales_team_configuration_applied', jsonb_build_object('providers', jsonb_build_array('sales_dashboard', 'ghl', 'xai', 'slack')));

  return query select v_assignment_id, v_config_id;
end;
$$;

create or replace function public.deactivate_sales_team_member(
  p_member_id uuid,
  p_actor_user_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_sales_rep_user_id uuid;
  v_assignment_id uuid;
  v_config_id uuid;
begin
  select sales_rep_user_id into v_sales_rep_user_id
  from public.sales_team_members where id = p_member_id for update;
  if not found then raise exception 'sales_team_member_not_found'; end if;

  select id into v_assignment_id from public.sales_phone_assignments
  where team_member_id = p_member_id and status = 'active' for update;
  if v_assignment_id is not null then
    select id into v_config_id from public.sales_voice_configs
    where assignment_id = v_assignment_id and is_current limit 1;
  end if;

  update public.sales_phone_assignments
  set status = 'inactive', effective_to = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
  where team_member_id = p_member_id and status = 'active';
  update public.sales_team_members
  set status = 'inactive', inactive_at = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
  where id = p_member_id;
  update public.sales_reps set active = false, updated_at = v_now where user_id = v_sales_rep_user_id;
  delete from public.sales_team_config_drafts where team_member_id = p_member_id;

  insert into public.sales_integration_sync_jobs (
    team_member_id, assignment_id, voice_config_id, provider, operation, status,
    last_error_code, last_error_detail, requested_by_user_id, completed_at
  ) values
    (p_member_id, v_assignment_id, v_config_id, 'sales_dashboard', 'deactivate', 'synced', null, null, p_actor_user_id, v_now),
    (p_member_id, v_assignment_id, v_config_id, 'slack', 'deactivate', 'action_required', 'slack_deactivation_required', 'Disable or reassign this salesperson in Slack.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'ghl', 'deactivate', 'action_required', 'ghl_deactivation_required', 'Disable or reassign this salesperson in GHL.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'xai', 'deactivate', 'action_required', 'xai_deactivation_required', 'Disable or reassign this salesperson in Grok Voice.', p_actor_user_id, null);
  insert into public.sales_team_audit_events (team_member_id, assignment_id, actor_user_id, action)
  values (p_member_id, v_assignment_id, p_actor_user_id, 'sales_team_member_deactivated');
end;
$$;

create or replace function public.reactivate_sales_team_member(
  p_member_id uuid,
  p_actor_user_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.sales_team_members
  set status = 'draft', inactive_at = null, updated_by_user_id = p_actor_user_id, updated_at = now()
  where id = p_member_id and status = 'inactive';
  if not found then raise exception 'sales_team_member_not_inactive'; end if;
  insert into public.sales_team_audit_events (team_member_id, actor_user_id, action)
  values (p_member_id, p_actor_user_id, 'sales_team_member_reactivated');
end;
$$;

revoke all on function public.save_sales_team_draft(uuid, uuid, boolean, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.apply_sales_team_configuration(uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.deactivate_sales_team_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reactivate_sales_team_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_sales_team_draft(uuid, uuid, boolean, jsonb, jsonb, text, text) to service_role;
grant execute on function public.apply_sales_team_configuration(uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, boolean, text) to service_role;
grant execute on function public.deactivate_sales_team_member(uuid, uuid) to service_role;
grant execute on function public.reactivate_sales_team_member(uuid, uuid) to service_role;
