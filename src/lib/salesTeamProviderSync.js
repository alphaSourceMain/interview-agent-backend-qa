'use strict';

function clean(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

async function jsonRequest(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  return { ok: response.ok, status: response.status, body };
}

async function finish(db, memberId, provider, result) {
  const response = await db.rpc('finish_sales_provider_sync', {
    p_team_member_id: memberId,
    p_provider: provider,
    p_status: result.status,
    p_provider_reference: result.reference || null,
    p_error_code: result.errorCode || null,
    p_error_detail: result.errorDetail || null,
  });
  if (response.error) throw Object.assign(new Error('Provider sync status update failed'), { cause: response.error });
}

async function verifySlack(record, env, fetchImpl) {
  if (record.config?.notify_slack === false) return { status: 'not_applicable', reference: 'disabled' };
  if (env.SALES_TEAM_PROVIDER_SYNC_ENABLED !== 'true') return { status: 'action_required', errorCode: 'provider_sync_disabled', errorDetail: 'Provider synchronization is disabled.' };
  const token = clean(env.SLACK_SALES_WON_BOT_TOKEN, 500);
  const userId = clean(record.member?.slack_user_id, 24);
  if (!token || !userId) return { status: 'action_required', errorCode: 'slack_configuration_missing', errorDetail: 'Add a valid Slack member and configure the sales bot token.' };
  const result = await jsonRequest(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, fetchImpl);
  if (!result.ok || result.body?.ok !== true || result.body?.user?.id !== userId || result.body?.user?.deleted === true) {
    return { status: 'failed', errorCode: 'slack_member_verification_failed', errorDetail: 'Slack could not verify an active member with this ID.' };
  }
  return { status: 'synced', reference: userId };
}

async function setGhlMobile(record, mobile, env, fetchImpl) {
  const phone = record.phone || {};
  if (phone.ghl_setup_status !== 'verified') {
    return { status: 'action_required', errorCode: 'ghl_line_setup_unverified', errorDetail: 'Finish and verify the reusable GHL call and notification workflows for this line.' };
  }
  if (env.SALES_TEAM_PROVIDER_SYNC_ENABLED !== 'true') return { status: 'action_required', errorCode: 'provider_sync_disabled', errorDetail: 'Provider synchronization is disabled.' };
  const token = clean(env.GHL_PRIVATE_INTEGRATION_TOKEN, 1000);
  const locationId = clean(phone.ghl_location_id, 160);
  const valueId = clean(phone.ghl_mobile_custom_value_id, 160);
  const valueName = clean(phone.ghl_mobile_custom_value_name, 120);
  if (!token || !locationId || !valueId || !valueName || (mobile !== '' && !/^\+1[2-9]\d{9}$/.test(mobile))) {
    return { status: 'action_required', errorCode: 'ghl_sync_configuration_missing', errorDetail: 'The GHL private integration or managed mobile routing value is not configured.' };
  }
  const result = await jsonRequest(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(locationId)}/customValues/${encodeURIComponent(valueId)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: 'v3',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ name: valueName, value: mobile }),
  }, fetchImpl);
  if (!result.ok || result.body?.customValue?.id !== valueId || result.body?.customValue?.name !== valueName || result.body?.customValue?.value !== mobile) {
    return { status: 'failed', errorCode: `ghl_mobile_sync_${result.status || 'failed'}`, errorDetail: 'GHL did not confirm the representative mobile routing value.' };
  }
  return { status: 'synced', reference: valueId };
}

async function syncGhl(record, env, fetchImpl) {
  return setGhlMobile(record, clean(record.member?.mobile_phone_e164, 16), env, fetchImpl);
}

async function verifyXai(record) {
  const phone = record.phone || {};
  if (phone.xai_setup_status !== 'verified' || !phone.xai_agent_id || !phone.xai_phone_number_e164 || !phone.handoff_token_rotated_at || !phone.xai_verified_at || !phone.xai_verification_reference) {
    return { status: 'action_required', errorCode: 'xai_line_setup_unverified', errorDetail: 'Finish and verify the reusable Grok agent, number, context tool, and message tool for this line.' };
  }
  return { status: 'synced', reference: clean(phone.xai_agent_id, 160) };
}

async function checkSalesTeamProviderReadiness({ record, env = process.env, fetchImpl = global.fetch }) {
  const results = {};
  const tasks = [
    ['slack', () => verifySlack(record, env, fetchImpl)],
    ['xai', () => verifyXai(record)],
  ];
  for (const [provider, run] of tasks) {
    try { results[provider] = await run(); }
    catch { results[provider] = { status: 'failed', errorCode: `${provider}_sync_unavailable`, errorDetail: `${provider === 'xai' ? 'Grok Voice' : provider.toUpperCase()} verification is temporarily unavailable.` }; }
  }
  return results;
}

async function checkSalesTeamProviders({ record, env = process.env, fetchImpl = global.fetch }) {
  const results = await checkSalesTeamProviderReadiness({ record, env, fetchImpl });
  try { results.ghl = await syncGhl(record, env, fetchImpl); }
  catch { results.ghl = { status: 'failed', errorCode: 'ghl_sync_unavailable', errorDetail: 'GHL verification is temporarily unavailable.' }; }
  return results;
}

function providersReady(results) {
  return Object.values(results || {}).every((result) => ['synced', 'not_applicable'].includes(result?.status));
}

async function recordProviderResults(db, memberId, results) {
  for (const [provider, result] of Object.entries(results)) await finish(db, memberId, provider, result);
}

async function syncSalesTeamProviders({ db, record, env = process.env, fetchImpl = global.fetch }) {
  const results = await checkSalesTeamProviders({ record, env, fetchImpl });
  await recordProviderResults(db, record.member.id, results);
  return results;
}

module.exports = { checkSalesTeamProviderReadiness, checkSalesTeamProviders, providersReady, recordProviderResults, setGhlMobile, syncSalesTeamProviders, syncGhl, verifySlack, verifyXai };
