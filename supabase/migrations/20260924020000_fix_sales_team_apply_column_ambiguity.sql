-- QA-only correction: the function's RETURNS TABLE output `assignment_id` conflicts
-- with unqualified sales_voice_configs.assignment_id references in PL/pgSQL.
-- Preserve the existing invoker security, search_path, parameters and behavior.
create or replace function public.apply_sales_team_configuration_v2(
  p_member_id uuid,
  p_existing_assignment_id uuid,
  p_replace_team_member_id uuid,
  p_actor_user_id uuid,
  p_member jsonb,
  p_assignment jsonb,
  p_config jsonb,
  p_generated_prompt text,
  p_prompt_checksum text,
  p_replace_assignment boolean,
  p_expected_draft_updated_at timestamptz,
  p_handoff_token_sha256 text
)
returns table (assignment_id uuid, voice_config_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_assignment public.sales_phone_assignments%rowtype;
  v_occupied_assignment public.sales_phone_assignments%rowtype;
  v_assignment_id uuid;
  v_config_id uuid;
  v_version integer;
  v_member_status text;
  v_draft_updated_at timestamptz;
  v_replaced_sales_rep_user_id uuid;
begin
  if coalesce((p_config->>'notify_slack')::boolean, false) is not true
    or coalesce((p_config->>'notify_sms')::boolean, false) is not true
    or coalesce((p_config->>'notify_email')::boolean, false) is not true then
    raise exception 'sales_notification_channels_required';
  end if;
  if p_handoff_token_sha256 is null or p_handoff_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'sales_voice_handoff_token_required';
  end if;

  select status into v_member_status
  from public.sales_team_members where id = p_member_id for update;
  if not found then raise exception 'sales_team_member_not_found'; end if;
  if v_member_status = 'inactive' then raise exception 'sales_team_member_inactive'; end if;

  select updated_at into v_draft_updated_at
  from public.sales_team_config_drafts where team_member_id = p_member_id for update;
  if not found or v_draft_updated_at is distinct from p_expected_draft_updated_at then
    raise exception 'sales_team_draft_stale';
  end if;

  select * into v_occupied_assignment
  from public.sales_phone_assignments
  where phone_number_id = (p_assignment->>'phone_number_id')::uuid
    and status = 'active'
  for update;

  if v_occupied_assignment.id is not null and v_occupied_assignment.team_member_id is distinct from p_member_id then
    if p_replace_team_member_id is null or p_replace_team_member_id is distinct from v_occupied_assignment.team_member_id then
      raise exception 'sales_phone_replacement_stale';
    end if;
    select sales_rep_user_id into v_replaced_sales_rep_user_id
    from public.sales_team_members
    where id = v_occupied_assignment.team_member_id
    for update;
    update public.sales_voice_configs
    set is_current = false,
        status = case when status = 'applied' then 'superseded' else status end
    where public.sales_voice_configs.assignment_id = v_occupied_assignment.id and is_current;
    update public.sales_phone_assignments
    set status = 'inactive', effective_to = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_occupied_assignment.id;
    update public.sales_team_members
    set status = 'inactive', inactive_at = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_occupied_assignment.team_member_id;
    update public.sales_reps set active = false, updated_at = v_now where user_id = v_replaced_sales_rep_user_id;
    delete from public.sales_team_config_drafts where team_member_id = v_occupied_assignment.team_member_id;
    insert into public.sales_integration_sync_jobs (
      team_member_id, assignment_id, provider, operation, status,
      provider_reference, requested_by_user_id, completed_at
    ) values
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'sales_dashboard', 'deactivate', 'synced', p_member_id::text, p_actor_user_id, v_now),
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'slack', 'deactivate', 'not_applicable', 'routing-replaced', p_actor_user_id, v_now),
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'ghl', 'deactivate', 'synced', 'routing-replaced', p_actor_user_id, v_now),
      (v_occupied_assignment.team_member_id, v_occupied_assignment.id, 'xai', 'deactivate', 'not_applicable', 'line-retained', p_actor_user_id, v_now);
    insert into public.sales_team_audit_events (team_member_id, assignment_id, actor_user_id, action, safe_metadata)
    values (v_occupied_assignment.team_member_id, v_occupied_assignment.id, p_actor_user_id, 'sales_team_member_replaced', jsonb_build_object('replacement_team_member_id', p_member_id));
  elsif p_replace_team_member_id is not null then
    raise exception 'sales_phone_replacement_stale';
  end if;

  if p_existing_assignment_id is not null then
    select * into v_assignment
    from public.sales_phone_assignments
    where id = p_existing_assignment_id and team_member_id = p_member_id
    for update;
  end if;

  if p_replace_assignment and v_assignment.id is not null then
    update public.sales_voice_configs
    set is_current = false,
        status = case when status = 'applied' then 'superseded' else status end
    where public.sales_voice_configs.assignment_id = v_assignment.id and is_current;
    update public.sales_phone_assignments
    set status = 'inactive', effective_to = v_now, updated_by_user_id = p_actor_user_id, updated_at = v_now
    where id = v_assignment.id;
    v_assignment.id := null;
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
      p_handoff_token_sha256, v_now,
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
        handoff_token_sha256 = p_handoff_token_sha256,
        handoff_token_rotated_at = case
          when handoff_token_sha256 is distinct from p_handoff_token_sha256 then v_now
          else handoff_token_rotated_at
        end,
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

  update public.sales_voice_configs
  set is_current = false,
      status = case when status = 'applied' then 'superseded' else status end
  where public.sales_voice_configs.assignment_id = v_assignment_id and is_current;
  select coalesce(max(version), 0) + 1 into v_version
  from public.sales_voice_configs where public.sales_voice_configs.assignment_id = v_assignment_id;
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
    true, true, true, p_generated_prompt, p_prompt_checksum, p_actor_user_id, v_now
  ) returning id into v_config_id;

  update public.sales_reps
  set email = p_member->>'workspace_email', display_name = p_member->>'display_name',
      slack_user_id = nullif(p_member->>'slack_user_id', ''), active = true, updated_at = v_now
  where user_id = nullif(p_member->>'sales_rep_user_id', '')::uuid;
  if not found then raise exception 'sales_rep_not_found'; end if;

  insert into public.sales_integration_sync_jobs (
    team_member_id, assignment_id, voice_config_id, provider, operation, status,
    provider_reference, last_error_code, last_error_detail, requested_by_user_id, completed_at
  ) values
    (p_member_id, v_assignment_id, v_config_id, 'sales_dashboard', 'apply', 'synced', p_member->>'sales_rep_user_id', null, null, p_actor_user_id, v_now),
    (p_member_id, v_assignment_id, v_config_id, 'slack', 'apply', 'action_required', null, 'slack_member_verification_required', 'Verify the saved Slack member mapping.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'ghl', 'apply', 'action_required', null, 'ghl_routing_apply_required', 'Apply and verify the saved GHL routing.', p_actor_user_id, null),
    (p_member_id, v_assignment_id, v_config_id, 'xai', 'apply', 'action_required', null, 'xai_agent_verification_required', 'Verify the reusable Grok Voice line.', p_actor_user_id, null);
  delete from public.sales_team_config_drafts where team_member_id = p_member_id;
  insert into public.sales_team_audit_events (team_member_id, assignment_id, actor_user_id, action, safe_metadata)
  values (p_member_id, v_assignment_id, p_actor_user_id, 'sales_team_configuration_applied', jsonb_build_object(
    'providers', jsonb_build_array('sales_dashboard', 'ghl', 'xai', 'slack'),
    'replaced_team_member_id', p_replace_team_member_id
  ));
  return query select v_assignment_id, v_config_id;
end;
$$;

revoke all on function public.apply_sales_team_configuration_v2(uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, boolean, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apply_sales_team_configuration_v2(uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, text, text, boolean, timestamptz, text) to service_role;
