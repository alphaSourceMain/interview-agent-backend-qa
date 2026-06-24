'use strict';

const { buildAlphaScreenPackageSnapshot, normalizeAlphaScreenPlanKey, normalizeBillingInterval } = require('./alphaScreenPackages');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const READ_LIMIT = 1000;
const VALID_STATUS_KEYS = new Set([
  'signup_started',
  'agreement_pending',
  'signed_unpaid',
  'checkout_pending',
  'setup_pending',
  'completed',
  'failed_payment',
  'canceled',
  'unknown'
]);
const STATUS_LABELS = Object.freeze({
  signup_started: 'Signup Started',
  agreement_pending: 'Agreement Pending',
  signed_unpaid: 'Signed / Unpaid',
  checkout_pending: 'Checkout Pending',
  setup_pending: 'Setup Pending',
  completed: 'Completed',
  failed_payment: 'Failed Payment',
  canceled: 'Canceled',
  unknown: 'Unknown'
});
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const FAILED_SUBSCRIPTION_STATUSES = new Set(['past_due', 'unpaid', 'incomplete_expired']);
const INTENT_SELECT_COLUMNS = [
  'id',
  'status',
  'selected_plan_key',
  'selected_billing_cadence',
  'package_snapshot',
  'company_legal_name',
  'company_dba',
  'buyer_first_name',
  'buyer_last_name',
  'buyer_email',
  'buyer_phone',
  'buyer_title',
  'source_path',
  'agreement_id',
  'stripe_checkout_session_id',
  'client_id',
  'expires_at',
  'created_at',
  'updated_at'
].join(',');
const AGREEMENT_SELECT_COLUMNS = [
  'id',
  'client_id',
  'status',
  'is_current',
  'checkout_status',
  'checkout_session_id',
  'checkout_created_at',
  'checkout_paid_at',
  'client_legal_name',
  'dba_trade_name',
  'primary_admin_name',
  'admin_email',
  'membership_tier',
  'billing_option',
  'sent_at',
  'opened_at',
  'signed_at',
  'voided_at',
  'created_at',
  'updated_at'
].join(',');
const CLIENT_SELECT_COLUMNS = [
  'id',
  'name',
  'email',
  'client_admin_name',
  'plan_tier',
  'billing_status',
  'billing_interval',
  'stripe_customer_id',
  'stripe_subscription_id',
  'subscription_status',
  'current_term_end',
  'created_at'
].join(',');
const MEMBER_SELECT_COLUMNS = 'client_id,user_id,email,name,role,created_at';
const EMAIL_SELECT_COLUMNS = 'id,email,email_category,category,status,event_type,event_at,created_at,is_problem,custom_args';

function trimText(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function lowerText(value, max = 300) {
  return trimText(value, max).toLowerCase();
}

function titleCase(value) {
  const raw = trimText(value, 80);
  if (!raw) return '';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseDateBoundary(value, endOfDay = false) {
  const raw = trimText(value, 40);
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly && endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isoDateOnly(value) {
  const parsed = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function cleanIdList(values) {
  return Array.from(new Set((values || []).map((value) => trimText(value, 120)).filter(Boolean)));
}

function cleanEmailList(values) {
  return Array.from(new Set((values || []).map((value) => lowerText(value, 254)).filter(Boolean)));
}

function parseDateRange(query = {}, now = new Date()) {
  const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const days = parsePositiveInt(query.days || query.date_range, DEFAULT_DAYS, MAX_DAYS);
  const defaultFrom = new Date(safeNow.getTime() - days * 24 * 60 * 60 * 1000);
  const from = parseDateBoundary(query.date_from, false) || defaultFrom;
  const to = parseDateBoundary(query.date_to, true) || safeNow;
  return {
    days,
    from,
    to,
    date_range: trimText(query.date_from) || trimText(query.date_to) ? 'custom' : `${days}d`,
    date_from: from.toISOString(),
    date_to: to.toISOString(),
    date_from_display: isoDateOnly(from),
    date_to_display: isoDateOnly(to)
  };
}

function parseFilters(query = {}, now = new Date()) {
  const dateRange = parseDateRange(query, now);
  const status = lowerText(query.status || query.state, 40);
  const membership = lowerText(query.membership || query.plan || query.selected_plan_key, 40);
  const cadence = lowerText(query.cadence || query.billing_cadence || query.selected_billing_cadence, 40);
  return {
    ...dateRange,
    status: VALID_STATUS_KEYS.has(status) ? status : '',
    membership: ['basic', 'pro', 'enterprise'].includes(membership) ? membership : '',
    billing_cadence: ['monthly', 'annual'].includes(cadence) ? cadence : '',
    search: lowerText(query.search || query.q, 160),
    page: parsePositiveInt(query.page, 1, 10000),
    limit: parsePositiveInt(query.limit, DEFAULT_LIMIT, MAX_LIMIT)
  };
}

function applyDateRange(query, column, filters) {
  return query
    .gte(column, filters.date_from)
    .lte(column, filters.date_to);
}

async function runQuery(builder, code, message = 'Could not load public purchase records.') {
  const { data, error } = await builder;
  if (error) {
    const serviceError = new Error(message);
    serviceError.code = code;
    serviceError.status = 503;
    serviceError.detail = error.message || null;
    throw serviceError;
  }
  return Array.isArray(data) ? data : [];
}

async function readIntentRows(db, filters) {
  let query = db
    .from('public_purchase_intents')
    .select(INTENT_SELECT_COLUMNS);
  query = applyDateRange(query, 'created_at', filters).order('created_at', { ascending: false }).limit(READ_LIMIT);
  if (filters.membership && filters.membership !== 'enterprise') query = query.eq('selected_plan_key', filters.membership);
  if (filters.billing_cadence) query = query.eq('selected_billing_cadence', filters.billing_cadence);
  return runQuery(query, 'public_purchase_intents_read_failed');
}

async function readAgreementRows(db, agreementIds) {
  const ids = cleanIdList(agreementIds);
  if (!ids.length) return [];
  let query = db
    .from('membership_agreements')
    .select(AGREEMENT_SELECT_COLUMNS)
    .in('id', ids);
  return runQuery(query, 'public_purchase_agreements_read_failed');
}

async function readClientRows(db, clientIds) {
  const ids = cleanIdList(clientIds);
  if (!ids.length) return [];
  let query = db
    .from('clients')
    .select(CLIENT_SELECT_COLUMNS)
    .in('id', ids);
  return runQuery(query, 'public_purchase_clients_read_failed');
}

async function readMemberRows(db, clientIds) {
  const ids = cleanIdList(clientIds);
  if (!ids.length) return [];
  let query = db
    .from('client_members')
    .select(MEMBER_SELECT_COLUMNS)
    .in('client_id', ids);
  return runQuery(query, 'public_purchase_members_read_failed');
}

async function readWelcomeEmailRows(db, emails, warnings = []) {
  const safeEmails = cleanEmailList(emails);
  if (!safeEmails.length) return [];
  let query = db
    .from('email_delivery_events')
    .select(EMAIL_SELECT_COLUMNS)
    .in('email', safeEmails)
    .in('email_category', ['public_purchase_welcome'])
    .order('created_at', { ascending: false })
    .limit(READ_LIMIT);
  try {
    return await runQuery(query, 'public_purchase_email_events_read_failed');
  } catch (error) {
    warnings.push({
      source: 'email_delivery_events',
      code: trimText(error?.code, 80) || 'public_purchase_email_events_read_failed',
      detail: 'Email delivery summaries are unavailable for this response.'
    });
    return [];
  }
}

function mapById(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = trimText(row?.id, 120);
    if (id) map.set(id, row);
  }
  return map;
}

function buildMemberMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const clientId = trimText(row?.client_id, 120);
    if (!clientId) continue;
    const existing = map.get(clientId) || [];
    existing.push(row);
    map.set(clientId, existing);
  }
  return map;
}

function emailEventTime(row) {
  return trimText(row?.event_at || row?.created_at, 40);
}

function buildEmailSummaryMap(rows) {
  const byIntentId = new Map();
  const byEmail = new Map();
  for (const row of rows || []) {
    const customArgs = row?.custom_args && typeof row.custom_args === 'object' ? row.custom_args : {};
    const intentId = trimText(customArgs.purchase_intent_id, 120);
    const email = lowerText(row?.email, 254);
    const summary = {
      category: trimText(row?.email_category || row?.category, 80) || 'public_purchase_welcome',
      status: trimText(row?.status || row?.event_type, 80) || 'unknown',
      is_problem: row?.is_problem === true,
      last_event_at: emailEventTime(row) || null
    };
    if (intentId) {
      const existing = byIntentId.get(intentId);
      if (!existing || String(summary.last_event_at || '') > String(existing.last_event_at || '')) byIntentId.set(intentId, summary);
    }
    if (email) {
      const existing = byEmail.get(email);
      if (!existing || String(summary.last_event_at || '') > String(existing.last_event_at || '')) byEmail.set(email, summary);
    }
  }
  return { byIntentId, byEmail };
}

function chooseBuyerMember(members, buyerEmail) {
  const email = lowerText(buyerEmail, 254);
  const rows = Array.isArray(members) ? members : [];
  if (email) {
    const match = rows.find((row) => lowerText(row?.email, 254) === email);
    if (match) return match;
  }
  return rows.find((row) => trimText(row?.user_id, 120)) || rows[0] || null;
}

function resolvePackageSnapshot(intent) {
  const snapshot = intent?.package_snapshot && typeof intent.package_snapshot === 'object'
    ? intent.package_snapshot
    : {};
  const planKey = normalizeAlphaScreenPlanKey(snapshot.plan_key || intent?.selected_plan_key);
  const cadence = normalizeBillingInterval(snapshot.billing_cadence || snapshot.platform_fee_billing_cadence || intent?.selected_billing_cadence);
  const fallback = planKey && cadence ? buildAlphaScreenPackageSnapshot(planKey, cadence) : null;
  return { ...(fallback || {}), ...snapshot };
}

function buildMembershipSummary(intent) {
  const snapshot = resolvePackageSnapshot(intent);
  const planKey = trimText(snapshot.plan_key || intent?.selected_plan_key, 40).toLowerCase();
  const cadence = trimText(snapshot.billing_cadence || snapshot.platform_fee_billing_cadence || intent?.selected_billing_cadence, 40).toLowerCase();
  return {
    key: planKey || null,
    display_name: trimText(snapshot.display_name, 80) || titleCase(planKey) || null,
    billing_cadence: cadence || null,
    billing_cadence_display_name: trimText(snapshot.billing_cadence_display_name, 80) || titleCase(cadence) || null,
    platform_fee: Number.isFinite(Number(snapshot.platform_fee)) ? Number(snapshot.platform_fee) : null,
    platform_fee_cents: Number.isFinite(Number(snapshot.platform_fee_cents)) ? Number(snapshot.platform_fee_cents) : null,
    platform_monthly_fee: Number.isFinite(Number(snapshot.platform_monthly_fee)) ? Number(snapshot.platform_monthly_fee) : null,
    platform_annual_fee: Number.isFinite(Number(snapshot.platform_annual_fee)) ? Number(snapshot.platform_annual_fee) : null,
    per_role_fee: Number.isFinite(Number(snapshot.per_role_fee)) ? Number(snapshot.per_role_fee) : null,
    included_interviews: Number.isFinite(Number(snapshot.included_interviews || snapshot.included_interviews_per_role)) ? Number(snapshot.included_interviews || snapshot.included_interviews_per_role) : null,
    interview_duration_minutes: Number.isFinite(Number(snapshot.interview_duration_minutes || snapshot.max_interview_minutes)) ? Number(snapshot.interview_duration_minutes || snapshot.max_interview_minutes) : null,
    additional_interview_price: Number.isFinite(Number(snapshot.additional_interview_price || snapshot.additional_interview_fee || snapshot.overage_price)) ? Number(snapshot.additional_interview_price || snapshot.additional_interview_fee || snapshot.overage_price) : null
  };
}

function isActiveClient(client) {
  const billingStatus = lowerText(client?.billing_status, 80);
  const subscriptionStatus = lowerText(client?.subscription_status, 80);
  return billingStatus === 'active' && (!subscriptionStatus || LIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus));
}

function mapPublicPurchaseStatus({ intent, agreement, client, member } = {}) {
  const intentStatus = lowerText(intent?.status, 80);
  const agreementStatus = lowerText(agreement?.status, 80);
  const checkoutStatus = lowerText(agreement?.checkout_status, 80);
  const billingStatus = lowerText(client?.billing_status, 80);
  const subscriptionStatus = lowerText(client?.subscription_status, 80);
  const memberLinked = Boolean(trimText(member?.user_id, 120));

  let key = 'unknown';
  if (intentStatus === 'canceled' || intentStatus === 'expired' || agreementStatus === 'voided' || trimText(agreement?.voided_at, 40)) {
    key = 'canceled';
  } else if (FAILED_SUBSCRIPTION_STATUSES.has(subscriptionStatus) || billingStatus === 'past_due') {
    key = 'failed_payment';
  } else if (intentStatus === 'completed' || checkoutStatus === 'paid' || isActiveClient(client)) {
    key = isActiveClient(client) && memberLinked ? 'completed' : 'setup_pending';
  } else if (intentStatus === 'checkout_pending' || checkoutStatus === 'pending_payment') {
    key = 'checkout_pending';
  } else if (agreementStatus === 'signed') {
    key = 'signed_unpaid';
  } else if (intentStatus === 'agreement_pending' || agreementStatus === 'sent' || agreementStatus === 'draft') {
    key = 'agreement_pending';
  } else if (intentStatus === 'pending') {
    key = 'signup_started';
  }

  return {
    key,
    label: STATUS_LABELS[key] || STATUS_LABELS.unknown
  };
}

function matchesSearch(item, search) {
  const needle = lowerText(search, 160);
  if (!needle) return true;
  return [
    item?.company?.legal_name,
    item?.company?.dba,
    item?.buyer?.email,
    item?.buyer?.name,
    item?.agreement?.id,
    item?.payment?.stripe_checkout_session_id,
    item?.account_setup?.client_id
  ].some((value) => lowerText(value, 300).includes(needle));
}

function sanitizePurchaseItem({ intent, agreement, client, member, emailSummary }) {
  const buyerFirst = trimText(intent?.buyer_first_name, 80);
  const buyerLast = trimText(intent?.buyer_last_name, 80);
  const buyerName = [buyerFirst, buyerLast].filter(Boolean).join(' ');
  const membership = buildMembershipSummary(intent);
  const status = mapPublicPurchaseStatus({ intent, agreement, client, member });
  return {
    id: trimText(intent?.id, 120),
    purchase_intent_id: trimText(intent?.id, 120),
    status,
    company: {
      legal_name: trimText(intent?.company_legal_name || agreement?.client_legal_name || client?.name, 160) || null,
      dba: trimText(intent?.company_dba || agreement?.dba_trade_name, 160) || null
    },
    buyer: {
      first_name: buyerFirst || null,
      last_name: buyerLast || null,
      name: buyerName || trimText(agreement?.primary_admin_name || client?.client_admin_name, 160) || null,
      email: lowerText(intent?.buyer_email || agreement?.admin_email || client?.email, 254) || null,
      phone: trimText(intent?.buyer_phone, 40) || null,
      title: trimText(intent?.buyer_title, 120) || null
    },
    membership,
    source: {
      path: trimText(intent?.source_path, 300) || null
    },
    agreement: agreement ? {
      id: trimText(agreement.id, 120),
      status: trimText(agreement.status, 80) || null,
      is_current: agreement.is_current === true,
      checkout_status: trimText(agreement.checkout_status, 80) || null,
      checkout_session_id: trimText(agreement.checkout_session_id, 255) || null,
      sent_at: trimText(agreement.sent_at, 40) || null,
      opened_at: trimText(agreement.opened_at, 40) || null,
      signed_at: trimText(agreement.signed_at, 40) || null,
      voided_at: trimText(agreement.voided_at, 40) || null,
      created_at: trimText(agreement.created_at, 40) || null,
      updated_at: trimText(agreement.updated_at, 40) || null
    } : null,
    payment: {
      checkout_status: trimText(agreement?.checkout_status, 80) || null,
      checkout_created_at: trimText(agreement?.checkout_created_at, 40) || null,
      checkout_paid_at: trimText(agreement?.checkout_paid_at, 40) || null,
      stripe_checkout_session_id: trimText(intent?.stripe_checkout_session_id || agreement?.checkout_session_id, 255) || null,
      stripe_customer_id: trimText(client?.stripe_customer_id, 255) || null,
      stripe_subscription_id: trimText(client?.stripe_subscription_id, 255) || null,
      billing_status: trimText(client?.billing_status, 80) || null,
      subscription_status: trimText(client?.subscription_status, 80) || null,
      current_term_end: trimText(client?.current_term_end, 40) || null
    },
    account_setup: {
      client_id: trimText(intent?.client_id || agreement?.client_id || client?.id, 120) || null,
      client_name: trimText(client?.name, 160) || null,
      member_found: Boolean(member),
      member_user_linked: Boolean(trimText(member?.user_id, 120)),
      member_role: trimText(member?.role, 80) || null,
      member_created_at: trimText(member?.created_at, 40) || null
    },
    email_delivery: {
      welcome_email: emailSummary || null,
      setup_email: { status: 'not_tracked' }
    },
    expires_at: trimText(intent?.expires_at, 40) || null,
    created_at: trimText(intent?.created_at, 40) || null,
    updated_at: trimText(intent?.updated_at, 40) || null
  };
}

function buildSummary(items) {
  const counts = {
    total: items.length,
    started: 0,
    signup_started: 0,
    agreement_pending: 0,
    signed_unpaid: 0,
    checkout_pending: 0,
    setup_pending: 0,
    completed: 0,
    failed_payment: 0,
    canceled: 0,
    failed_canceled: 0,
    unknown: 0
  };
  for (const item of items) {
    const key = item?.status?.key || 'unknown';
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    else counts.unknown += 1;
  }
  counts.started = counts.signup_started;
  counts.failed_canceled = counts.failed_payment + counts.canceled;
  return counts;
}

function paginate(items, page, limit) {
  const total = items.length;
  const offset = (page - 1) * limit;
  const pageItems = items.slice(offset, offset + limit);
  return {
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
    returned: pageItems.length,
    has_more: offset + pageItems.length < total,
    items: pageItems
  };
}

async function buildAdminPublicPurchasesPayload({ db, query = {}, now = new Date(), requestId = null } = {}) {
  if (!db || typeof db.from !== 'function') {
    const error = new Error('Database client is required.');
    error.code = 'database_client_required';
    error.status = 500;
    throw error;
  }

  const filters = parseFilters(query, now);
  const warnings = [];
  const intentRows = await readIntentRows(db, filters);
  const agreementIds = cleanIdList(intentRows.map((row) => row?.agreement_id));
  const agreementRows = await readAgreementRows(db, agreementIds);
  const agreementsById = mapById(agreementRows);
  const clientIds = cleanIdList([
    ...intentRows.map((row) => row?.client_id),
    ...agreementRows.map((row) => row?.client_id)
  ]);
  const clientRows = await readClientRows(db, clientIds);
  const clientsById = mapById(clientRows);
  const memberRows = await readMemberRows(db, clientIds);
  const membersByClientId = buildMemberMap(memberRows);
  const emailRows = await readWelcomeEmailRows(db, intentRows.map((row) => row?.buyer_email), warnings);
  const emailSummaries = buildEmailSummaryMap(emailRows);

  const allItems = intentRows.map((intent) => {
    const agreement = agreementsById.get(trimText(intent?.agreement_id, 120)) || null;
    const client = clientsById.get(trimText(intent?.client_id || agreement?.client_id, 120)) || null;
    const members = membersByClientId.get(trimText(intent?.client_id || agreement?.client_id || client?.id, 120)) || [];
    const member = chooseBuyerMember(members, intent?.buyer_email || agreement?.admin_email || client?.email);
    const emailSummary =
      emailSummaries.byIntentId.get(trimText(intent?.id, 120)) ||
      emailSummaries.byEmail.get(lowerText(intent?.buyer_email, 254)) ||
      null;
    return sanitizePurchaseItem({ intent, agreement, client, member, emailSummary });
  }).filter((item) => {
    if (filters.membership === 'enterprise') return item.membership.key === 'enterprise';
    if (filters.status && item.status.key !== filters.status) return false;
    if (filters.search && !matchesSearch(item, filters.search)) return false;
    return true;
  });

  const paged = paginate(allItems, filters.page, filters.limit);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    request_id: requestId || null,
    filters: {
      date_range: filters.date_range,
      days: filters.days,
      date_from: filters.date_from,
      date_to: filters.date_to,
      date_from_display: filters.date_from_display,
      date_to_display: filters.date_to_display,
      status: filters.status || 'all',
      membership: filters.membership || 'all',
      billing_cadence: filters.billing_cadence || 'all',
      search: filters.search || ''
    },
    summary: buildSummary(allItems),
    warnings,
    purchases: {
      items: paged.items,
      pagination: {
        page: paged.page,
        limit: paged.limit,
        total: paged.total,
        total_pages: paged.total_pages,
        returned: paged.returned,
        has_more: paged.has_more
      }
    }
  };
}

function safePublicPurchasesErrorBody(error, requestId = null) {
  return {
    error: 'public_purchases_read_failed',
    code: trimText(error?.code, 80) || 'public_purchases_read_failed',
    detail: trimText(error?.message, 300) || 'Could not load public purchases.',
    request_id: requestId || null
  };
}

module.exports = {
  buildAdminPublicPurchasesPayload,
  mapPublicPurchaseStatus,
  parseFilters,
  safePublicPurchasesErrorBody
};
