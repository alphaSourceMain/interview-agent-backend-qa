'use strict';

// What paid for each interview.
//
// This is the single place that decides, for every used interview a client has
// run, whether it came out of the role's own allowance, a rollover credit, the
// Enterprise pool, or is metered usage. Read surfaces and the billing path both
// call it, so a dashboard and an invoice cannot disagree.
//
// Nothing here writes. Balances are derived by replaying interviews in the order
// they completed, so there is no counter to keep in step and no lag between an
// interview finishing and the numbers moving.
//
// COST: this walks every used interview for the payer and its child entities on
// each call. That is fine at present volumes and is why callers that need
// several roles — the roles list especially — should allocate once and reuse the
// result rather than calling per role. See allocateInterviews' `allocation`
// parameter on getRoleInterviewAvailability.

const { isUsedInterviewRow } = require('./roleInterviewAvailability');
const { resolveBillingModel } = require('./billingModel');

const SOURCE_OWN = 'own';
const SOURCE_CREDIT = 'credit';
const SOURCE_POOL = 'pool';
const SOURCE_USAGE = 'usage';

const ROLLOVER_BILLING_MODEL = 'rollover';
const USAGE_BILLING_MODEL = 'usage';

// The columns isUsedInterviewRow reads, plus what ordering and reporting need.
const INTERVIEW_COLUMNS = [
  'id',
  'role_id',
  'client_id',
  'completed_at',
  'updated_at',
  'status',
  'transcript_scores',
  'interview_summary',
  'has_substantive_response',
  'failure_code',
  'conversation_progress_state'
].join(',');

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

// completed_at is the timestamp; updated_at stands in only for rows that predate
// it, so ordering stays total and deterministic. The id breaks exact ties.
function completionKey(row) {
  return toIso(row?.completed_at) || toIso(row?.updated_at) || '';
}

function byCompletion(left, right) {
  const leftAt = completionKey(left);
  const rightAt = completionKey(right);
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return String(left?.id ?? '') < String(right?.id ?? '') ? -1 : 1;
}

/** The payer and every child entity beneath it. */
async function loadFamily({ db, billingClientId }) {
  const parentId = String(billingClientId);
  const { data: children, error } = await db
    .from('clients')
    .select('id,name,entity_label')
    .eq('parent_client_id', parentId);
  if (error) throw new Error(error.message || 'Allocation entity lookup failed');

  const familyIds = [parentId];
  const entityLabelById = new Map();
  for (const child of (children || [])) {
    const childId = String(child?.id ?? '');
    if (!childId || childId === parentId) continue;
    familyIds.push(childId);
    entityLabelById.set(childId, String(child?.entity_label || child?.name || '').trim() || null);
  }
  return { familyIds, entityLabelById };
}

/**
 * A credit is spendable for an interview completed while it was live: from when
 * it was minted until the earlier of its expiry and its revocation.
 *
 * Revocation is not retroactive. Interviews already allocated to a credit before
 * it was revoked stay allocated, and the count of those is what reduces the
 * reopened role's own remaining — which is what `roles.rollover_drawn_offset`
 * used to store.
 */
function creditIsLiveAt(credit, completedAtIso) {
  if (!completedAtIso) return false;
  const mintedAt = toIso(credit.minted_at);
  if (mintedAt && completedAtIso < mintedAt) return false;
  const expiresAt = toIso(credit.expires_at);
  if (expiresAt && completedAtIso >= expiresAt) return false;
  const revokedAt = toIso(credit.revoked_at);
  if (revokedAt && completedAtIso >= revokedAt) return false;
  return true;
}

/**
 * Allocates every used interview in the family.
 *
 * @returns {{
 *   billing_model: string|null,
 *   entries: Array<{interview_id, role_id, client_id, completed_at, source, source_id}>,
 *   by_role: Map<string, {used, own, credit, pool, usage, own_remaining, drawn_from_revoked}>,
 *   totals: {used, own, credit, pool, usage, credit_balance, pool_remaining},
 *   credits: Array, pools: Array, entity_label_by_client: Map
 * }}
 */
async function allocateInterviews({ db, billingClientId, asOf } = {}) {
  const empty = {
    billing_model: null,
    entries: [],
    by_role: new Map(),
    totals: { used: 0, own: 0, credit: 0, pool: 0, usage: 0, credit_balance: 0, pool_remaining: 0 },
    credits: [],
    pools: [],
    entity_label_by_client: new Map()
  };
  if (!db || !billingClientId) return empty;

  const billing = await resolveBillingModel({ db, clientId: billingClientId });
  if (!billing.billing_model) return empty;

  const { familyIds, entityLabelById } = await loadFamily({ db, billingClientId });
  const includedPerRole = billing.billing_model === USAGE_BILLING_MODEL
    ? 0
    : (parseWholeNonNegative(billing.included_interviews_per_role) ?? 0);

  const { data: roleRows, error: rolesError } = await db
    .from('roles')
    .select('id,client_id,title,status')
    .in('client_id', familyIds);
  if (rolesError) throw new Error(rolesError.message || 'Allocation role lookup failed');

  const { data: interviewRows, error: interviewsError } = await db
    .from('interviews')
    .select(INTERVIEW_COLUMNS)
    .in('client_id', familyIds);
  if (interviewsError) throw new Error(interviewsError.message || 'Allocation interview lookup failed');

  const { data: purchaseRows, error: purchasesError } = await db
    .from('role_interview_purchases')
    .select('role_id,quantity')
    .in('client_id', familyIds)
    .eq('status', 'paid');
  if (purchasesError) throw new Error(purchasesError.message || 'Allocation purchase lookup failed');

  // Credits stay with the client whose role earned them; they do not pool at the
  // parent. Every credit is loaded, live or not, because whether one applies
  // depends on when each interview completed.
  const { data: creditRows, error: creditsError } = await db
    .from('interview_credits')
    .select('id,client_id,source_role_id,quantity,minted_at,expires_at,revoked_at')
    .in('client_id', familyIds);
  if (creditsError) throw new Error(creditsError.message || 'Allocation credit lookup failed');

  const { data: poolRows, error: poolsError } = await db
    .from('client_interview_pools')
    .select('id,client_id,quantity_purchased,status,created_at,paid_at')
    .eq('client_id', billingClientId)
    .eq('status', 'paid');
  if (poolsError) throw new Error(poolsError.message || 'Allocation pool lookup failed');

  const asOfIso = toIso(asOf) || new Date().toISOString();

  // Per-role allowance: the included count plus anything bought for that role.
  const allowanceByRole = new Map();
  for (const role of (roleRows || [])) {
    allowanceByRole.set(String(role.id), includedPerRole);
  }
  for (const purchase of (purchaseRows || [])) {
    const roleId = String(purchase?.role_id ?? '');
    if (!allowanceByRole.has(roleId)) continue;
    const quantity = parseWholeNonNegative(purchase?.quantity);
    if (quantity != null) allowanceByRole.set(roleId, allowanceByRole.get(roleId) + quantity);
  }

  const credits = (creditRows || [])
    .map((credit) => ({
      ...credit,
      quantity: parseWholeNonNegative(credit?.quantity) ?? 0,
      allocated: 0
    }))
    .sort((left, right) => {
      const leftAt = toIso(left.expires_at) || '';
      const rightAt = toIso(right.expires_at) || '';
      if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
      return String(left.id) < String(right.id) ? -1 : 1;
    });

  const pools = (poolRows || [])
    .map((pool) => ({
      ...pool,
      quantity_purchased: parseWholeNonNegative(pool?.quantity_purchased) ?? 0,
      allocated: 0
    }))
    .sort((left, right) => {
      const leftAt = toIso(left.created_at) || '';
      const rightAt = toIso(right.created_at) || '';
      if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
      return String(left.id) < String(right.id) ? -1 : 1;
    });

  const used = (interviewRows || [])
    .filter((row) => isUsedInterviewRow(row))
    .sort(byCompletion);

  const roleUsage = new Map();
  const roleOf = (roleId) => {
    if (!roleUsage.has(roleId)) {
      roleUsage.set(roleId, {
        used: 0, own: 0, credit: 0, pool: 0, usage: 0,
        own_remaining: 0, drawn_from_revoked: 0
      });
    }
    return roleUsage.get(roleId);
  };

  const entries = [];
  const ownUsedByRole = new Map();

  for (const row of used) {
    const roleId = String(row?.role_id ?? '');
    const clientId = String(row?.client_id ?? '');
    const completedAt = completionKey(row) || null;
    const counters = roleOf(roleId);
    counters.used += 1;

    // 1. The role's own allowance.
    const allowance = allowanceByRole.get(roleId) ?? includedPerRole;
    const ownUsed = ownUsedByRole.get(roleId) ?? 0;
    if (ownUsed < allowance) {
      ownUsedByRole.set(roleId, ownUsed + 1);
      counters.own += 1;
      entries.push({
        interview_id: String(row.id), role_id: roleId, client_id: clientId,
        completed_at: completedAt, source: SOURCE_OWN, source_id: roleId
      });
      continue;
    }

    // 2. A credit that was live when this interview completed, earliest expiry
    //    first. Credits belong to the client that earned them.
    if (billing.billing_model === ROLLOVER_BILLING_MODEL) {
      const credit = credits.find((candidate) => (
        String(candidate.client_id) === clientId
        && candidate.allocated < candidate.quantity
        && creditIsLiveAt(candidate, completedAt)
      ));
      if (credit) {
        credit.allocated += 1;
        counters.credit += 1;
        entries.push({
          interview_id: String(row.id), role_id: roleId, client_id: clientId,
          completed_at: completedAt, source: SOURCE_CREDIT, source_id: String(credit.id)
        });
        continue;
      }
    }

    // 3. The Enterprise pool, oldest first, across the whole family.
    if (billing.billing_model === USAGE_BILLING_MODEL) {
      const pool = pools.find((candidate) => candidate.allocated < candidate.quantity_purchased);
      if (pool) {
        pool.allocated += 1;
        counters.pool += 1;
        entries.push({
          interview_id: String(row.id), role_id: roleId, client_id: clientId,
          completed_at: completedAt, source: SOURCE_POOL, source_id: String(pool.id)
        });
        continue;
      }
    }

    // 4. Metered.
    counters.usage += 1;
    entries.push({
      interview_id: String(row.id), role_id: roleId, client_id: clientId,
      completed_at: completedAt, source: SOURCE_USAGE, source_id: null
    });
  }

  // Interviews charged to a credit that was later revoked are what reduce the
  // reopened role's own remaining — the number rollover_drawn_offset stored.
  const revokedCreditIds = new Set(
    credits.filter((credit) => toIso(credit.revoked_at)).map((credit) => String(credit.id))
  );
  for (const entry of entries) {
    if (entry.source !== SOURCE_CREDIT || !revokedCreditIds.has(String(entry.source_id))) continue;
    const sourceRoleId = String(
      credits.find((credit) => String(credit.id) === String(entry.source_id))?.source_role_id ?? ''
    );
    if (sourceRoleId) roleOf(sourceRoleId).drawn_from_revoked += 1;
  }

  for (const role of (roleRows || [])) {
    const roleId = String(role.id);
    const counters = roleOf(roleId);
    const allowance = allowanceByRole.get(roleId) ?? includedPerRole;
    counters.own_remaining = Math.max(0, allowance - counters.own - counters.drawn_from_revoked);
  }

  let creditBalance = 0;
  for (const credit of credits) {
    if (toIso(credit.revoked_at)) continue;
    const expiresAt = toIso(credit.expires_at);
    if (expiresAt && asOfIso >= expiresAt) continue;
    creditBalance += Math.max(0, credit.quantity - credit.allocated);
  }

  let poolRemaining = 0;
  for (const pool of pools) {
    poolRemaining += Math.max(0, pool.quantity_purchased - pool.allocated);
  }

  const totals = { used: used.length, own: 0, credit: 0, pool: 0, usage: 0, credit_balance: creditBalance, pool_remaining: poolRemaining };
  for (const entry of entries) totals[entry.source] += 1;

  return {
    billing_model: billing.billing_model,
    entries,
    by_role: roleUsage,
    totals,
    credits,
    pools,
    roles: roleRows || [],
    entity_label_by_client: entityLabelById
  };
}

module.exports = {
  SOURCE_CREDIT,
  SOURCE_OWN,
  SOURCE_POOL,
  SOURCE_USAGE,
  allocateInterviews
};
