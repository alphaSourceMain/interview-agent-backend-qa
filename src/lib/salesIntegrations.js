'use strict';

const crypto = require('node:crypto');
const { supabaseAdmin } = require('./supabaseClient');

const SALES_WON_EVENT_TYPE = 'sales_won';
const SLACK_INTEGRATION = 'slack';
const DEFAULT_BATCH_SIZE = 10;
const MAX_RECONCILE_ROWS = 100;
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 10800, 21600, 21600, 21600];

function cleanText(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapeSlackText(value, max = 500) {
  return cleanText(value, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function displayPlan(planKey) {
  const key = cleanText(planKey, 20).toLowerCase();
  if (key === 'basic') return 'Essential';
  if (key === 'pro') return 'Pro';
  return 'alphaScreen';
}

function displayCadence(cadence) {
  const value = cleanText(cadence, 20).toLowerCase();
  if (value === 'annual') return 'Annual';
  if (value === 'monthly') return 'Monthly';
  return 'Membership';
}

function formatUsd(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(safeInteger(cents) / 100);
}

function toSlackDate(isoValue) {
  const parsed = new Date(isoValue);
  if (!Number.isFinite(parsed.getTime())) return cleanText(isoValue, 80) || 'Payment received';
  const epoch = Math.floor(parsed.getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} at {time}|${parsed.toISOString()}>`;
}

function buildSalesWonPayload(intent, rep = null) {
  const companyName = cleanText(intent?.company_dba || intent?.company_legal_name, 160) || 'New alphaScreen client';
  const repName = cleanText(rep?.display_name || intent?.created_by_email, 120) || 'alphaSource sales team';
  return {
    schema_version: 1,
    purchase_intent_id: cleanText(intent?.id, 80),
    company_name: companyName,
    membership: displayPlan(intent?.selected_plan_key),
    billing_cadence: displayCadence(intent?.selected_billing_cadence),
    sales_representative: repName,
    platform_fee_cents: safeInteger(intent?.platform_fee_cents),
    discount_cents: safeInteger(intent?.promotion_discount_cents),
    initial_payment_cents: safeInteger(intent?.initial_payment_cents),
    activated_at: cleanText(intent?.activated_at, 80)
  };
}

function buildSlackSalesWonMessage(payload) {
  const membership = `${escapeSlackText(payload?.membership, 40)} · ${escapeSlackText(payload?.billing_cadence, 40)}`;
  const cadenceSuffix = cleanText(payload?.billing_cadence, 20).toLowerCase() === 'annual' ? 'year' : 'month';
  const text = `New alphaScreen membership activated: ${escapeSlackText(payload?.company_name, 160)} — ${escapeSlackText(payload?.membership, 40)} · ${escapeSlackText(payload?.billing_cadence, 40)}`;
  const fields = [
    { type: 'mrkdwn', text: `*Company*\n${escapeSlackText(payload?.company_name, 160)}` },
    { type: 'mrkdwn', text: `*Membership*\n${membership}` },
    { type: 'mrkdwn', text: `*Sales representative*\n${escapeSlackText(payload?.sales_representative, 120)}` },
    { type: 'mrkdwn', text: `*Initial payment*\n${formatUsd(payload?.initial_payment_cents)}` },
    { type: 'mrkdwn', text: `*Platform membership*\n${formatUsd(payload?.platform_fee_cents)} / ${cadenceSuffix}` },
    { type: 'mrkdwn', text: `*Discount applied*\n${formatUsd(payload?.discount_cents)}` }
  ];
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'New alphaScreen membership activated', emoji: true } },
      { type: 'section', fields },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Payment received ${toSlackDate(payload?.activated_at)} · Deal ${escapeSlackText(payload?.purchase_intent_id, 80)}`
        }]
      }
    ]
  };
}

function slackConfiguration(env = process.env) {
  return {
    botToken: cleanText(env.SLACK_SALES_WON_BOT_TOKEN, 500),
    channelId: cleanText(env.SLACK_SALES_WON_CHANNEL_ID, 120),
    configured: Boolean(cleanText(env.SLACK_SALES_WON_BOT_TOKEN, 500) && cleanText(env.SLACK_SALES_WON_CHANNEL_ID, 120))
  };
}

async function loadSalesWonIntent(db, purchaseIntentId) {
  const { data, error } = await db
    .from('public_purchase_intents')
    .select('id,status,channel,activated_at,client_id,company_legal_name,company_dba,selected_plan_key,selected_billing_cadence,created_by_user_id,created_by_email,platform_fee_cents,promotion_discount_cents,initial_payment_cents')
    .eq('id', purchaseIntentId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Sales-won intent lookup failed');
  return data || null;
}

async function loadSalesRep(db, userId) {
  if (!userId) return null;
  const { data, error } = await db
    .from('sales_reps')
    .select('user_id,display_name,email')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Sales representative lookup failed');
  return data || null;
}

async function clientIsActivated(db, clientId) {
  if (!clientId) return false;
  const { data, error } = await db
    .from('clients')
    .select('id,billing_status,subscription_status')
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Activated client lookup failed');
  const billingStatus = cleanText(data?.billing_status, 40).toLowerCase();
  const subscriptionStatus = cleanText(data?.subscription_status, 40).toLowerCase();
  return Boolean(data?.id && billingStatus === 'active' && (!subscriptionStatus || ['active', 'trialing'].includes(subscriptionStatus)));
}

async function enqueueSalesWonDelivery(purchaseIntentId, options = {}) {
  const db = options.db || supabaseAdmin;
  const intent = options.intent || await loadSalesWonIntent(db, purchaseIntentId);
  if (!intent?.id) return { enqueued: false, status: 'intent_not_found' };
  if (
    cleanText(intent.channel, 40).toLowerCase() !== 'sales_assisted' ||
    cleanText(intent.status, 40).toLowerCase() !== 'completed' ||
    !cleanText(intent.activated_at, 80)
  ) {
    return { enqueued: false, status: 'not_eligible' };
  }
  if (!(await clientIsActivated(db, intent.client_id))) {
    return { enqueued: false, status: 'activation_pending' };
  }

  const rep = await loadSalesRep(db, intent.created_by_user_id);
  const eventKey = `sales_won:${intent.id}`;
  const row = {
    integration: SLACK_INTEGRATION,
    event_type: SALES_WON_EVENT_TYPE,
    event_key: eventKey,
    purchase_intent_id: intent.id,
    payload: buildSalesWonPayload(intent, rep),
    status: 'pending',
    next_attempt_at: new Date().toISOString()
  };
  const { data, error } = await db
    .from('sales_integration_deliveries')
    .insert(row)
    .select('id,status')
    .maybeSingle();
  let status = data?.status || 'pending';
  let enqueued = true;
  if (error) {
    const duplicate = cleanText(error.code, 40) === '23505' || /duplicate/i.test(cleanText(error.message, 500));
    if (!duplicate) throw new Error(error.message || 'Sales-won delivery enqueue failed');
    status = 'already_enqueued';
    enqueued = false;
  }
  const { error: markerError } = await db
    .from('public_purchase_intents')
    .update({ sales_won_enqueued_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', intent.id)
    .is('sales_won_enqueued_at', null);
  if (markerError && options.logger) {
    options.logger.warn?.('[sales-integrations] sales_won_marker_failed', {
      purchase_intent_id: intent.id,
      error: cleanText(markerError.message, 300)
    });
  }
  if (error) {
    return { enqueued, status };
  }
  return { enqueued, status, delivery_id: data?.id || null };
}

async function reconcileSalesWonDeliveries(options = {}) {
  const db = options.db || supabaseAdmin;
  const limit = Math.max(1, Math.min(Number(options.limit || MAX_RECONCILE_ROWS), MAX_RECONCILE_ROWS));
  const { data, error } = await db
    .from('public_purchase_intents')
    .select('id')
    .eq('channel', 'sales_assisted')
    .eq('status', 'completed')
    .not('activated_at', 'is', null)
    .is('sales_won_enqueued_at', null)
    .order('activated_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message || 'Sales-won reconciliation lookup failed');

  const summary = { scanned: 0, enqueued: 0, existing: 0, pending_activation: 0, failed: 0 };
  for (const row of Array.isArray(data) ? data : []) {
    summary.scanned += 1;
    try {
      const result = await enqueueSalesWonDelivery(row.id, { db, logger: options.logger });
      if (result.enqueued) summary.enqueued += 1;
      else if (result.status === 'already_enqueued') summary.existing += 1;
      else if (result.status === 'activation_pending') summary.pending_activation += 1;
    } catch (error) {
      summary.failed += 1;
      options.logger?.warn?.('[sales-integrations] reconciliation_enqueue_failed', {
        purchase_intent_id: row.id,
        error: cleanText(error?.message, 300)
      });
    }
  }
  return summary;
}

async function postSlackMessage(delivery, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || global.fetch;
  const config = slackConfiguration(env);
  if (!config.configured) {
    const error = new Error('Slack sales-won delivery is not configured.');
    error.code = 'slack_not_configured';
    error.retryable = true;
    throw error;
  }
  if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation unavailable.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 10000));
  let response;
  try {
    response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        channel: config.channelId,
        client_msg_id: delivery.id,
        ...buildSlackSalesWonMessage(delivery.payload)
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    body = {};
  }
  if (!response.ok || body.ok !== true) {
    const error = new Error(cleanText(body.error, 160) || `slack_http_${response.status}`);
    error.code = cleanText(body.error, 160) || `slack_http_${response.status}`;
    error.retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
    error.retryable = true;
    throw error;
  }
  return {
    external_message_id: cleanText(body.ts, 120) || null,
    external_channel_id: cleanText(body.channel, 120) || config.channelId
  };
}

function retryDelaySeconds(attemptCount, error) {
  const retryAfter = Number(error?.retryAfterSeconds || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 21600);
  const index = Math.max(0, Math.min(safeInteger(attemptCount) - 1, RETRY_DELAYS_SECONDS.length - 1));
  return RETRY_DELAYS_SECONDS[index];
}

async function updateClaimedDelivery(db, delivery, payload) {
  const { error } = await db
    .from('sales_integration_deliveries')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', delivery.id)
    .eq('lock_token', delivery.lock_token);
  if (error) throw new Error(error.message || 'Sales integration delivery update failed');
}

async function processSalesIntegrationDeliveries(options = {}) {
  const db = options.db || supabaseAdmin;
  const logger = options.logger || console;
  const env = options.env || process.env;
  const config = slackConfiguration(env);
  const reconciliation = await reconcileSalesWonDeliveries({ db, logger, limit: options.reconcileLimit });
  if (!config.configured) {
    return { ok: true, configured: false, reconciliation, claimed: 0, delivered: 0, retrying: 0, failed: 0 };
  }

  const batchSize = Math.max(1, Math.min(Number(options.limit || DEFAULT_BATCH_SIZE), 50));
  const lockToken = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const { data, error } = await db.rpc('claim_sales_integration_deliveries', {
    p_limit: batchSize,
    p_lock_token: lockToken,
    p_now: nowIso,
    p_integration: SLACK_INTEGRATION
  });
  if (error) throw new Error(error.message || 'Sales integration deliveries could not be claimed');

  const summary = {
    ok: true,
    configured: true,
    reconciliation,
    claimed: Array.isArray(data) ? data.length : 0,
    delivered: 0,
    retrying: 0,
    failed: 0
  };
  for (const delivery of Array.isArray(data) ? data : []) {
    try {
      const result = await postSlackMessage(delivery, { env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
      await updateClaimedDelivery(db, delivery, {
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        next_attempt_at: new Date().toISOString(),
        locked_at: null,
        lock_token: null,
        last_error: null,
        ...result
      });
      summary.delivered += 1;
    } catch (deliveryError) {
      const exhausted = safeInteger(delivery.attempt_count) >= safeInteger(delivery.max_attempts);
      const retryable = deliveryError?.retryable !== false && !exhausted;
      const delaySeconds = retryDelaySeconds(delivery.attempt_count, deliveryError);
      await updateClaimedDelivery(db, delivery, {
        status: retryable ? 'retry' : 'failed',
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        locked_at: null,
        lock_token: null,
        last_error: cleanText(deliveryError?.code || deliveryError?.message || 'delivery_failed', 500)
      });
      if (retryable) summary.retrying += 1;
      else summary.failed += 1;
      logger.warn?.('[sales-integrations] slack_delivery_failed', {
        delivery_id: delivery.id,
        attempt_count: delivery.attempt_count,
        retryable,
        error: cleanText(deliveryError?.code || deliveryError?.message, 160)
      });
    }
  }
  return summary;
}

module.exports = {
  SALES_WON_EVENT_TYPE,
  buildSalesWonPayload,
  buildSlackSalesWonMessage,
  enqueueSalesWonDelivery,
  reconcileSalesWonDeliveries,
  postSlackMessage,
  processSalesIntegrationDeliveries,
  slackConfiguration,
  retryDelaySeconds
};
