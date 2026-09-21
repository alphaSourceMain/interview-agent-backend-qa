-- Stable provider infrastructure for each company-owned sales line. Personnel
-- assignments can change without rotating the Grok tools or rebuilding GHL.

alter table public.sales_phone_numbers
  add column if not exists xai_agent_id text,
  add column if not exists xai_phone_number_e164 text,
  add column if not exists ghl_location_id text,
  add column if not exists ghl_routing_workflow_id text,
  add column if not exists ghl_notification_workflow_id text,
  add column if not exists ghl_mobile_custom_value_id text,
  add column if not exists ghl_mobile_custom_value_name text,
  add column if not exists xai_setup_status text not null default 'pending',
  add column if not exists ghl_setup_status text not null default 'pending',
  add column if not exists xai_verified_at timestamptz,
  add column if not exists xai_verification_reference text,
  add column if not exists handoff_token_sha256 text,
  add column if not exists handoff_token_rotated_at timestamptz;

alter table public.sales_phone_numbers
  drop constraint if exists sales_phone_numbers_xai_agent_length,
  add constraint sales_phone_numbers_xai_agent_length check (
    xai_agent_id is null or char_length(xai_agent_id) between 3 and 160
  ),
  drop constraint if exists sales_phone_numbers_xai_phone_check,
  add constraint sales_phone_numbers_xai_phone_check check (
    xai_phone_number_e164 is null or xai_phone_number_e164 ~ '^\+1[2-9][0-9]{9}$'
  ),
  drop constraint if exists sales_phone_numbers_provider_field_lengths,
  add constraint sales_phone_numbers_provider_field_lengths check (
    (ghl_location_id is null or char_length(ghl_location_id) between 3 and 160)
    and (ghl_routing_workflow_id is null or char_length(ghl_routing_workflow_id) between 3 and 160)
    and (ghl_notification_workflow_id is null or char_length(ghl_notification_workflow_id) between 3 and 160)
    and (ghl_mobile_custom_value_id is null or char_length(ghl_mobile_custom_value_id) between 3 and 160)
    and (ghl_mobile_custom_value_name is null or char_length(ghl_mobile_custom_value_name) between 3 and 120)
  ),
  drop constraint if exists sales_phone_numbers_xai_setup_status_check,
  add constraint sales_phone_numbers_xai_setup_status_check check (xai_setup_status in ('pending', 'verified', 'failed')),
  drop constraint if exists sales_phone_numbers_ghl_setup_status_check,
  add constraint sales_phone_numbers_ghl_setup_status_check check (ghl_setup_status in ('pending', 'verified', 'failed')),
  drop constraint if exists sales_phone_numbers_xai_verification_reference_length,
  add constraint sales_phone_numbers_xai_verification_reference_length check (
    xai_verification_reference is null or char_length(xai_verification_reference) between 3 and 160
  ),
  drop constraint if exists sales_phone_numbers_handoff_token_check,
  add constraint sales_phone_numbers_handoff_token_check check (
    handoff_token_sha256 is null or handoff_token_sha256 ~ '^[a-f0-9]{64}$'
  );

create unique index if not exists sales_phone_numbers_xai_agent_uidx
  on public.sales_phone_numbers (xai_agent_id) where xai_agent_id is not null;
create unique index if not exists sales_phone_numbers_xai_phone_uidx
  on public.sales_phone_numbers (xai_phone_number_e164) where xai_phone_number_e164 is not null;
create unique index if not exists sales_phone_numbers_handoff_token_uidx
  on public.sales_phone_numbers (handoff_token_sha256) where handoff_token_sha256 is not null;
create unique index if not exists sales_phone_numbers_ghl_mobile_value_uidx
  on public.sales_phone_numbers (ghl_mobile_custom_value_id) where ghl_mobile_custom_value_id is not null;

-- The active assignment keeps a compatibility copy of the stable line token.
-- Historical assignments may retain the same hash when a line changes hands,
-- while the runtime lookup always restricts this fallback to status = active.
drop index if exists public.sales_phone_assignments_handoff_token_uidx;
create unique index sales_phone_assignments_handoff_token_uidx
  on public.sales_phone_assignments (handoff_token_sha256)
  where handoff_token_sha256 is not null and status = 'active';

alter table public.sales_integration_sync_jobs
  drop constraint if exists sales_integration_sync_jobs_status_check;
alter table public.sales_integration_sync_jobs
  add constraint sales_integration_sync_jobs_status_check check (
    status in ('queued', 'running', 'synced', 'not_applicable', 'action_required', 'failed')
  );

update public.sales_phone_numbers as phone
set xai_agent_id = seed.xai_agent_id,
    ghl_location_id = '9AlpNONrH1wb0FtPKkbo',
    ghl_mobile_custom_value_name = seed.custom_value_name,
    updated_at = now()
from (values
  ('21000000-0000-4000-8000-000000000001'::uuid, 'agent_1LDTasuwSoOhfbsZ', 'alphaScreen Line 1 Mobile'),
  ('21000000-0000-4000-8000-000000000002'::uuid, 'agent_yWdm5vpifYr2z62K', 'alphaScreen Line 2 Mobile'),
  ('21000000-0000-4000-8000-000000000003'::uuid, 'agent_b32kYrh6mSVlrSK3', 'alphaScreen Line 3 Mobile'),
  ('21000000-0000-4000-8000-000000000004'::uuid, 'agent_QzE6yzA9ZHC6P0wN', 'alphaScreen Line 4 Mobile')
) as seed(id, xai_agent_id, custom_value_name)
where phone.id = seed.id
  and phone.xai_agent_id is null;

create or replace function public.rotate_sales_voice_line_token(
  p_phone_number_id uuid,
  p_actor_user_id uuid,
  p_handoff_token_sha256 text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  if p_handoff_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_line_token_invalid';
  end if;

  update public.sales_phone_numbers
  set handoff_token_sha256 = p_handoff_token_sha256,
      handoff_token_rotated_at = now(),
      updated_at = now()
  where id = p_phone_number_id and active = true;
  if not found then raise exception 'sales_phone_number_not_found'; end if;

  select team_member_id into v_member_id
  from public.sales_phone_assignments
  where phone_number_id = p_phone_number_id
  order by case status when 'active' then 0 when 'draft' then 1 else 2 end, created_at desc
  limit 1;

  insert into public.sales_team_audit_events (team_member_id, actor_user_id, action, safe_metadata)
  values (v_member_id, p_actor_user_id, 'sales_voice_line_token_rotated', jsonb_build_object('phone_number_id', p_phone_number_id));
  return p_phone_number_id;
end;
$$;

create or replace function public.finish_sales_provider_sync(
  p_team_member_id uuid,
  p_provider text,
  p_status text,
  p_provider_reference text,
  p_error_code text,
  p_error_detail text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  if p_provider not in ('ghl', 'xai', 'slack') then raise exception 'sales_provider_invalid'; end if;
  if p_status not in ('synced', 'not_applicable', 'action_required', 'failed') then raise exception 'sales_provider_status_invalid'; end if;

  select id into v_job_id
  from public.sales_integration_sync_jobs
  where team_member_id = p_team_member_id and provider = p_provider
  order by created_at desc
  limit 1
  for update;
  if not found then raise exception 'sales_provider_sync_job_not_found'; end if;

  update public.sales_integration_sync_jobs
  set status = p_status,
      attempt_count = attempt_count + 1,
      provider_reference = left(nullif(p_provider_reference, ''), 240),
      last_error_code = left(nullif(p_error_code, ''), 80),
      last_error_detail = left(nullif(p_error_detail, ''), 500),
      updated_at = now(),
      completed_at = case when p_status = 'synced' then now() else null end
  where id = v_job_id;
  return v_job_id;
end;
$$;

create or replace function public.save_sales_voice_line_setup(
  p_phone_number_id uuid,
  p_actor_user_id uuid,
  p_setup jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_current public.sales_phone_numbers%rowtype;
  v_xai_changed boolean;
  v_ghl_changed boolean;
begin
  select * into v_current from public.sales_phone_numbers where id = p_phone_number_id and active = true for update;
  if not found then raise exception 'sales_phone_number_not_found'; end if;
  v_xai_changed := v_current.xai_agent_id is distinct from nullif(p_setup->>'xai_agent_id', '')
    or v_current.xai_phone_number_e164 is distinct from nullif(p_setup->>'xai_phone_number_e164', '');
  v_ghl_changed := v_current.ghl_location_id is distinct from nullif(p_setup->>'ghl_location_id', '')
    or v_current.ghl_routing_workflow_id is distinct from nullif(p_setup->>'ghl_routing_workflow_id', '')
    or v_current.ghl_notification_workflow_id is distinct from nullif(p_setup->>'ghl_notification_workflow_id', '')
    or v_current.ghl_mobile_custom_value_id is distinct from nullif(p_setup->>'ghl_mobile_custom_value_id', '')
    or v_current.ghl_mobile_custom_value_name is distinct from nullif(p_setup->>'ghl_mobile_custom_value_name', '');

  update public.sales_phone_numbers
  set xai_agent_id = nullif(p_setup->>'xai_agent_id', ''),
      xai_phone_number_e164 = nullif(p_setup->>'xai_phone_number_e164', ''),
      ghl_location_id = nullif(p_setup->>'ghl_location_id', ''),
      ghl_routing_workflow_id = nullif(p_setup->>'ghl_routing_workflow_id', ''),
      ghl_notification_workflow_id = nullif(p_setup->>'ghl_notification_workflow_id', ''),
      ghl_mobile_custom_value_id = nullif(p_setup->>'ghl_mobile_custom_value_id', ''),
      ghl_mobile_custom_value_name = nullif(p_setup->>'ghl_mobile_custom_value_name', ''),
      xai_setup_status = case when v_xai_changed then 'pending' else p_setup->>'xai_setup_status' end,
      ghl_setup_status = case when v_ghl_changed then 'pending' else p_setup->>'ghl_setup_status' end,
      xai_verified_at = case
        when v_xai_changed or p_setup->>'xai_setup_status' <> 'verified' then null
        when p_setup->>'xai_setup_status' = 'verified' then now()
        else xai_verified_at
      end,
      xai_verification_reference = case
        when v_xai_changed or p_setup->>'xai_setup_status' <> 'verified' then null
        else nullif(p_setup->>'xai_verification_reference', '')
      end,
      updated_at = now()
  where id = p_phone_number_id and active = true;

  select team_member_id into v_member_id
  from public.sales_phone_assignments
  where phone_number_id = p_phone_number_id
  order by case status when 'active' then 0 when 'draft' then 1 else 2 end, created_at desc
  limit 1;
  insert into public.sales_team_audit_events (team_member_id, actor_user_id, action, safe_metadata)
  values (v_member_id, p_actor_user_id, 'sales_voice_line_setup_saved', jsonb_build_object(
    'phone_number_id', p_phone_number_id,
    'xai_setup_status', case when v_xai_changed then 'pending' else p_setup->>'xai_setup_status' end,
    'ghl_setup_status', case when v_ghl_changed then 'pending' else p_setup->>'ghl_setup_status' end
  ));
  return p_phone_number_id;
end;
$$;

revoke all on function public.rotate_sales_voice_line_token(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_sales_provider_sync(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.save_sales_voice_line_setup(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rotate_sales_voice_line_token(uuid, uuid, text) to service_role;
grant execute on function public.finish_sales_provider_sync(uuid, text, text, text, text, text) to service_role;
grant execute on function public.save_sales_voice_line_setup(uuid, uuid, jsonb) to service_role;
