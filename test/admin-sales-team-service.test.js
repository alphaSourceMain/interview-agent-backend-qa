'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildManagedVoicePrompt,
  normalizeDraft,
  readinessFor,
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
  for (const table of ['sales_team_members', 'sales_phone_numbers', 'sales_phone_assignments', 'sales_voice_configs', 'sales_integration_sync_jobs', 'sales_team_audit_events']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.match(sql, /on public\.sales_phone_assignments \(team_member_id\)[\s\S]*where status = 'active'/);
  assert.match(sql, /on public\.sales_phone_assignments \(phone_number_id\)[\s\S]*where status = 'active'/);
  assert.match(sql, /handoff_token_sha256 text/);
  assert.doesNotMatch(sql, /grant [^;]* to (?:anon|authenticated)/);
});

test('draft normalization locks Call Connect and rejects unsafe routing', () => {
  const draft = normalizeDraft({ ...member, ...assignment, ...config });
  assert.equal(draft.assignment.call_connect_required, true);
  assert.equal(draft.assignment.ring_seconds, 20);
  assert.equal(draft.member.workspace_email, 'michael@alphasourceai.com');
  assert.throws(() => normalizeDraft({ ...member, ...assignment, ...config, mobile_phone_e164: '720-555-1212' }), /\+1XXXXXXXXXX/);
  assert.throws(() => normalizeDraft({ ...member, ...assignment, ...config, notify_slack: false, notify_sms: false, notify_email: false }), /at least one notification channel/i);
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
});
