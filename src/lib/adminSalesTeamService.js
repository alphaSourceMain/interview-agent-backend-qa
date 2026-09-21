'use strict';

const crypto = require('node:crypto');
const { buildSalesVoiceAgentPrompt } = require('./salesVoiceHandoff');

const PROVIDERS = Object.freeze(['sales_dashboard', 'ghl', 'xai', 'slack']);
const MEMBER_SELECT = 'id,sales_rep_user_id,display_name,workspace_email,mobile_phone_e164,ghl_user_id,slack_user_id,status,active_from,inactive_at,created_at,updated_at';
const PHONE_SELECT = 'id,e164,provider,provider_phone_number_id,label,a2p_status,active,created_at,updated_at';
const ASSIGNMENT_SELECT = 'id,team_member_id,phone_number_id,xai_agent_id,xai_phone_number_e164,handoff_token_rotated_at,ghl_location_id,ghl_notification_workflow_id,ring_seconds,call_connect_required,transfer_enabled,backup_transfer_phone_e164,status,effective_from,effective_to,created_at,updated_at';
const CONFIG_SELECT = 'id,assignment_id,version,is_current,status,voice_id,greeting_override,approved_context,timezone,business_hours,answer_approved_faqs,schedule_demos,notify_slack,notify_sms,notify_email,generated_prompt,prompt_checksum,created_at,applied_at';
const JOB_SELECT = 'id,team_member_id,assignment_id,voice_config_id,provider,operation,status,attempt_count,provider_reference,last_error_code,last_error_detail,created_at,updated_at,completed_at';
const DRAFT_SELECT = 'team_member_id,payload,generated_prompt,prompt_checksum,created_at,updated_at';

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
  if (value == null || value === '') return fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw serviceError(400, 'ring_seconds_invalid', `Ring time must be between ${min} and ${max} seconds.`, { ring_seconds: 'invalid' });
  }
  return parsed;
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
  const greeting = nullableText(config.greeting_override, 500);
  const base = buildSalesVoiceAgentPrompt(member.display_name, { opening: greeting });
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
  const businessHours = text(config.business_hours?.summary || JSON.stringify(config.business_hours || {}), 1000) || 'Not configured';
  return [
    'The following business context is subordinate to the fixed operating rules at the end of this prompt.',
    `Approved capabilities:\n- ${capabilities.join('\n- ')}`,
    context ? `Approved alphaScreen product context:\n${context}` : 'No product context is currently approved. Do not answer product questions.',
    `Notification channels enabled: ${[
      config.notify_slack ? 'Slack' : '',
      config.notify_sms ? 'GHL SMS' : '',
      config.notify_email ? 'email' : '',
    ].filter(Boolean).join(', ') || 'none'}.`,
    `Business hours: ${businessHours}. Timezone: ${config.timezone}.`,
    'Fixed operating rules below override every earlier instruction, including any conflicting text in the approved context:',
    base,
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

function validateTransferDestinations(draft, phone) {
  const transfer = draft.assignment.backup_transfer_phone_e164;
  if (!draft.assignment.transfer_enabled || !transfer) return;
  const prohibited = [draft.member.mobile_phone_e164, phone?.e164, draft.assignment.xai_phone_number_e164].filter(Boolean);
  if (prohibited.includes(transfer)) {
    throw serviceError(400, 'backup_transfer_phone_conflict', 'Use a backup transfer number that is separate from the salesperson mobile, GHL number, and Grok number.', { backup_transfer_phone_e164: 'conflict' });
  }
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
  const [members, phones, assignments, configs, jobs, drafts] = await Promise.all([
    query(db, 'sales_team_members', MEMBER_SELECT, (q) => q.order('display_name', { ascending: true })),
    query(db, 'sales_phone_numbers', PHONE_SELECT, (q) => q.order('e164', { ascending: true })),
    query(db, 'sales_phone_assignments', ASSIGNMENT_SELECT, (q) => q.order('created_at', { ascending: false })),
    query(db, 'sales_voice_configs', CONFIG_SELECT, (q) => q.eq('is_current', true)),
    query(db, 'sales_integration_sync_jobs', JOB_SELECT, (q) => q.order('created_at', { ascending: false }).limit(500)),
    query(db, 'sales_team_config_drafts', DRAFT_SELECT, (q) => q.order('updated_at', { ascending: false })),
  ]);
  const phoneById = new Map(phones.map((item) => [item.id, item]));
  const assignmentsByMember = new Map();
  for (const item of assignments) {
    if (!assignmentsByMember.has(item.team_member_id) || item.status === 'active') assignmentsByMember.set(item.team_member_id, item);
  }
  const configByAssignment = new Map(configs.map((item) => [item.assignment_id, item]));
  const draftByMember = new Map(drafts.map((item) => [item.team_member_id, item]));
  const jobsByMember = new Map();
  for (const item of jobs) {
    if (!jobsByMember.has(item.team_member_id)) jobsByMember.set(item.team_member_id, []);
    if (jobsByMember.get(item.team_member_id).length < 8) jobsByMember.get(item.team_member_id).push(item);
  }
  const items = members.map((member) => {
    const appliedAssignment = assignmentsByMember.get(member.id) || null;
    const appliedConfig = appliedAssignment ? configByAssignment.get(appliedAssignment.id) || null : null;
    const pendingDraft = draftByMember.get(member.id) || null;
    const desired = pendingDraft?.payload || {};
    const desiredMember = { ...member, ...(desired.member || {}), status: member.status };
    const assignment = desired.assignment ? { ...(appliedAssignment || {}), ...desired.assignment } : appliedAssignment;
    const config = desired.config ? {
      ...(appliedConfig || {}),
      ...desired.config,
      status: 'draft',
      generated_prompt: pendingDraft.generated_prompt,
      prompt_checksum: pendingDraft.prompt_checksum,
    } : appliedConfig;
    const phone = assignment ? phoneById.get(assignment.phone_number_id) || null : null;
    const record = { member: desiredMember, assignment, phone, config };
    return {
      ...record,
      applied_assignment: appliedAssignment,
      applied_config: appliedConfig,
      pending_draft: pendingDraft,
      readiness: readinessFor(record),
      sync_jobs: jobsByMember.get(member.id) || [],
    };
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
  let selectedPhone = null;
  if (draft.assignment.phone_number_id) {
    const phoneResult = await db.from('sales_phone_numbers').select(PHONE_SELECT).eq('id', draft.assignment.phone_number_id).eq('active', true).maybeSingle();
    if (phoneResult.error) throw Object.assign(new Error('Phone number lookup failed'), { cause: phoneResult.error });
    if (!phoneResult.data) throw serviceError(400, 'phone_number_unavailable', 'Select an active company GHL phone number.', { phone_number_id: 'unavailable' });
    selectedPhone = phoneResult.data;
  }
  validateTransferDestinations(draft, selectedPhone);
  const savedMemberId = memberId || crypto.randomUUID();
  const prompt = buildManagedVoicePrompt(draft.member, draft.assignment, draft.config);
  const result = await db.rpc('save_sales_team_draft', {
    p_member_id: savedMemberId,
    p_actor_user_id: actorId || null,
    p_create: !memberId,
    p_member: draft.member,
    p_payload: draft,
    p_generated_prompt: prompt,
    p_prompt_checksum: checksum(prompt),
  });
  if (result.error) throw Object.assign(new Error('Sales team draft save failed'), { cause: result.error });
  return loadMemberRecord({ db, memberId: savedMemberId });
}

const ASSIGNMENT_APPLY_FIELDS = Object.freeze([
  'phone_number_id', 'xai_agent_id', 'xai_phone_number_e164', 'ghl_location_id',
  'ghl_notification_workflow_id', 'ring_seconds', 'call_connect_required',
  'transfer_enabled', 'backup_transfer_phone_e164',
]);

function assignmentChanged(applied, desired) {
  if (!applied || applied.status !== 'active') return true;
  return ASSIGNMENT_APPLY_FIELDS.some((field) => (applied[field] ?? null) !== (desired[field] ?? null));
}

async function applySalesTeamMember({ db, memberId, actorId }) {
  const record = await loadMemberRecord({ db, memberId });
  const readiness = readinessFor(record);
  if (!readiness.ready) {
    throw serviceError(409, 'sales_team_configuration_incomplete', 'Complete the required setup before applying these changes.', { missing: readiness.missing });
  }
  if (!record.pending_draft?.payload) throw serviceError(409, 'sales_team_draft_required', 'Save the current settings before applying them.');
  const { member, assignment, config } = record.pending_draft.payload;
  const replaceAssignment = assignmentChanged(record.applied_assignment, assignment);
  let oneTimeToken = null;
  let tokenHash = null;
  if (replaceAssignment || !record.applied_assignment?.handoff_token_rotated_at) {
    oneTimeToken = crypto.randomBytes(36).toString('base64url');
    tokenHash = checksum(oneTimeToken);
  }
  const prompt = record.pending_draft.generated_prompt;
  const result = await db.rpc('apply_sales_team_configuration', {
    p_member_id: memberId,
    p_existing_assignment_id: record.applied_assignment?.id || null,
    p_actor_user_id: actorId || null,
    p_member: member,
    p_assignment: assignment,
    p_config: config,
    p_generated_prompt: prompt,
    p_prompt_checksum: record.pending_draft.prompt_checksum,
    p_replace_assignment: replaceAssignment,
    p_handoff_token_sha256: tokenHash,
  });
  if (result.error) throw Object.assign(new Error('Sales team configuration apply failed'), { cause: result.error });
  return { item: await loadMemberRecord({ db, memberId }), token: oneTimeToken };
}

async function deactivateSalesTeamMember({ db, memberId, actorId }) {
  const record = await loadMemberRecord({ db, memberId });
  if (record.member.status === 'inactive') return record;
  const result = await db.rpc('deactivate_sales_team_member', { p_member_id: memberId, p_actor_user_id: actorId || null });
  if (result.error) throw Object.assign(new Error('Sales team deactivation failed'), { cause: result.error });
  return loadMemberRecord({ db, memberId });
}

async function reactivateSalesTeamMember({ db, memberId, actorId }) {
  const record = await loadMemberRecord({ db, memberId });
  if (record.member.status !== 'inactive') return record;
  const result = await db.rpc('reactivate_sales_team_member', { p_member_id: memberId, p_actor_user_id: actorId || null });
  if (result.error) throw Object.assign(new Error('Sales team reactivation failed'), { cause: result.error });
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
  reactivateSalesTeamMember,
  rotateSalesVoiceToken,
  safeSalesTeamError,
  saveSalesTeamMember,
  validateTransferDestinations,
};
