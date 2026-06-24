'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildAdminPublicPurchasesPayload,
  mapPublicPurchaseStatus,
} = require('../src/lib/adminPublicPurchasesService');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.ranges = [];
    this.orderField = null;
    this.ascending = false;
    this.limitCount = null;
  }

  select(columns) {
    this.db.selects.push({ table: this.table, columns: String(columns || '') });
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value: String(value) });
    return this;
  }

  in(column, values) {
    this.inFilters.push({ column, values: new Set((values || []).map((value) => String(value))) });
    return this;
  }

  gte(column, value) {
    this.ranges.push({ type: 'gte', column, value: new Date(value).getTime() });
    return this;
  }

  lte(column, value) {
    this.ranges.push({ type: 'lte', column, value: new Date(value).getTime() });
    return this;
  }

  order(column, options = {}) {
    this.orderField = column;
    this.ascending = options.ascending === true;
    return this;
  }

  limit(count) {
    this.limitCount = Number(count || 0);
    return this;
  }

  execute() {
    this.db.reads.push(this.table);
    let rows = (this.db.tables[this.table] || []).map((row) => ({ ...row }));
    for (const filter of this.filters) {
      rows = rows.filter((row) => String(row[filter.column] || '') === filter.value);
    }
    for (const filter of this.inFilters) {
      rows = rows.filter((row) => filter.values.has(String(row[filter.column] || '')));
    }
    for (const range of this.ranges) {
      rows = rows.filter((row) => {
        const value = new Date(row[range.column] || '').getTime();
        if (!Number.isFinite(value)) return false;
        return range.type === 'gte' ? value >= range.value : value <= range.value;
      });
    }
    if (this.orderField) {
      rows.sort((a, b) => {
        const left = String(a[this.orderField] || '');
        const right = String(b[this.orderField] || '');
        return this.ascending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    if (this.limitCount) rows = rows.slice(0, this.limitCount);
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }
}

function makeDb(tables = {}) {
  return {
    tables: {
      public_purchase_intents: [],
      membership_agreements: [],
      clients: [],
      client_members: [],
      email_delivery_events: [],
      ...tables,
    },
    selects: [],
    reads: [],
    writes: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

const NOW = new Date('2026-06-24T12:00:00.000Z');

function packageSnapshot(plan = 'basic', cadence = 'monthly') {
  const isPro = plan === 'pro';
  const isAnnual = cadence === 'annual';
  return {
    plan_key: plan,
    display_name: isPro ? 'Pro' : 'Basic',
    billing_cadence: cadence,
    billing_cadence_display_name: isAnnual ? 'Annual' : 'Monthly',
    platform_fee: isPro ? (isAnnual ? 6499 : 599) : (isAnnual ? 3299 : 299),
    platform_fee_cents: isPro ? (isAnnual ? 649900 : 59900) : (isAnnual ? 329900 : 29900),
    platform_monthly_fee: isPro ? 599 : 299,
    platform_annual_fee: isPro ? 6499 : 3299,
    per_role_fee: isPro ? 699 : 399,
    included_interviews: isPro ? 30 : 20,
    interview_duration_minutes: isPro ? 12 : 10,
    additional_interview_price: isPro ? 35 : 30,
  };
}

function intent(overrides = {}) {
  return {
    id: overrides.id || 'intent-1',
    status: overrides.status || 'pending',
    selected_plan_key: overrides.plan || 'basic',
    selected_billing_cadence: overrides.cadence || 'monthly',
    package_snapshot: overrides.package_snapshot || packageSnapshot(overrides.plan || 'basic', overrides.cadence || 'monthly'),
    company_legal_name: overrides.company || 'Acme Dental LLC',
    company_dba: overrides.dba || 'Acme Dental',
    buyer_first_name: overrides.first || 'Alex',
    buyer_last_name: overrides.last || 'Buyer',
    buyer_email: overrides.email || 'alex@example.com',
    buyer_phone: '555-0100',
    buyer_title: 'Talent Lead',
    source_path: '/alphascreen/pricing',
    agreement_id: overrides.agreement_id || null,
    stripe_checkout_session_id: overrides.stripe_checkout_session_id || null,
    client_id: overrides.client_id || null,
    expires_at: null,
    created_at: overrides.created_at || '2026-06-24T10:00:00.000Z',
    updated_at: overrides.updated_at || '2026-06-24T10:10:00.000Z',
    raw_payload: { should_not: 'leak' },
  };
}

function agreement(overrides = {}) {
  return {
    id: overrides.id || 'agreement-1',
    client_id: overrides.client_id || null,
    status: overrides.status || 'sent',
    is_current: overrides.is_current !== false,
    checkout_status: overrides.checkout_status || null,
    checkout_session_id: overrides.checkout_session_id || null,
    checkout_created_at: overrides.checkout_created_at || null,
    checkout_paid_at: overrides.checkout_paid_at || null,
    client_legal_name: overrides.company || 'Acme Dental LLC',
    dba_trade_name: 'Acme Dental',
    primary_admin_name: 'Alex Buyer',
    admin_email: 'alex@example.com',
    membership_tier: overrides.plan || 'basic',
    billing_option: overrides.cadence || 'monthly',
    sent_at: '2026-06-24T10:20:00.000Z',
    opened_at: overrides.opened_at || null,
    signed_at: overrides.signed_at || null,
    voided_at: overrides.voided_at || null,
    created_at: '2026-06-24T10:15:00.000Z',
    updated_at: '2026-06-24T10:20:00.000Z',
    signer_token_hash: 'do-not-return',
    draft_pdf_path: '/tmp/private.pdf',
  };
}

test('admin public purchases route is registered behind admin auth', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(appSource, /adminRouter\.get\('\/public-purchases', requireAuth, requireAdmin/);
  assert.match(appSource, /buildAdminPublicPurchasesPayload/);
  assert.match(appSource, /safePublicPurchasesErrorBody/);
});

test('public purchase status mapping covers key workflow states', () => {
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'pending' } }).key, 'signup_started');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'agreement_pending' }, agreement: { status: 'sent' } }).key, 'agreement_pending');
  assert.equal(mapPublicPurchaseStatus({ agreement: { status: 'signed' } }).key, 'signed_unpaid');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'checkout_pending' }, agreement: { checkout_status: 'pending_payment' } }).key, 'checkout_pending');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'completed' }, agreement: { checkout_status: 'paid' }, client: { billing_status: 'active', subscription_status: 'active' } }).key, 'setup_pending');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'completed' }, agreement: { checkout_status: 'paid' }, client: { billing_status: 'active', subscription_status: 'active' }, member: { user_id: 'user-1' } }).key, 'completed');
  assert.equal(mapPublicPurchaseStatus({ client: { billing_status: 'active', subscription_status: 'past_due' } }).key, 'failed_payment');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'canceled' } }).key, 'canceled');
});

test('admin public purchases payload summarizes rows and returns sanitized details', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-started', status: 'pending', created_at: '2026-06-24T10:00:00.000Z' }),
      intent({ id: 'intent-agreement', status: 'agreement_pending', agreement_id: 'agreement-sent', created_at: '2026-06-24T09:00:00.000Z' }),
      intent({ id: 'intent-checkout', status: 'checkout_pending', agreement_id: 'agreement-checkout', client_id: 'client-checkout', created_at: '2026-06-24T08:00:00.000Z' }),
      intent({ id: 'intent-complete', status: 'completed', plan: 'pro', cadence: 'annual', agreement_id: 'agreement-paid', client_id: 'client-paid', created_at: '2026-06-24T07:00:00.000Z' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-sent', status: 'sent' }),
      agreement({ id: 'agreement-checkout', status: 'signed', checkout_status: 'pending_payment', checkout_session_id: 'cs_test_checkout', client_id: 'client-checkout', signed_at: '2026-06-24T08:15:00.000Z' }),
      agreement({ id: 'agreement-paid', status: 'signed', checkout_status: 'paid', checkout_session_id: 'cs_test_paid', client_id: 'client-paid', plan: 'pro', cadence: 'annual', signed_at: '2026-06-24T07:15:00.000Z', checkout_paid_at: '2026-06-24T07:30:00.000Z' }),
    ],
    clients: [
      { id: 'client-checkout', name: 'Checkout Co', email: 'alex@example.com', billing_status: 'inactive', subscription_status: 'incomplete', plan_tier: 'basic', billing_interval: 'monthly', stripe_customer_id: 'cus_checkout', stripe_subscription_id: null, created_at: '2026-06-24T08:20:00.000Z' },
      { id: 'client-paid', name: 'Paid Co', email: 'alex@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'pro', billing_interval: 'annual', stripe_customer_id: 'cus_paid', stripe_subscription_id: 'sub_paid', created_at: '2026-06-24T07:20:00.000Z' },
    ],
    client_members: [
      { client_id: 'client-paid', user_id: 'user-paid', email: 'alex@example.com', name: 'Alex Buyer', role: 'admin', created_at: '2026-06-24T07:35:00.000Z' },
    ],
    email_delivery_events: [
      {
        id: 'email-1',
        email: 'alex@example.com',
        email_category: 'public_purchase_welcome',
        status: 'sent',
        event_type: 'outbound_public_purchase_welcome',
        event_at: '2026-06-24T07:40:00.000Z',
        created_at: '2026-06-24T07:40:00.000Z',
        is_problem: false,
        custom_args: { purchase_intent_id: 'intent-complete', agreement_id: 'agreement-paid', client_id: 'client-paid' },
        raw_payload: { secret: 'do-not-return' },
      },
    ],
  });

  const payload = await buildAdminPublicPurchasesPayload({ db, now: NOW, query: { days: '7', limit: '10' } });

  assert.equal(payload.summary.signup_started, 1);
  assert.equal(payload.summary.agreement_pending, 1);
  assert.equal(payload.summary.checkout_pending, 1);
  assert.equal(payload.summary.completed, 1);
  assert.equal(payload.summary.total, 4);
  assert.equal(payload.purchases.pagination.returned, 4);
  const completed = payload.purchases.items.find((item) => item.purchase_intent_id === 'intent-complete');
  assert.equal(completed.status.key, 'completed');
  assert.equal(completed.membership.key, 'pro');
  assert.equal(completed.membership.billing_cadence, 'annual');
  assert.equal(completed.membership.platform_fee, 6499);
  assert.equal(completed.account_setup.member_user_linked, true);
  assert.equal(completed.email_delivery.welcome_email.status, 'sent');
  assert.deepEqual(Array.from(new Set(db.reads)).sort(), ['client_members', 'clients', 'email_delivery_events', 'membership_agreements', 'public_purchase_intents']);
  assert.equal(db.writes.length, 0);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /raw_payload|signer_token_hash|draft_pdf_path|executed_pdf_path|signature_hash|do-not-return|secret/i);
});

test('admin public purchases filters by status, cadence, membership, search, and paginates', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-basic-monthly', status: 'pending', plan: 'basic', cadence: 'monthly', company: 'Blue Clinic', email: 'blue@example.com', created_at: '2026-06-24T10:00:00.000Z' }),
      intent({ id: 'intent-pro-annual', status: 'completed', plan: 'pro', cadence: 'annual', agreement_id: 'agreement-pro', client_id: 'client-pro', company: 'Pro Hospital', email: 'pro@example.com', created_at: '2026-06-24T09:00:00.000Z' }),
      intent({ id: 'intent-pro-annual-2', status: 'completed', plan: 'pro', cadence: 'annual', agreement_id: 'agreement-pro-2', client_id: 'client-pro-2', company: 'Pro Dental', email: 'dental@example.com', created_at: '2026-06-24T08:00:00.000Z' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-pro', status: 'signed', checkout_status: 'paid', client_id: 'client-pro', plan: 'pro', cadence: 'annual' }),
      agreement({ id: 'agreement-pro-2', status: 'signed', checkout_status: 'paid', client_id: 'client-pro-2', plan: 'pro', cadence: 'annual' }),
    ],
    clients: [
      { id: 'client-pro', name: 'Pro Hospital', email: 'pro@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'pro', billing_interval: 'annual' },
      { id: 'client-pro-2', name: 'Pro Dental', email: 'dental@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'pro', billing_interval: 'annual' },
    ],
    client_members: [
      { client_id: 'client-pro', user_id: 'user-pro', email: 'pro@example.com', name: 'Alex Buyer', role: 'admin' },
      { client_id: 'client-pro-2', user_id: 'user-pro-2', email: 'dental@example.com', name: 'Alex Buyer', role: 'admin' },
    ],
  });

  const payload = await buildAdminPublicPurchasesPayload({
    db,
    now: NOW,
    query: { days: '7', membership: 'pro', cadence: 'annual', status: 'completed', search: 'pro', limit: '1', page: '2' },
  });

  assert.equal(payload.summary.completed, 2);
  assert.equal(payload.purchases.pagination.total, 2);
  assert.equal(payload.purchases.pagination.returned, 1);
  assert.equal(payload.purchases.pagination.page, 2);
  assert.equal(payload.purchases.items.length, 1);
  assert.equal(payload.purchases.items[0].membership.key, 'pro');
  assert.equal(payload.purchases.items[0].membership.billing_cadence, 'annual');
});
