'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  applySalesTeamMember,
  buildManagedVoicePrompt,
  deactivateSalesTeamMember,
  normalizeDraft,
  readinessFor,
  rotateSalesVoiceToken,
  saveSalesTeamMember,
  validateTransferDestinations,
} = require('../src/lib/adminSalesTeamService');

class FakeQuery {
  constructor(db, table) { this.db = db; this.table = table; this.filters = []; this.orderField = ''; this.ascending = false; this.limitCount = null; }
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

function makeControlPlaneDb() {
  const draftPayload = { member: { ...member }, assignment: { ...assignment }, config: { ...config } };
  const tables = {
    sales_team_members: [{ ...member, created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T00:00:00Z' }],
    sales_phone_numbers: [{ id: assignment.phone_number_id, e164: '+17207904187', provider: 'ghl', a2p_status: 'verified', active: true }],
    sales_phone_assignments: [{ ...assignment, team_member_id: member.id, status: 'draft', handoff_token_rotated_at: null, created_at: '2026-09-21T00:00:00Z' }],
    sales_voice_configs: [],
    sales_integration_sync_jobs: [],
    sales_team_config_drafts: [{ team_member_id: member.id, payload: draftPayload, generated_prompt: buildManagedVoicePrompt(member, assignment, config), prompt_checksum: 'a'.repeat(64), updated_at: '2026-09-21T00:00:00Z' }],
  };
  const calls = [];
  return {
    tables,
    calls,
    from(table) { return new FakeQuery(this, table); },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'save_sales_team_draft') {
        if (args.p_create) {
          tables.sales_team_members.push({ id: args.p_member_id, ...args.p_member, status: 'draft', created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T00:00:00Z' });
        }
        tables.sales_team_config_drafts = tables.sales_team_config_drafts.filter((item) => item.team_member_id !== args.p_member_id);
        tables.sales_team_config_drafts.push({ team_member_id: args.p_member_id, payload: args.p_payload, generated_prompt: args.p_generated_prompt, prompt_checksum: args.p_prompt_checksum, updated_at: '2026-09-21T00:00:00Z' });
      }
      if (name === 'apply_sales_team_configuration') {
        tables.sales_team_members[0].status = 'active';
        tables.sales_phone_assignments[0].status = 'active';
        tables.sales_phone_assignments[0].handoff_token_rotated_at = '2026-09-21T01:00:00Z';
        tables.sales_team_config_drafts = [];
      }
      if (name === 'deactivate_sales_team_member') {
        tables.sales_team_members[0].status = 'inactive';
        tables.sales_team_members[0].inactive_at = '2026-09-21T02:00:00Z';
        tables.sales_phone_assignments[0].status = 'inactive';
        tables.sales_team_config_drafts = [];
      }
      if (name === 'rotate_sales_voice_handoff_token') {
        tables.sales_phone_assignments[0].handoff_token_rotated_at = '2026-09-21T03:00:00Z';
      }
      return { data: null, error: null };
    },
  };
}

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
  phone_number_id: '21000000-0000-4000-8000-000000000001',
  xai_agent_id: 'agent_1LDTasuwSoOhfbsZ',
  xai_phone_number_e164: '+17205550001',
  ghl_location_id: 'location-1',
  ghl_notification_workflow_id: 'workflow-1',
  ring_seconds: 20,
  call_connect_required: true,
  transfer_enabled: true,
  backup_transfer_phone_e164: '+17205550002',
};
const config = {
  voice_id: 'eve',
  greeting_override: null,
  approved_context: 'alphaScreen offers Essential and Pro memberships.',
  timezone: 'America/Denver',
  business_hours: { summary: 'Monday-Friday' },
  answer_approved_faqs: true,
  schedule_demos: true,
  notify_slack: true,
  notify_sms: true,
  notify_email: true,
};

test('sales team route is mounted behind authentication and global-admin authorization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /adminRouter\.use\('\/sales-team', requireAuth, requireAdmin, createAdminSalesTeamRouter\(\{ db: supabaseAdmin \}\)\)/);
});

test('sales team migration is service-role only and preserves assignment history', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260921154709_sales_team_control_plane.sql'), 'utf8').toLowerCase();
  for (const table of ['sales_team_members', 'sales_phone_numbers', 'sales_phone_assignments', 'sales_voice_configs', 'sales_integration_sync_jobs', 'sales_team_config_drafts', 'sales_team_audit_events']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.match(sql, /on public\.sales_phone_assignments \(team_member_id\)[\s\S]*where status = 'active'/);
  assert.match(sql, /on public\.sales_phone_assignments \(phone_number_id\)[\s\S]*where status = 'active'/);
  assert.match(sql, /handoff_token_sha256 text/);
  assert.match(sql, /create or replace function public\.save_sales_team_draft/);
  assert.match(sql, /create or replace function public\.apply_sales_team_configuration/);
  assert.match(sql, /create or replace function public\.deactivate_sales_team_member/);
  assert.match(sql, /create or replace function public\.rotate_sales_voice_handoff_token/);
  assert.match(sql, /revoke all on function public\.apply_sales_team_configuration[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.save_sales_team_draft[\s\S]*to service_role/);
  assert.match(sql, /grant execute on function public\.apply_sales_team_configuration[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /on conflict \([^)]*\) do update set[\s\S]*(?:a2p_status|display_name|xai_agent_id)/);
  assert.doesNotMatch(sql, /grant [^;]* to (?:anon|authenticated)/);
});

test('draft normalization locks Call Connect and rejects unsafe routing', () => {
  const draft = normalizeDraft({ ...member, ...assignment, ...config });
  assert.equal(draft.assignment.call_connect_required, true);
  assert.equal(draft.assignment.ring_seconds, 20);
  assert.equal(draft.member.workspace_email, 'michael@alphasourceai.com');
  assert.throws(() => normalizeDraft({ ...member, ...assignment, ...config, mobile_phone_e164: '720-555-1212' }), /\+1XXXXXXXXXX/);
  assert.throws(() => normalizeDraft({ ...member, ...assignment, ...config, notify_slack: false, notify_sms: false, notify_email: false }), /at least one notification channel/i);
  assert.throws(() => normalizeDraft({ ...member, ...assignment, ...config, ring_seconds: 30 }), /between 10 and 25 seconds/i);
  assert.throws(() => validateTransferDestinations({ member, assignment: { ...assignment, backup_transfer_phone_e164: member.mobile_phone_e164 } }, { e164: '+17207904187' }), /separate from the salesperson mobile/i);
});

test('readiness requires separate fallback and transfer destinations', () => {
  const phone = { id: assignment.phone_number_id, e164: '+17207904187' };
  assert.deepEqual(readinessFor({ member, assignment, config, phone }), { ready: true, missing: [] });
  const sameTransfer = readinessFor({ member, assignment: { ...assignment, backup_transfer_phone_e164: member.mobile_phone_e164 }, config, phone });
  assert.equal(sameTransfer.ready, false);
  assert.ok(sameTransfer.missing.includes('Separate backup transfer number'));
});

test('generated Grok prompt includes approved scope and keeps fixed consent guardrails', () => {
  const prompt = buildManagedVoicePrompt(member, assignment, config);
  assert.match(prompt, /Would you like me to send that message to Michael Afesi\?/);
  assert.match(prompt, /Never say tool or function names/);
  assert.match(prompt, /answer alphaScreen questions only from the approved product context/i);
  assert.match(prompt, /schedule a demo/i);
  assert.match(prompt, /backup destination/i);
  assert.match(prompt, /Essential and Pro memberships/);
  assert.match(prompt, /Business hours: Monday-Friday\. Timezone: America\/Denver/);
  assert.ok(prompt.lastIndexOf('Never say tool or function names') > prompt.indexOf('Essential and Pro memberships'));
});

test('apply uses one atomic RPC and returns a new handoff token only once', async () => {
  const db = makeControlPlaneDb();
  const result = await applySalesTeamMember({
    db,
    memberId: member.id,
    actorId: '99999999-9999-4999-8999-999999999999',
    env: { SALES_VOICE_GHL_WEBHOOKS_JSON: JSON.stringify({ '+17207904187': 'https://example.leadconnectorhq.com/hooks/michael' }) },
  });
  assert.match(result.token, /^[A-Za-z0-9_-]{48}$/);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, 'apply_sales_team_configuration');
  assert.equal(db.calls[0].args.p_expected_draft_updated_at, '2026-09-21T00:00:00Z');
  assert.match(db.calls[0].args.p_handoff_token_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result.item).includes(db.calls[0].args.p_handoff_token_sha256), false);
});

test('apply blocks SMS until the fixed server-side GHL webhook mapping exists', async () => {
  const db = makeControlPlaneDb();
  await assert.rejects(
    applySalesTeamMember({ db, memberId: member.id, actorId: '99999999-9999-4999-8999-999999999999', env: {} }),
    /server-side GHL notification webhook/i,
  );
  assert.equal(db.calls.length, 0);
});

test('new salesperson and draft are saved in one atomic RPC', async () => {
  const db = makeControlPlaneDb();
  db.calls.length = 0;
  const result = await saveSalesTeamMember({
    db,
    actorId: '99999999-9999-4999-8999-999999999999',
    body: { ...member, ...assignment, ...config, display_name: 'New Salesperson' },
  });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, 'save_sales_team_draft');
  assert.equal(db.calls[0].args.p_create, true);
  assert.match(result.member.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.member.status, 'draft');
  assert.equal(result.pending_draft.payload.member.display_name, 'New Salesperson');
});

test('deactivate uses one atomic RPC and preserves the member record', async () => {
  const db = makeControlPlaneDb();
  db.tables.sales_team_members[0].status = 'active';
  db.tables.sales_phone_assignments[0].status = 'active';
  db.tables.sales_phone_assignments[0].handoff_token_rotated_at = '2026-09-21T01:00:00Z';
  const result = await deactivateSalesTeamMember({ db, memberId: member.id, actorId: '99999999-9999-4999-8999-999999999999' });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, 'deactivate_sales_team_member');
  assert.equal(result.member.status, 'inactive');
});

test('token rotation updates the active assignment and audit in one RPC', async () => {
  const db = makeControlPlaneDb();
  db.tables.sales_team_members[0].status = 'active';
  db.tables.sales_phone_assignments[0].status = 'active';
  db.tables.sales_phone_assignments[0].handoff_token_rotated_at = '2026-09-21T01:00:00Z';
  const result = await rotateSalesVoiceToken({ db, memberId: member.id, actorId: '99999999-9999-4999-8999-999999999999' });
  assert.match(result.token, /^[A-Za-z0-9_-]{48}$/);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, 'rotate_sales_voice_handoff_token');
  assert.match(db.calls[0].args.p_handoff_token_sha256, /^[a-f0-9]{64}$/);
});
