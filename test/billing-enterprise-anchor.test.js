'use strict';

// Where an Enterprise subscription's billing cycle starts.
//
// Enterprise usage is billed a month behind, on the 1st: monthly clients get it
// added to their platform-fee invoice, annual clients get their own invoice from
// the cron. Both only line up if the subscription itself renews on the 1st, so
// Checkout is told to anchor the cycle there and to charge the part-month up
// front as a proration.
//
// Stripe and Supabase are stubbed; no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const checkoutPath = path.join(ROOT, 'src', 'services', 'subscriptionCheckout.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const clientBillingScopePath = path.join(ROOT, 'src', 'services', 'clientBillingScope.js');
const urlConfigPath = path.join(ROOT, 'src', 'config', 'urlConfig.js');
const stripePackagePath = require.resolve('stripe');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CLIENT = 'client_1';

function makeDb() {
  return createFakeSupabase({
    clients: [{
      id: CLIENT, parent_client_id: null, name: 'Acme Dental Group',
      email: 'owner@acme.example', stripe_customer_id: 'cus_1', stripe_subscription_id: null
    }],
    billing_customers: [],
    enterprise_pool_discounts: [],
    client_interview_pools: []
  });
}

function loadCheckout(db, stripeCalls) {
  for (const p of [checkoutPath, supabasePath, clientBillingScopePath, urlConfigPath, stripePackagePath]) {
    delete require.cache[p];
  }
  injectModule(supabasePath, { supabaseAdmin: db });
  injectModule(clientBillingScopePath, { requireParentClient: async () => ({ ok: true, clientId: CLIENT }) });
  injectModule(urlConfigPath, {
    resolvePublicBackendBase: (value) => value || 'https://api.test',
    buildClientDashboardReturnUrl: () => 'https://dash.test/return'
  });
  injectModule(stripePackagePath, function Stripe() {
    return {
      customers: {
        retrieve: async (id) => ({ id }),
        update: async (id) => ({ id }),
        create: async () => ({ id: 'cus_created' })
      },
      subscriptions: { list: async () => ({ data: [] }) },
      prices: {
        create: async (payload) => {
          stripeCalls.prices.push(payload);
          return { id: `price_${stripeCalls.prices.length}` };
        }
      },
      checkout: {
        sessions: {
          create: async (payload) => {
            stripeCalls.sessions.push(payload);
            return { id: 'cs_1', url: 'https://checkout.test/cs_1' };
          }
        }
      }
    };
  });
  return require(checkoutPath);
}

const ENTERPRISE_FEES = Object.freeze({
  platform_fee: 1200,
  per_role_fee: 0,
  included_interviews_per_role: 0,
  additional_interview_fee: 0,
  usage_interview_fee_cents: 2500
});

// Essentials and Pro use a configured Stripe price rather than a created one.
const PLAN_PRICE_ENV = {
  basic: 'STRIPE_PRICE_BASIC_MONTHLY',
  pro: 'STRIPE_PRICE_PRO_MONTHLY'
};

async function checkout({ planTier, billingInterval = 'monthly', now }) {
  const stripeCalls = { prices: [], sessions: [] };
  const previous = { ...process.env };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  const priceEnv = PLAN_PRICE_ENV[planTier];
  if (priceEnv) process.env[priceEnv] = `price_${planTier}`;
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout(makeDb(), stripeCalls);
    await createSubscriptionCheckoutSession({
      clientId: CLIENT,
      planTier,
      billingInterval,
      metadataSource: 'admin_subscription_checkout',
      ...(planTier === 'enterprise' ? { enterpriseFees: ENTERPRISE_FEES } : {}),
      now,
      requestContext: { forwardedProto: 'https', forwardedHost: 'api.test' }
    });
    return stripeCalls.sessions[0];
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

const epochOf = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('an Enterprise monthly checkout anchors the cycle to the next 1st at 00:00 UTC', async () => {
  const session = await checkout({ planTier: 'enterprise', now: '2026-09-14T11:22:33.000Z' });

  assert.equal(session.subscription_data.billing_cycle_anchor, epochOf('2026-10-01T00:00:00.000Z'));
  assert.equal(session.subscription_data.proration_behavior, 'create_prorations',
    'the part-month before the anchor is charged, not given away');
});

test('an Enterprise annual checkout anchors the same way', async () => {
  const session = await checkout({
    planTier: 'enterprise', billingInterval: 'annual', now: '2026-09-14T11:22:33.000Z'
  });

  assert.equal(session.subscription_data.billing_cycle_anchor, epochOf('2026-10-01T00:00:00.000Z'));
});

test('a checkout on the 1st anchors to the following month, not to today', async () => {
  // Anchoring to the current instant would leave the cycle starting mid-day on
  // the 1st, and Stripe rejects an anchor in the past by the time it is used.
  const session = await checkout({ planTier: 'enterprise', now: '2026-09-01T00:00:00.000Z' });

  assert.equal(session.subscription_data.billing_cycle_anchor, epochOf('2026-10-01T00:00:00.000Z'));
});

test('a December checkout anchors to the 1st of January', async () => {
  const session = await checkout({ planTier: 'enterprise', now: '2026-12-20T09:00:00.000Z' });

  assert.equal(session.subscription_data.billing_cycle_anchor, epochOf('2027-01-01T00:00:00.000Z'));
});

test('Essentials and Pro checkouts are not anchored', async () => {
  for (const planTier of ['basic', 'pro']) {
    const session = await checkout({ planTier, now: '2026-09-14T11:22:33.000Z' });
    assert.equal('billing_cycle_anchor' in session.subscription_data, false,
      `${planTier} has no usage to line up, so its cycle starts when it is bought`);
    assert.equal('proration_behavior' in session.subscription_data, false);
  }
});
