'use strict';

// Usage billing for the Enterprise model.
//
// Enterprise clients pay a platform fee and, beyond a per-role included count,
// a price per interview. This module works out what is owed and records it; it
// does not talk to Stripe.
//
// What is owed is read from the allocation, which decides what paid for every
// interview. Nothing here scans interviews or keeps a counter: the ledger is the
// record of what was billed, written when Stripe asks for an invoice.
//
// The period is the prior calendar month, decided by interviews.completed_at.
// The ledger's unique interview_id is what prevents double billing.
//
// A child client has no subscription of its own, so interviews run under a
// child's roles are billed on the parent's invoice, tagged with the child's
// entity label. Interview credits deliberately do not roll up that way: a credit
// is earned by a role and stays with the client that owns it. See
// review/BILLING-LOG.md.

const { SOURCE_USAGE } = require('./interviewAllocation');

const USAGE_BILLING_MODEL = 'usage';

const EMPTY_USAGE = Object.freeze({ lines: [], total_cents: 0 });

function emptyUsage(reason) {
  return { lines: [], total_cents: 0, reason };
}

function parseWholeNonNegative(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** The prior calendar month in UTC, as [start, end). */
function priorMonthBounds(asOf) {
  const now = asOf instanceof Date ? asOf : new Date(asOf || Date.now());
  const base = Number.isFinite(now.getTime()) ? now : new Date();
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function monthLabel(startIso) {
  const date = new Date(startIso);
  if (!Number.isFinite(date.getTime())) return 'current period';
  return `${date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${date.getUTCFullYear()}`;
}

function normalizeRoleStatus(value) {
  return String(value || '').trim().toLowerCase() === 'inactive' ? 'closed' : 'open';
}

/**
 * What this client owes, read from the allocation rather than scanned.
 *
 * Bills the prior calendar month. A used interview with **no completed_at** is
 * billed on the invoice being built now rather than waiting: its stamp failed,
 * so there is no month to wait for, and leaving it unbilled would lose it
 * silently. The ledger's unique interview_id is what stops it being billed
 * again, and the caller stamps completed_at afterwards so it behaves normally
 * from then on.
 */
async function computeUnbilledUsage({ db, clientId, asOf, allocation = null } = {}) {
  if (!db || !clientId) return emptyUsage('invalid_request');

  const resolved = allocation
    || await require('./interviewAllocation').allocateInterviews({ db, billingClientId: clientId });
  if (resolved.billing_model !== USAGE_BILLING_MODEL) return emptyUsage('billing_model');

  const unitPriceCents = parseWholeNonNegative(resolved.usage_interview_fee_cents);
  if (unitPriceCents == null) return emptyUsage('no_usage_price');

  const { start, end } = priorMonthBounds(asOf);

  const familyIds = [String(clientId), ...[...resolved.entity_label_by_client.keys()]];
  const { data: ledgerRows, error: ledgerError } = await db
    .from('usage_billing_ledger')
    .select('interview_id')
    .in('client_id', familyIds);
  if (ledgerError) throw new Error(ledgerError.message || 'Usage billing ledger lookup failed');
  const ledgered = new Set((ledgerRows || []).map((row) => String(row?.interview_id ?? '')));

  const roleById = new Map((resolved.roles || []).map((role) => [String(role.id), role]));

  const byRole = new Map();
  const missingCompletedAt = [];
  let totalCents = 0;

  for (const entry of resolved.entries) {
    if (entry.source !== SOURCE_USAGE) continue;
    if (ledgered.has(String(entry.interview_id))) continue;

    const completedAt = entry.completed_at;
    const isMissing = !completedAt;
    if (!isMissing && !(completedAt >= start && completedAt < end)) continue;
    if (isMissing) missingCompletedAt.push(entry);

    const roleId = String(entry.role_id);
    if (!byRole.has(roleId)) {
      const role = roleById.get(roleId) || {};
      byRole.set(roleId, {
        role_id: roleId,
        role_title: String(role.title || '').trim() || 'Role',
        role_status: normalizeRoleStatus(role.status),
        entity_label: resolved.entity_label_by_client.get(String(entry.client_id)) || null,
        quantity: 0,
        unit_price_cents: unitPriceCents,
        amount_cents: 0,
        interview_ids: []
      });
    }
    const line = byRole.get(roleId);
    line.quantity += 1;
    line.amount_cents = line.quantity * unitPriceCents;
    line.interview_ids.push(String(entry.interview_id));
    totalCents += unitPriceCents;
  }

  const lines = [...byRole.values()];
  if (!lines.length) return emptyUsage('nothing_unbilled');
  return {
    lines,
    total_cents: totalCents,
    period_start: start,
    period_end: end,
    month_label: monthLabel(start),
    missing_completed_at: missingCompletedAt.map((entry) => ({
      interview_id: String(entry.interview_id),
      client_id: String(entry.client_id)
    }))
  };
}

/**
 * Stamps completed_at on interviews that reached billing without one.
 *
 * Their completion stamp failed, so the billing time is the only defensible
 * value. Each is logged so the failure can be investigated rather than buried.
 */
async function stampMissingCompletedAt({ db, missing, billedAt } = {}) {
  if (!db || !Array.isArray(missing) || !missing.length) return 0;
  const stampedAt = toIso(billedAt) || new Date().toISOString();
  let stamped = 0;
  for (const row of missing) {
    console.warn('usage_missing_completed_at', {
      interview_id: row.interview_id,
      client_id: row.client_id,
      stamped_completed_at: stampedAt
    });
    const { error } = await db
      .from('interviews')
      .update({ completed_at: stampedAt })
      .eq('id', row.interview_id)
      .is('completed_at', null);
    if (error) {
      console.error('usage_missing_completed_at_stamp_failed', {
        interview_id: row.interview_id,
        error: error.message || error
      });
      continue;
    }
    stamped += 1;
  }
  return stamped;
}

async function recordUsageLines({ db, clientId, lines, stripeInvoiceId, periodStart, periodEnd } = {}) {
  if (!db || !clientId || !Array.isArray(lines) || !lines.length) return { inserted: 0, rows: [] };

  const rows = [];
  for (const line of lines) {
    for (const interviewId of (line?.interview_ids || [])) {
      rows.push({
        client_id: clientId,
        role_id: line.role_id,
        interview_id: interviewId,
        unit_price_cents: line.unit_price_cents,
        stripe_invoice_id: stripeInvoiceId || null,
        period_start: toIso(periodStart),
        period_end: toIso(periodEnd),
        billed_at: null
      });
    }
  }
  if (!rows.length) return { inserted: 0, rows: [] };

  // unit_price_cents comes back because the caller rebuilds its invoice lines
  // from these rows, and must bill them at the price they were reserved at.
  const { data, error } = await db
    .from('usage_billing_ledger')
    .upsert(rows, { onConflict: 'interview_id', ignoreDuplicates: true })
    .select('id,interview_id,role_id,unit_price_cents');
  if (error) throw new Error(error.message || 'Usage billing ledger write failed');

  const inserted = Array.isArray(data) ? data : [];
  return { inserted: inserted.length, rows: inserted };
}

/** Every ledger row attached to one Stripe invoice. */
async function listLedgerRowsForInvoice({ db, stripeInvoiceId } = {}) {
  if (!db || !stripeInvoiceId) return [];
  const { data, error } = await db
    .from('usage_billing_ledger')
    .select('id,client_id,role_id,interview_id,unit_price_cents,stripe_invoice_item_id,billed_at,period_start,period_end')
    .eq('stripe_invoice_id', stripeInvoiceId);
  if (error) throw new Error(error.message || 'Usage billing ledger lookup failed');
  return data || [];
}

/**
 * Stamps the Stripe item and the billing time onto the rows it paid for.
 *
 * Scoped to the invoice as well as the interviews: rows reserved against an
 * invoice that never completed must not be claimed by a later invoice that
 * happens to cover the same interviews.
 */
async function markUsageLinesBilled({ db, stripeInvoiceId, interviewIds, stripeInvoiceItemId, billedAt } = {}) {
  if (!db || !stripeInvoiceId || !Array.isArray(interviewIds) || !interviewIds.length) return 0;
  const { data, error } = await db
    .from('usage_billing_ledger')
    .update({
      stripe_invoice_item_id: stripeInvoiceItemId || null,
      billed_at: toIso(billedAt) || new Date().toISOString()
    })
    .in('interview_id', interviewIds)
    .eq('stripe_invoice_id', stripeInvoiceId)
    .is('billed_at', null)
    .select('id');
  if (error) throw new Error(error.message || 'Usage billing ledger stamp failed');
  return Array.isArray(data) ? data.length : 0;
}

// Rebuilds invoice lines from ledger rows a previous attempt already reserved,
// so a resumed run bills exactly what was reserved and nothing more.
function linesFromLedgerRows(rows, roleMetaById) {
  const byRole = new Map();
  for (const row of rows) {
    const roleId = String(row?.role_id ?? '');
    if (!byRole.has(roleId)) {
      const meta = roleMetaById.get(roleId) || {};
      byRole.set(roleId, {
        role_id: roleId,
        role_title: meta.title || 'Role',
        entity_label: meta.entity_label || null,
        quantity: 0,
        unit_price_cents: parseWholeNonNegative(row?.unit_price_cents) ?? 0,
        amount_cents: 0,
        interview_ids: []
      });
    }
    const line = byRole.get(roleId);
    line.quantity += 1;
    line.interview_ids.push(String(row.interview_id));
    line.amount_cents = line.quantity * line.unit_price_cents;
  }
  return [...byRole.values()];
}

/**
 * Adds one usage item per role to a Stripe invoice and records the ledger.
 *
 * Ordering is what makes a partial failure recoverable: the ledger rows are
 * reserved first with billed_at null, then each Stripe item is created, then the
 * rows it paid for are stamped. A retry finds the reserved rows and creates
 * items only for the ones still unstamped, so nothing is billed twice and
 * nothing is silently dropped.
 *
 * Stripe failures are rethrown so the caller can let Stripe retry.
 */
async function applyUsageToInvoice({
  db, stripe, clientId, customerId, invoiceId, asOf, metadata, now
} = {}) {
  if (!db || !stripe || !clientId || !invoiceId) {
    return { applied: false, reason: 'invalid_request', items: 0, total_cents: 0 };
  }

  const existing = await listLedgerRowsForInvoice({ db, stripeInvoiceId: invoiceId });
  if (existing.length && existing.every((row) => row.billed_at != null)) {
    return { applied: false, reason: 'already_billed', items: 0, total_cents: 0 };
  }

  const allocation = await require('./interviewAllocation')
    .allocateInterviews({ db, billingClientId: clientId });
  const roleMetaById = new Map((allocation.roles || []).map((role) => [String(role.id), {
    title: String(role.title || '').trim() || 'Role',
    role_status: normalizeRoleStatus(role.status),
    entity_label: allocation.entity_label_by_client.get(String(role.client_id ?? '')) || null
  }]));

  let lines;
  let periodStart = null;
  let periodEnd = null;
  let billedLabel = monthLabel(priorMonthBounds(asOf).start);
  let missingCompletedAt = [];
  if (existing.length) {
    periodStart = existing[0]?.period_start || null;
    periodEnd = existing[0]?.period_end || null;
    // Resume: bill exactly what the failed attempt reserved.
    lines = linesFromLedgerRows(existing.filter((row) => row.billed_at == null), roleMetaById);
  } else {
    const usage = await computeUnbilledUsage({ db, clientId, asOf, allocation });
    if (!usage.lines.length) {
      return { applied: false, reason: usage.reason || 'nothing_unbilled', items: 0, total_cents: 0 };
    }
    periodStart = usage.period_start;
    periodEnd = usage.period_end;
    billedLabel = usage.month_label;
    missingCompletedAt = usage.missing_completed_at || [];

    // Bill exactly what this run reserved, never what it computed. The reserve
    // is an upsert that skips interviews already on the ledger, so a run that
    // overlapped with another gets back fewer rows than it asked for — and
    // billing the computed set would charge the client twice for the interviews
    // the other run already took.
    const reserved = await recordUsageLines({
      db, clientId, lines: usage.lines, stripeInvoiceId: invoiceId, periodStart, periodEnd
    });
    if (!reserved.inserted) {
      return { applied: false, reason: 'already_reserved', items: 0, total_cents: 0 };
    }
    lines = linesFromLedgerRows(reserved.rows, roleMetaById);
  }

  if (!lines.length) return { applied: false, reason: 'nothing_unbilled', items: 0, total_cents: 0 };

  const label = billedLabel;
  let items = 0;
  let totalCents = 0;
  for (const line of lines) {
    const item = await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoiceId,
      currency: 'usd',
      unit_amount: line.unit_price_cents,
      quantity: line.quantity,
      description: line.entity_label
        ? `Interviews — ${line.entity_label} · ${line.role_title} [${line.role_status || roleMetaById.get(String(line.role_id))?.role_status || 'open'}] (${label})`
        : `Interviews — ${line.role_title} [${line.role_status || roleMetaById.get(String(line.role_id))?.role_status || 'open'}] (${label})`,
      metadata: {
        client_id: clientId,
        role_id: line.role_id,
        source: 'usage_billing',
        ...(metadata || {})
      }
    });

    await markUsageLinesBilled({
      db,
      stripeInvoiceId: invoiceId,
      interviewIds: line.interview_ids,
      stripeInvoiceItemId: item?.id || null,
      billedAt: toIso(now) || new Date().toISOString()
    });
    items += 1;
    totalCents += line.amount_cents;
  }

  // Their completion stamp failed, so billing time is the only defensible value.
  // Stamped after the ledger rows exist, so the unique interview_id is already
  // guarding against a second charge.
  await stampMissingCompletedAt({ db, missing: missingCompletedAt, billedAt: toIso(now) });

  return { applied: true, items, total_cents: totalCents, lines };
}

/**
 * Raises a usage invoice of its own, rather than waiting for the next cycle.
 *
 * Used for the one-time order at signup and for annual Enterprise clients, whose
 * platform-fee invoice only appears once a year. The invoice is created first so
 * the items and the ledger have something to attach to, then finalized.
 */
async function createImmediateUsageInvoice({
  db, stripe, clientId, customerId, asOf, requestId, reason, now
} = {}) {
  if (!db || !stripe || !clientId) return { skipped: true, reason: 'invalid_request' };

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('id,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle();
  if (clientError) throw new Error(clientError.message || 'Usage invoice client lookup failed');
  if (!client) return { skipped: true, reason: 'client_not_found' };

  const stripeCustomerId = String(customerId || client.stripe_customer_id || '').trim();
  if (!stripeCustomerId) return { skipped: true, reason: 'no_stripe_customer' };

  // Checked before creating an invoice, so an empty one is never raised.
  const usage = await computeUnbilledUsage({ db, clientId, asOf });
  if (!usage.lines.length) return { skipped: true, reason: usage.reason || 'nothing_unbilled' };

  const invoice = await stripe.invoices.create({
    customer: stripeCustomerId,
    collection_method: 'charge_automatically',
    auto_advance: true,
    metadata: {
      client_id: clientId,
      source: 'usage_billing',
      reason: String(reason || 'admin_request'),
      ...(requestId ? { request_id: String(requestId) } : {})
    }
  });
  const invoiceId = String(invoice?.id || '').trim();
  if (!invoiceId) throw new Error('Usage invoice creation returned no id');

  const applied = await applyUsageToInvoice({
    db,
    stripe,
    clientId,
    customerId: stripeCustomerId,
    invoiceId,
    asOf,
    metadata: { reason: String(reason || 'admin_request') },
    now
  });

  // Nothing was added — the usual cause is a resumed run whose rows were all
  // stamped already. Finalizing now would send the client an empty invoice, and
  // auto_advance would try to collect it, so the draft is discarded instead.
  if (!applied.applied) {
    try {
      await stripe.invoices.del(invoiceId);
    } catch (discardError) {
      console.error('usage_invoice_discard_failed', {
        client_id: clientId,
        stripe_invoice_id: invoiceId,
        error: discardError?.message || String(discardError)
      });
    }
    return { skipped: true, reason: applied.reason || 'nothing_applied' };
  }

  await stripe.invoices.finalizeInvoice(invoiceId);

  return {
    invoice_id: invoiceId,
    total_cents: applied.total_cents,
    lines: applied.lines || usage.lines
  };
}

module.exports = {
  EMPTY_USAGE,
  USAGE_BILLING_MODEL,
  applyUsageToInvoice,
  computeUnbilledUsage,
  createImmediateUsageInvoice,
  listLedgerRowsForInvoice,
  markUsageLinesBilled,
  priorMonthBounds,
  recordUsageLines,
  stampMissingCompletedAt
};
