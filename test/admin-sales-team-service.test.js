'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  applySalesTeamMember,
  buildManagedVoicePrompt,
  deactivateSalesTeamMember,
  normalizeDraft,
  readinessFor,
  rotateSalesVoiceToken,
  saveSalesLineSetup,
  validateTransferDestinations,
} = require('../src/lib/adminSalesTeamService');

const member = {
  id: '22000000-0000-4000-8000-000000000001',
  sales_rep_user_id: '11111111-1111-4111-8111-111111111111',
  display_name: 'Michael Afesi',
  workspace_email: 'michael@alphasourceai.com',
  mobile_phone_e164: '+17205551212',
  ghl_user_id: 'ghl-user-1',
  slack_user_id: 'U123456789',
  status: 'draft',
};
const assignment = {
  id: '23000000-0000-4000-8000-000000000001',
  team_member_id: member.id,
  phone_number_id: '21000000-0000-4000-8000-000000000001',
  xai_agent_id: 'agent_1LDTasuwSoOhfbsZ',
  xai_phone_number_e164: '+17205550001',
  ghl_location_id: 'location-1',
  ghl_notification_workflow_id: 'workflow-1',
  ring_seconds: 20,
  call_connect_required: true,
  transfer_enabled: true,
  backup_transfer_phone_e164: '+17205550002',
  status: 'draft',
  created_at: '2026-09-21T00:00:00Z',
};
const config = {
  voice_id: 'eve', greeting_override: null,
  approved_context: 'alphaScreen offers Essential and Pro memberships.',
  timezone: 'America/Denver', business_hours: { summary: 'Monday-Friday' },
  answer_approved_faqs: true, schedule_demos: true,
  notify_slack: true, notify_sms: true, notify_email: true,
};
const phone = {
  id: assignment.phone_number_id, e164: '+17207904187', provider: 'ghl', a2p_status: 'verified', active: true,
  xai_agent_id: assignment.xai_agent_id, xai_phone_number_e164: assignment.xai_phone_number_e164,
  ghl_location_id: assignment.ghl_location_id, ghl_routing_workflow_id: 'routing-workflow-1',
  ghl_notification_workflow_id: assignment.ghl_notification_workflow_id,
  ghl_mobile_custom_value_id: 'mobile-value-1', ghl_mobile_custom_value_name: 'alphaScreen Line 1 Mobile',
  ghl_user_custom_value_id: 'user-value-1', ghl_user_custom_value_name: 'alphaScreen Line 1 GHL User ID',
  xai_setup_status: 'verified', ghl_setup_status: 'verified', xai_verified_at: '2026-09-21T00:45:00Z',
  xai_verification_reference: 'qa-call-line-1', handoff_token_sha256: 'a'.repeat(64), handoff_token_rotated_at: '2026-09-21T00:30:00Z',
};

class FakeQuery {
  constructor(db, table) { this.db = db; this.table = table; this.filters = []; this.orderField = null; this.ascending = true; this.limitCount = null; }
  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  order(column, options = {}) { this.orderField = column; this.ascending = options.ascending === true; return this; }
  limit(value) { this.limitCount = Number(value); return this; }
  maybeSingle() { return Promise.resolve(this.result(true)); }
  result(single = false) {
    let rows = (this.db.tables[this.table] || []).filter((row) => this.filters.every(([column, value]) => row[column] === value));
    if (this.orderField) rows = [...rows].sort((a, b) => String(a[this.orderField] || '').localeCompare(String(b[this.orderField] || '')) * (this.ascending ? 1 : -1));
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    return { data: single ? rows[0] || null : rows.map((row) => ({ ...row })), error: null };
  }
  then(resolve, reject) { try { resolve(this.result()); } catch (error) { reject(error); } }
}

function makeDb({ applyError = null, incumbent = null, concurrentWinner = null } = {}) {
  const draftPayload = { member: { ...member }, assignment: { ...assignment }, config: { ...config } };
  const tables = {
    sales_team_members: [{ ...member, created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T00:00:00Z' }],
    sales_phone_numbers: [{ ...phone }],
    sales_phone_assignments: [{ ...assignment }],
    sales_voice_configs: [], sales_integration_sync_jobs: [],
    sales_team_config_drafts: [{ team_member_id: member.id, payload: draftPayload, generated_prompt: buildManagedVoicePrompt(member, assignment, config), prompt_checksum: 'b'.repeat(64), updated_at: '2026-09-21T00:00:00Z' }],
  };
  if (incumbent) {
    tables.sales_team_members.push({ ...incumbent, status: 'active', created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z' });
    tables.sales_phone_assignments.push({ ...assignment, id: '23000000-0000-4000-8000-000000000099', team_member_id: incumbent.id, status: 'active', effective_from: '2026-09-20T00:00:00Z', created_at: '2026-09-20T00:00:00Z' });
  }
  const calls = [];
  return {
    tables, calls,
    from(table) { return new FakeQuery(this, table); },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'apply_sales_team_configuration_v2') {
        if (applyError) {
          if (concurrentWinner) {
            tables.sales_team_members.push({ ...concurrentWinner, status: 'active', created_at: '2026-09-21T00:30:00Z', updated_at: '2026-09-21T00:30:00Z' });
            tables.sales_phone_assignments.push({ ...assignment, id: '23000000-0000-4000-8000-000000000098', team_member_id: concurrentWinner.id, status: 'active', effective_from: '2026-09-21T00:30:00Z', created_at: '2026-09-21T00:30:00Z' });
          }
          return { data: null, error: applyError };
        }
        const old = tables.sales_phone_assignments.find((row) => row.status === 'active' && row.team_member_id !== member.id);
        if (old) old.status = 'inactive';
        const target = tables.sales_phone_assignments.find((row) => row.team_member_id === member.id);
        target.status = 'active'; target.effective_from = '2026-09-21T01:00:00Z'; target.handoff_token_rotated_at = '2026-09-21T01:00:00Z';
        tables.sales_team_members[0] = { ...tables.sales_team_members[0], ...args.p_member, status: 'active' };
        if (old) tables.sales_team_members.find((row) => row.id === old.team_member_id).status = 'inactive';
        tables.sales_voice_configs.push({ id: 'config-1', assignment_id: target.id, version: 1, is_current: true, status: 'applied', ...args.p_config, generated_prompt: args.p_generated_prompt, prompt_checksum: args.p_prompt_checksum });
        tables.sales_team_config_drafts = [];
      }
      if (name === 'save_sales_voice_line_setup') Object.assign(tables.sales_phone_numbers[0], args.p_setup);
      if (name === 'deactivate_sales_team_member') {
        const targetMember = tables.sales_team_members.find((row) => row.id === args.p_member_id);
        if (targetMember) targetMember.status = 'inactive';
        for (const row of tables.sales_phone_assignments) {
          if (row.team_member_id === args.p_member_id && row.status === 'active') row.status = 'inactive';
        }
      }
      if (name === 'rotate_sales_voice_line_token') {
        const targetPhone = tables.sales_phone_numbers.find((row) => row.id === args.p_phone_number_id);
        Object.assign(targetPhone, { handoff_token_sha256: args.p_handoff_token_sha256, handoff_token_rotated_at: '2026-09-21T02:00:00Z', xai_setup_status: 'pending' });
      }
      return { data: null, error: null };
    },
  };
}

function providerFake() {
  const state = {
    user: { id: 'ghl-user-1', email: member.workspace_email, phone: '+13035550000', active: true, roles: { locationIds: ['location-1'] } },
    values: {
      'mobile-value-1': { id: 'mobile-value-1', name: phone.ghl_mobile_custom_value_name, value: '+13035550001' },
      'user-value-1': { id: 'user-value-1', name: phone.ghl_user_custom_value_name, value: 'old-user' },
    },
    writes: [],
  };
  const fetchImpl = async (url, options) => {
    if (url.includes('slack.com')) return { ok: true, status: 200, json: async () => ({ ok: true, user: { id: member.slack_user_id, deleted: false } }) };
    if (/\/users\//.test(url)) {
      const userId = url.split('/').pop();
      if (userId !== state.user.id) state.user = { id: userId, email: 'winner@alphasourceai.com', phone: '+13035550002', active: true, roles: { locationIds: ['location-1'] } };
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ user: { ...state.user } }) };
      state.user.phone = JSON.parse(options.body).phone;
      state.writes.push({ type: 'user', userId, phone: state.user.phone });
      return { ok: true, status: 200, json: async () => ({ user: { ...state.user } }) };
    }
    const id = url.split('/').pop();
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ customValue: { ...state.values[id] } }) };
    state.values[id] = { id, ...JSON.parse(options.body) };
    state.writes.push({ type: 'value', id, value: state.values[id].value });
    return { ok: true, status: 200, json: async () => ({ customValue: { ...state.values[id] } }) };
  };
  return { state, fetchImpl };
}

const applyEnv = {
  SALES_TEAM_PROVIDER_SYNC_ENABLED: 'true',
  SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ [phone.e164]: 'https://example.leadconnectorhq.com/hooks/line-1' }),
  GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-' + 'g'.repeat(40),
  SLACK_SALES_WON_BOT_TOKEN: 'xoxb-' + 's'.repeat(40),
};

test('sales team route is mounted behind authentication and global-admin authorization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /adminRouter\.use\('\/sales-team', requireAuth, requireAdmin, createAdminSalesTeamRouter\(\{ db: supabaseAdmin \}\)\)/);
});

test('completion migration adds fixed GHL user routing and service-role-only atomic replacement', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260921225344_sales_routing_control_plane_completion.sql'), 'utf8').toLowerCase();
  assert.match(sql, /add column if not exists ghl_user_custom_value_id text/);
  assert.match(sql, /create unique index if not exists sales_phone_numbers_ghl_user_value_uidx/);
  assert.match(sql, /create or replace function public\.apply_sales_team_configuration_v2/);
  assert.match(sql, /raise exception 'sales_phone_replacement_stale'/);
  assert.match(sql, /update public\.sales_team_members[\s\S]*status = 'inactive'/);
  assert.match(sql, /update public\.sales_reps set active = false/);
  assert.match(sql, /if not found then raise exception 'sales_rep_not_found'/);
  assert.match(sql, /when handoff_token_sha256 is distinct from p_handoff_token_sha256 then v_now/);
  assert.match(sql, /set ghl_setup_status = 'pending'[\s\S]*ghl_user_custom_value_id is null/);
  assert.match(sql, /revoke all on function public\.apply_sales_team_configuration_v2[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /revoke execute on function public\.apply_sales_team_configuration\([\s\S]*from service_role/);
  assert.match(sql, /grant execute on function public\.apply_sales_team_configuration_v2[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /grant [^;]* to (?:anon|authenticated)/);
});

test('shared voice migration keeps routing server-only and single-use', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260922112921_shared_sales_voice_routing.sql'), 'utf8').toLowerCase();
  assert.match(sql, /shared_voice_entrypoint boolean not null default false/);
  assert.match(sql, /create unique index if not exists sales_phone_numbers_single_shared_voice_entrypoint_uidx/);
  assert.match(sql, /create table if not exists public\.sales_voice_route_events/);
  assert.match(sql, /create table if not exists public\.sales_voice_call_contexts/);
  assert.match(sql, /create or replace function public\.record_sales_voice_route/);
  assert.match(sql, /create or replace function public\.create_sales_voice_call_context/);
  assert.match(sql, /create or replace function public\.claim_sales_voice_call_context/);
  assert.match(sql, /returns table \(assignment_id uuid, caller_phone_e164 text\)/i);
  assert.match(sql, /and context\.claimed_at is null/);
  assert.match(sql, /revoke all on table public\.sales_voice_route_events from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.claim_sales_voice_call_context\(text\) to service_role/);
  assert.doesNotMatch(sql, /grant [^;]* to (?:anon|authenticated)/);
});

test('draft normalization locks Call Connect and all three caller-message channels', () => {
  const draft = normalizeDraft({ ...member, ...assignment, ...config, ring_seconds: 10 });
  assert.equal(draft.assignment.call_connect_required, true);
  assert.equal(draft.assignment.ring_seconds, 20);
  assert.deepEqual([draft.config.notify_slack, draft.config.notify_sms, draft.config.notify_email], [true, true, true]);
  assert.throws(() => normalizeDraft({ ...member, ...assignment, ...config, notify_slack: false }), /notifications are required/i);
  assert.throws(() => normalizeDraft({ ...member, ...assignment, ...config, mobile_phone_e164: '720-555-1212' }), /\+1XXXXXXXXXX/);
  assert.throws(() => validateTransferDestinations({ member, assignment: { ...assignment, backup_transfer_phone_e164: member.mobile_phone_e164 } }, phone), /separate from the salesperson mobile/i);
});

test('readiness requires all rep identities and both reusable GHL routing values', () => {
  assert.deepEqual(readinessFor({ member, assignment, config, phone }), { ready: true, missing: [] });
  const missing = readinessFor({ member: { ...member, slack_user_id: null }, assignment, config, phone: { ...phone, ghl_user_custom_value_id: null } });
  assert.equal(missing.ready, false);
  assert.ok(missing.missing.includes('Slack member'));
  assert.ok(missing.missing.includes('GHL user routing value'));
  const notifications = readinessFor({ member, assignment, config: { ...config, notify_sms: false }, phone });
  assert.ok(notifications.missing.includes('Slack, GHL text, and Workspace email'));
});

test('generated Grok prompt uses the rep name and never exposes delivery mechanics', () => {
  const prompt = buildManagedVoicePrompt(member, assignment, config);
  assert.match(prompt, /Would you like me to send that message to Michael Afesi\?/);
  assert.match(prompt, /Never say tool or function names/);
  assert.match(prompt, /Essential and Pro memberships/);
});

test('apply updates all GHL routes before one v2 database transaction', async () => {
  const db = makeDb();
  const provider = providerFake();
  const result = await applySalesTeamMember({ db, memberId: member.id, actorId: '99999999-9999-4999-8999-999999999999', env: applyEnv, fetchImpl: provider.fetchImpl });
  assert.equal(result.item.member.status, 'active');
  assert.equal(provider.state.user.phone, member.mobile_phone_e164);
  assert.equal(provider.state.values['mobile-value-1'].value, member.mobile_phone_e164);
  assert.equal(provider.state.values['user-value-1'].value, member.ghl_user_id);
  assert.equal(db.calls[0].name, 'apply_sales_team_configuration_v2');
  assert.equal(db.calls[0].args.p_replace_team_member_id, null);
  assert.equal(db.calls[0].args.p_handoff_token_sha256, 'a'.repeat(64));
});

test('occupied line requires the exact incumbent before any provider write', async () => {
  const incumbent = { ...member, id: '22000000-0000-4000-8000-000000000099', sales_rep_user_id: '11111111-1111-4111-8111-111111111199', display_name: 'Former Rep', workspace_email: 'former@alphasourceai.com', mobile_phone_e164: '+17205559999', ghl_user_id: 'old-ghl-user', slack_user_id: 'U999999999' };
  const db = makeDb({ incumbent });
  let providerCalls = 0;
  await assert.rejects(applySalesTeamMember({ db, memberId: member.id, env: applyEnv, fetchImpl: async () => { providerCalls += 1; throw new Error('must not call'); } }), (error) => error.code === 'sales_phone_replacement_required' && error.fields.replace_team_member_id === incumbent.id);
  assert.equal(providerCalls, 0);
  assert.equal(db.calls.length, 0);
});

test('exact incumbent confirmation performs atomic replacement and retains old account record', async () => {
  const incumbent = { ...member, id: '22000000-0000-4000-8000-000000000099', sales_rep_user_id: '11111111-1111-4111-8111-111111111199', display_name: 'Former Rep', workspace_email: 'former@alphasourceai.com', mobile_phone_e164: '+17205559999', ghl_user_id: 'old-ghl-user', slack_user_id: 'U999999999' };
  const db = makeDb({ incumbent });
  const provider = providerFake();
  await applySalesTeamMember({ db, memberId: member.id, replaceTeamMemberId: incumbent.id, env: applyEnv, fetchImpl: provider.fetchImpl });
  assert.equal(db.calls[0].args.p_replace_team_member_id, incumbent.id);
  assert.equal(db.tables.sales_team_members.find((row) => row.id === incumbent.id).status, 'inactive');
  assert.ok(db.tables.sales_team_members.find((row) => row.id === incumbent.id));
});

test('database rejection restores the prior GHL route and user phone', async () => {
  const db = makeDb({ applyError: { message: 'sales_team_draft_stale' } });
  const provider = providerFake();
  await assert.rejects(applySalesTeamMember({ db, memberId: member.id, env: applyEnv, fetchImpl: provider.fetchImpl }), (error) => error.code === 'sales_team_draft_stale');
  assert.equal(provider.state.user.phone, '+13035550000');
  assert.equal(provider.state.values['mobile-value-1'].value, '+13035550001');
  assert.equal(provider.state.values['user-value-1'].value, 'old-user');
  assert.equal(db.tables.sales_team_members[0].status, 'draft');
});

test('legacy notification-off drafts are rejected before any provider write', async () => {
  const db = makeDb();
  db.tables.sales_team_config_drafts[0].payload.config.notify_sms = false;
  let providerCalls = 0;
  await assert.rejects(
    applySalesTeamMember({ db, memberId: member.id, env: applyEnv, fetchImpl: async () => { providerCalls += 1; throw new Error('must not call'); } }),
    (error) => error.status === 409 && error.code === 'sales_notification_channels_required'
  );
  assert.equal(providerCalls, 0);
  assert.equal(db.calls.length, 0);
});

test('transaction notification guard maps to a recoverable conflict after restoring GHL', async () => {
  const db = makeDb({ applyError: { message: 'sales_notification_channels_required' } });
  const provider = providerFake();
  await assert.rejects(
    applySalesTeamMember({ db, memberId: member.id, env: applyEnv, fetchImpl: provider.fetchImpl }),
    (error) => error.status === 409 && error.code === 'sales_notification_channels_required'
  );
  assert.equal(provider.state.user.phone, '+13035550000');
  assert.equal(provider.state.values['mobile-value-1'].value, '+13035550001');
  assert.equal(provider.state.values['user-value-1'].value, 'old-user');
});

test('a concurrent database winner is reconciled into GHL instead of being overwritten by stale rollback', async () => {
  const winner = { ...member, id: '22000000-0000-4000-8000-000000000098', sales_rep_user_id: '11111111-1111-4111-8111-111111111198', display_name: 'Winning Rep', workspace_email: 'winner@alphasourceai.com', mobile_phone_e164: '+17205559898', ghl_user_id: 'ghl-user-winner', slack_user_id: 'U989898989' };
  const db = makeDb({ applyError: { code: '23505', message: 'duplicate active line' }, concurrentWinner: winner });
  const provider = providerFake();
  await assert.rejects(applySalesTeamMember({ db, memberId: member.id, env: applyEnv, fetchImpl: provider.fetchImpl }), (error) => error.code === 'sales_team_assignment_conflict');
  assert.equal(provider.state.user.id, winner.ghl_user_id);
  assert.equal(provider.state.user.phone, winner.mobile_phone_e164);
  assert.equal(provider.state.values['mobile-value-1'].value, winner.mobile_phone_e164);
  assert.equal(provider.state.values['user-value-1'].value, winner.ghl_user_id);
  assert.ok(provider.state.writes.some((write) => write.type === 'user' && write.userId === member.ghl_user_id && write.phone === '+13035550000'));
});

test('line setup returns to pending when either managed GHL routing value changes', async () => {
  const db = makeDb();
  const pending = await saveSalesLineSetup({ db, phoneId: phone.id, body: { ...phone, ghl_user_custom_value_id: '', ghl_setup_status: 'verified' } });
  assert.equal(pending.ghl_setup_status, 'pending');
  assert.equal(readinessFor({ member, assignment, config, phone: pending }).ready, false);
  db.tables.sales_phone_numbers[0] = { ...phone };
  const saved = await saveSalesLineSetup({ db, phoneId: phone.id, body: { ...phone, ghl_setup_status: 'verified', xai_setup_status: 'verified' } });
  assert.equal(saved.ghl_setup_status, 'verified');
  assert.equal(saved.ghl_user_custom_value_id, 'user-value-1');
});

test('deactivation clears the managed GHL recipient and keeps the provider account intact', async () => {
  const db = makeDb();
  const provider = providerFake();
  await applySalesTeamMember({ db, memberId: member.id, env: applyEnv, fetchImpl: provider.fetchImpl });
  const result = await deactivateSalesTeamMember({ db, memberId: member.id, env: applyEnv, fetchImpl: provider.fetchImpl });
  assert.equal(result.member.status, 'inactive');
  assert.equal(provider.state.values['mobile-value-1'].value, '');
  assert.equal(provider.state.values['user-value-1'].value, '');
  assert.equal(provider.state.user.active, true);
});

test('line token rotation stores only the digest and returns the new bearer once', async () => {
  const db = makeDb();
  const result = await rotateSalesVoiceToken({ db, memberId: member.id, phoneId: phone.id });
  assert.match(result.token, /^[A-Za-z0-9_-]{48}$/);
  assert.equal(db.tables.sales_phone_numbers[0].handoff_token_sha256, crypto.createHash('sha256').update(result.token).digest('hex'));
  assert.equal(db.tables.sales_phone_numbers[0].xai_setup_status, 'pending');
  assert.equal(JSON.stringify(db.tables).includes(result.token), false);
});
