'use strict';

const crypto = require('node:crypto');
const { buildSalesVoiceAgentPrompt } = require('./salesVoiceHandoff');

const PROVIDERS = Object.freeze(['sales_dashboard', 'ghl', 'xai', 'slack']);
const MEMBER_SELECT = 'id,sales_rep_user_id,display_name,workspace_email,mobile_phone_e164,ghl_user_id,slack_user_id,status,active_from,inactive_at,created_at,updated_at';
const PHONE_SELECT = 'id,e164,provider,provider_phone_number_id,label,a2p_status,active,created_at,updated_at';
const ASSIGNMENT_SELECT = 'id,team_member_id,phone_number_id,xai_agent_id,xai_phone_number_e164,handoff_token_rotated_at,ghl_location_id,ghl_notification_workflow_id,ring_seconds,call_connect_required,transfer_enabled,backup_transfer_phone_e164,status,effective_from,effective_to,created_at,updated_at';
const CONFIG_SELECT = 'id,assignment_id,version,is_current,status,voice_id,greeting_override,approved_context,timezone,business_hours,answer_approved_faqs,schedule_demos,notify_slack,notify_sms,notify_email,generated_prompt,prompt_checksum,created_at,applied_at';
const JOB_SELECT = 'id,team_member_id,assignment_id,voice_config_id,provider,operation,status,attempt_count,provider_reference,last_error_code,last_error_detail,created_at,updated_at,completed_at';

function serviceError(status, code, detail, fields) {
  return Object.assign(new Error(detail), { status, code, detail, fields });
}

function safeSalesTeamError(error, requestId = null) {
  const status = Number(error?.status) || 500;
  const known = status >= 400 && status < 500;
  return {
    error: known ? String(error?.code || 'sales_team_request_invalid') : 'sales_team_unavailable',
    code: known ? String(error?.code || 'sales_team_request_invalid') : 'sales_team_unavailable',
    detail: known ? String(error?.detail || error?.message || 'The request could not be completed.') : 'Sales team configuration is temporarily unavailable.',
    ...(known && error?.fields ? { fields: error.fields } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

function text(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function nullableText(value, max) {
  const normalized = text(value, max);
  return normalized || null;
}

function email(value) {
  const normalized = nullableText(value, 254)?.toLowerCase() || null;
  if (normalized && !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(normalized)) {
    throw serviceError(400, 'workspace_email_invalid', 'Enter a valid Workspace email address.', { workspace_email: 'invalid' });
  }
  return normalized;
}

function e164(value, field, required = false) {
  const normalized = nullableText(value, 16);
  if (!normalized && !required) return null;
  if (!/^\+1[2-9]\d{9}$/.test(normalized || '')) {
    throw serviceError(400, `${field}_invalid`, `Enter ${field.replaceAll('_', ' ')} in +1XXXXXXXXXX format.`, { [field]: 'invalid' });
  }
  return normalized;
}

function uuid(value, field, required = false) {
  const normalized = nullableText(value, 64);
  if (!normalized && !required) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized || '')) {
    throw serviceError(400, `${field}_invalid`, `Select a valid ${field.replaceAll('_', ' ')}.`, { [field]: 'invalid' });
  }
  return normalized;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function checksum(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeBusinessHours(value) {
  if (value == null || value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(400, 'business_hours_invalid', 'Business hours must be an object.', { business_hours: 'invalid' });
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 4000) {
    throw serviceError(400, 'business_hours_too_large', 'Business hours are too large.', { business_hours: 'too_large' });
  }
  return JSON.parse(serialized);
}

function buildManagedVoicePrompt(member, assignment, config) {
  const base = buildSalesVoiceAgentPrompt(member.display_name);
  const greeting = nullableText(config.greeting_override, 500);
  const context = text(config.approved_context, 6000);
  const capabilities = [
    config.answer_approved_faqs
      ? 'You may answer alphaScreen questions only from the approved product context below. If the answer is not in that context, offer to send a message to the sales representative.'
      : 'Do not answer product questions. Offer to send a message to the sales representative.',
    config.schedule_demos
      ? 'You may help the caller schedule a demo using only the configured scheduling capability.'
      : 'Do not schedule or promise a demo time.',
    assignment.transfer_enabled
      ? 'You may offer a live transfer only to the configured backup destination after the caller asks to be connected. If transfer fails, continue the call and offer to send a message.'
      : 'Do not offer a live transfer. Offer to send a message instead.',
  ];
  return [
    base,
    greeting ? `Use this approved opening instead of the default opening:\n${greeting}` : '',
    `Approved capabilities:\n- ${capabilities.join('\n- ')}`,
    context ? `Approved alphaScreen product context:\n${context}` : 'No product context is currently approved. Do not answer product questions.',
    `Notification channels enabled: ${[
      config.notify_slack ? 'Slack' : '',
      config.notify_sms ? 'GHL SMS' : '',
      config.notify_email ? 'email' : '',
    ].filter(Boolean).join(', ') || 'none'}.`,
    `Business-hours timezone: ${config.timezone}.`,
  ].filter(Boolean).join('\n\n');
}

function normalizeDraft(body = {}, current = {}) {
  const member = {
    display_name: text(body.display_name ?? current.member?.display_name, 120),
    workspace_email: email(body.workspace_email ?? current.member?.workspace_email),
    mobile_phone_e164: e164(body.mobile_phone_e164 ?? current.member?.mobile_phone_e164, 'mobile_phone'),
    sales_rep_user_id: uuid(body.sales_rep_user_id ?? current.member?.sales_rep_user_id, 'sales_rep_user_id'),
    ghl_user_id: nullableText(body.ghl_user_id ?? current.member?.ghl_user_id, 120),
    slack_user_id: nullableText(body.slack_user_id ?? current.member?.slack_user_id, 24),
  };
  if (!member.display_name) {
    throw serviceError(400, 'display_name_required', 'Enter the salesperson’s name.', { display_name: 'required' });
  }
  if (member.slack_user_id && !/^[UW][A-Z0-9]{8,20}$/.test(member.slack_user_id)) {
    throw serviceError(400, 'slack_user_id_invalid', 'Enter a valid Slack member ID.', { slack_user_id: 'invalid' });
  }

  const assignment = {
    phone_number_id: uuid(body.phone_number_id ?? current.assignment?.phone_number_id, 'phone_number_id'),
    xai_agent_id: nullableText(body.xai_agent_id ?? current.assignment?.xai_agent_id, 160),
    xai_phone_number_e164: e164(body.xai_phone_number_e164 ?? current.assignment?.xai_phone_number_e164, 'xai_phone_number'),
    ghl_location_id: nullableText(body.ghl_location_id ?? current.assignment?.ghl_location_id, 160),
    ghl_notification_workflow_id: nullableText(body.ghl_notification_workflow_id ?? current.assignment?.ghl_notification_workflow_id, 160),
    ring_seconds: int(body.ring_seconds ?? current.assignment?.ring_seconds, 20, 10, 25),
    call_connect_required: true,
    transfer_enabled: bool(body.transfer_enabled, current.assignment?.transfer_enabled === true),
    backup_transfer_phone_e164: null,
  };
  assignment.backup_transfer_phone_e164 = assignment.transfer_enabled
    ? e164(body.backup_transfer_phone_e164 ?? current.assignment?.backup_transfer_phone_e164, 'backup_transfer_phone', true)
    : null;

  const config = {
    voice_id: text(body.voice_id ?? current.config?.voice_id ?? 'eve', 80) || 'eve',
    greeting_override: nullableText(body.greeting_override ?? current.config?.greeting_override, 500),
    approved_context: text(body.approved_context ?? current.config?.approved_context, 6000),
    timezone: text(body.timezone ?? current.config?.timezone ?? 'America/Denver', 80) || 'America/Denver',
    business_hours: normalizeBusinessHours(body.business_hours ?? current.config?.business_hours),
    answer_approved_faqs: bool(body.answer_approved_faqs, current.config?.answer_approved_faqs !== false),
    schedule_demos: bool(body.schedule_demos, current.config?.schedule_demos !== false),
    notify_slack: bool(body.notify_slack, current.config?.notify_slack !== false),
    notify_sms: bool(body.notify_sms, current.config?.notify_sms !== false),
    notify_email: bool(body.notify_email, current.config?.notify_email !== false),
  };
  if (![config.notify_slack, config.notify_sms, config.notify_email].some(Boolean)) {
    throw serviceError(400, 'notification_channel_required', 'Enable at least one notification channel.', { notifications: 'required' });
  }
  return { member, assignment, config };
}

function readinessFor(record) {
  const missing = [];
  const { member, assignment, config, phone } = record;
  if (!member.workspace_email) missing.push('Workspace email');
  if (!member.mobile_phone_e164) missing.push('Mobile number');
  if (!member.sales_rep_user_id) missing.push('Sales dashboard user');
  if (!member.ghl_user_id) missing.push('GHL user');
  if (!member.slack_user_id && config?.notify_slack !== false) missing.push('Slack member');
  if (!phone?.id) missing.push('GHL phone number');
  if (!assignment?.xai_agent_id) missing.push('Grok Voice agent');
  if (!assignment?.xai_phone_number_e164) missing.push('Grok Voice phone number');
  if (!assignment?.ghl_location_id) missing.push('GHL location');
  if (!assignment?.ghl_notification_workflow_id && config?.notify_sms !== false) missing.push('GHL notification workflow');
  if (assignment?.transfer_enabled && !assignment?.backup_transfer_phone_e164) missing.push('Backup transfer number');
  if (assignment?.backup_transfer_phone_e164 && [member.mobile_phone_e164, phone?.e164, assignment.xai_phone_number_e164].includes(assignment.backup_transfer_phone_e164)) {
    missing.push('Separate backup transfer number');
  }
  return { ready: missing.length === 0, missing };
}

async function query(db, table, select, mutate) {
  let request = db.from(table).select(select);
  if (typeof mutate === 'function') request = mutate(request);
  const { data, error } = await request;
  if (error) throw Object.assign(new Error(`${table} query failed`), { cause: error });
  return data || [];
}

async function loadAdminSalesTeam({ db }) {
  if (!db) throw new Error('Database is not configured');
  const [members, phones, assignments, configs, jobs] = await Promise.all([
    query(db, 'sales_team_members', MEMBER_SELECT, (q) => q.order('display_name', { ascending: true })),
    query(db, 'sales_phone_numbers', PHONE_SELECT, (q) => q.order('e164', { ascending: true })),
    query(db, 'sales_phone_assignments', ASSIGNMENT_SELECT, (q) => q.order('created_at', { ascending: false })),
    query(db, 'sales_voice_configs', CONFIG_SELECT, (q) => q.eq('is_current', true)),
    query(db, 'sales_integration_sync_jobs', JOB_SELECT, (q) => q.order('created_at', { ascending: false }).limit(500)),
  ]);
  const phoneById = new Map(phones.map((item) => [item.id, item]));
  const assignmentsByMember = new Map();
  for (const item of assignments) {
    if (!assignmentsByMember.has(item.team_member_id) || item.status === 'active') assignmentsByMember.set(item.team_member_id, item);
  }
  const configByAssignment = new Map(configs.map((item) => [item.assignment_id, item]));
  const jobsByMember = new Map();
  for (const item of jobs) {
    if (!jobsByMember.has(item.team_member_id)) jobsByMember.set(item.team_member_id, []);
    if (jobsByMember.get(item.team_member_id).length < 8) jobsByMember.get(item.team_member_id).push(item);
  }
  const items = members.map((member) => {
    const assignment = assignmentsByMember.get(member.id) || null;
    const phone = assignment ? phoneById.get(assignment.phone_number_id) || null : null;
    const config = assignment ? configByAssignment.get(assignment.id) || null : null;
    const record = { member, assignment, phone, config };
    return { ...record, readiness: readinessFor(record), sync_jobs: jobsByMember.get(member.id) || [] };
  });
  return { items, phone_numbers: phones, providers: PROVIDERS };
}

async function loadMemberRecord({ db, memberId }) {
  const payload = await loadAdminSalesTeam({ db });
  const record = payload.items.find((item) => item.member.id === memberId);
  if (!record) throw serviceError(404, 'sales_team_member_not_found', 'Salesperson not found.');
  return record;
}

async function writeAudit(db, actorId, action, memberId, assignmentId, safeMetadata = {}) {
  const { error } = await db.from('sales_team_audit_events').insert({
    actor_user_id: actorId || null,
    action,
    team_member_id: memberId || null,
    assignment_id: assignmentId || null,
    safe_metadata: safeMetadata,
  });
  if (error) throw Object.assign(new Error('Sales team audit write failed'), { cause: error });
}

async function saveSalesTeamMember({ db, memberId, body, actorId }) {
  if (!db) throw new Error('Database is not configured');
  const current = memberId ? await loadMemberRecord({ db, memberId }) : {};
  if (current.member?.status === 'inactive') {
    throw serviceError(409, 'sales_team_member_inactive', 'Reactivate this salesperson before editing their configuration.');
  }
  const draft = normalizeDraft(body, current);
  const now = new Date().toISOString();
  let savedMember;
  if (memberId) {
    const { data, error } = await db.from('sales_team_members').update({
      ...draft.member,
      status: current.member.status === 'active' ? 'active' : 'draft',
      updated_by_user_id: actorId || null,
      updated_at: now,
    }).eq('id', memberId).select(MEMBER_SELECT).single();
    if (error) throw Object.assign(new Error('Sales team member update failed'), { cause: error });
    savedMember = data;
  } else {
    const { data, error } = await db.from('sales_team_members').insert({
      ...draft.member,
      status: 'draft',
      created_by_user_id: actorId || null,
      updated_by_user_id: actorId || null,
    }).select(MEMBER_SELECT).single();
    if (error) throw Object.assign(new Error('Sales team member create failed'), { cause: error });
    savedMember = data;
  }

  let assignment = current.assignment || null;
  if (draft.assignment.phone_number_id) {
    const assignmentValues = {
      ...draft.assignment,
      team_member_id: savedMember.id,
      status: assignment?.status === 'active' ? 'active' : 'draft',
      updated_by_user_id: actorId || null,
      updated_at: now,
    };
    if (assignment) {
      const result = await db.from('sales_phone_assignments').update(assignmentValues).eq('id', assignment.id).select(ASSIGNMENT_SELECT).single();
      if (result.error) throw Object.assign(new Error('Phone assignment update failed'), { cause: result.error });
      assignment = result.data;
    } else {
      const result = await db.from('sales_phone_assignments').insert({
        ...assignmentValues,
        created_by_user_id: actorId || null,
      }).select(ASSIGNMENT_SELECT).single();
      if (result.error) throw Object.assign(new Error('Phone assignment create failed'), { cause: result.error });
      assignment = result.data;
    }
  }

  if (assignment) {
    const prompt = buildManagedVoicePrompt(savedMember, assignment, draft.config);
    const priorVersion = Number(current.config?.version) || 0;
    if (current.config?.id) {
      const { error } = await db.from('sales_voice_configs').update({ is_current: false, status: current.config.status === 'applied' ? 'superseded' : current.config.status }).eq('id', current.config.id);
      if (error) throw Object.assign(new Error('Voice configuration version update failed'), { cause: error });
    }
    const { error } = await db.from('sales_voice_configs').insert({
      assignment_id: assignment.id,
      version: priorVersion + 1,
      is_current: true,
      status: 'draft',
      ...draft.config,
      generated_prompt: prompt,
      prompt_checksum: checksum(prompt),
      created_by_user_id: actorId || null,
    });
    if (error) throw Object.assign(new Error('Voice configuration create failed'), { cause: error });
  }

  await writeAudit(db, actorId, memberId ? 'sales_team_member_updated' : 'sales_team_member_created', savedMember.id, assignment?.id || null, {
    assigned_phone: Boolean(assignment),
    has_dashboard_user: Boolean(savedMember.sales_rep_user_id),
  });
  return loadMemberRecord({ db, memberId: savedMember.id });
}

async function applySalesTeamMember({ db, memberId, actorId }) {
  const record = await loadMemberRecord({ db, memberId });
  const readiness = readinessFor(record);
  if (!readiness.ready) {
    throw serviceError(409, 'sales_team_configuration_incomplete', 'Complete the required setup before applying these changes.', { missing: readiness.missing });
  }
  const now = new Date().toISOString();
  const { member, assignment, config } = record;
  if (!config?.id) throw serviceError(409, 'sales_voice_config_missing', 'Save the voice-agent configuration before applying it.');

  const memberUpdate = await db.from('sales_team_members').update({ status: 'active', active_from: member.active_from || now.slice(0, 10), inactive_at: null, updated_by_user_id: actorId || null, updated_at: now }).eq('id', member.id);
  if (memberUpdate.error) throw Object.assign(new Error('Sales team activation failed'), { cause: memberUpdate.error });
  const assignmentUpdate = await db.from('sales_phone_assignments').update({ status: 'active', effective_from: assignment.effective_from || now, effective_to: null, updated_by_user_id: actorId || null, updated_at: now }).eq('id', assignment.id);
  if (assignmentUpdate.error) throw Object.assign(new Error('Phone assignment activation failed'), { cause: assignmentUpdate.error });
  const configUpdate = await db.from('sales_voice_configs').update({ status: 'applied', applied_at: now }).eq('id', config.id);
  if (configUpdate.error) throw Object.assign(new Error('Voice configuration activation failed'), { cause: configUpdate.error });

  if (member.sales_rep_user_id) {
    const repUpdate = await db.from('sales_reps').update({
      email: member.workspace_email,
      display_name: member.display_name,
      slack_user_id: member.slack_user_id,
      active: true,
      updated_at: now,
    }).eq('user_id', member.sales_rep_user_id);
    if (repUpdate.error) throw Object.assign(new Error('Sales dashboard representative sync failed'), { cause: repUpdate.error });
  }

  const jobs = [
    { provider: 'sales_dashboard', status: 'synced', provider_reference: member.sales_rep_user_id },
    { provider: 'slack', status: 'synced', provider_reference: member.slack_user_id },
    { provider: 'ghl', status: 'action_required', last_error_code: 'ghl_routing_apply_required', last_error_detail: 'Apply and verify the saved number routing in GHL.' },
    { provider: 'xai', status: 'action_required', last_error_code: 'xai_agent_publish_required', last_error_detail: 'Apply the generated prompt and verify the published Grok Voice agent.' },
  ].map((job) => ({
    team_member_id: member.id,
    assignment_id: assignment.id,
    voice_config_id: config.id,
    operation: 'apply',
    requested_by_user_id: actorId || null,
    completed_at: job.status === 'synced' ? now : null,
    ...job,
  }));
  const jobsInsert = await db.from('sales_integration_sync_jobs').insert(jobs);
  if (jobsInsert.error) throw Object.assign(new Error('Provider sync job create failed'), { cause: jobsInsert.error });
  await writeAudit(db, actorId, 'sales_team_configuration_applied', member.id, assignment.id, { providers: PROVIDERS });
  return loadMemberRecord({ db, memberId });
}

async function deactivateSalesTeamMember({ db, memberId, actorId }) {
  const record = await loadMemberRecord({ db, memberId });
  if (record.member.status === 'inactive') return record;
  const now = new Date().toISOString();
  const memberUpdate = await db.from('sales_team_members').update({ status: 'inactive', inactive_at: now, updated_by_user_id: actorId || null, updated_at: now }).eq('id', memberId);
  if (memberUpdate.error) throw Object.assign(new Error('Sales team deactivation failed'), { cause: memberUpdate.error });
  if (record.assignment?.id) {
    const assignmentUpdate = await db.from('sales_phone_assignments').update({ status: 'inactive', effective_to: now, updated_by_user_id: actorId || null, updated_at: now }).eq('id', record.assignment.id);
    if (assignmentUpdate.error) throw Object.assign(new Error('Phone assignment deactivation failed'), { cause: assignmentUpdate.error });
  }
  if (record.member.sales_rep_user_id) {
    const repUpdate = await db.from('sales_reps').update({ active: false, updated_at: now }).eq('user_id', record.member.sales_rep_user_id);
    if (repUpdate.error) throw Object.assign(new Error('Sales dashboard deactivation failed'), { cause: repUpdate.error });
  }
  const jobs = PROVIDERS.map((provider) => ({
    team_member_id: memberId,
    assignment_id: record.assignment?.id || null,
    voice_config_id: record.config?.id || null,
    provider,
    operation: 'deactivate',
    status: provider === 'sales_dashboard' ? 'synced' : 'action_required',
    last_error_code: provider === 'sales_dashboard' ? null : `${provider}_deactivation_required`,
    last_error_detail: provider === 'sales_dashboard' ? null : `Disable or reassign this salesperson in ${provider === 'xai' ? 'Grok Voice' : provider === 'ghl' ? 'GHL' : 'Slack'}.`,
    requested_by_user_id: actorId || null,
    completed_at: provider === 'sales_dashboard' ? now : null,
  }));
  const jobsInsert = await db.from('sales_integration_sync_jobs').insert(jobs);
  if (jobsInsert.error) throw Object.assign(new Error('Deactivation job create failed'), { cause: jobsInsert.error });
  await writeAudit(db, actorId, 'sales_team_member_deactivated', memberId, record.assignment?.id || null, {});
  return loadMemberRecord({ db, memberId });
}

async function rotateSalesVoiceToken({ db, memberId, actorId }) {
  const record = await loadMemberRecord({ db, memberId });
  if (!record.assignment?.id) {
    throw serviceError(409, 'sales_phone_assignment_missing', 'Assign a GHL phone number before creating the agent token.');
  }
  if (record.member.status === 'inactive') {
    throw serviceError(409, 'sales_team_member_inactive', 'Reactivate this salesperson before creating an agent token.');
  }
  const token = crypto.randomBytes(36).toString('base64url');
  const now = new Date().toISOString();
  const { error } = await db.from('sales_phone_assignments').update({
    handoff_token_sha256: checksum(token),
    handoff_token_rotated_at: now,
    updated_by_user_id: actorId || null,
    updated_at: now,
  }).eq('id', record.assignment.id);
  if (error) throw Object.assign(new Error('Sales voice token rotation failed'), { cause: error });
  await writeAudit(db, actorId, 'sales_voice_handoff_token_rotated', memberId, record.assignment.id, {});
  return { token, item: await loadMemberRecord({ db, memberId }) };
}

module.exports = {
  PROVIDERS,
  applySalesTeamMember,
  buildManagedVoicePrompt,
  deactivateSalesTeamMember,
  loadAdminSalesTeam,
  normalizeDraft,
  readinessFor,
  rotateSalesVoiceToken,
  safeSalesTeamError,
  saveSalesTeamMember,
};
