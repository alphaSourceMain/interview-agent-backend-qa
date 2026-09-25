'use strict';

// The Enterprise interview pool.
//
// An Enterprise client buys a block of interviews at signup, and every role
// under that client or any of its child entities draws from the same pool. The
// pool belongs to whoever pays, so a child's interview spends the parent's pool
// — the same direction usage billing rolls (see usageBilling.loadBillingFamily).
//
// Running out never blocks anyone: once the pool is empty an interview is simply
// metered at the client's usage price instead. That is why nothing here refuses
// a draw as an error — "no pool left" is an ordinary answer.

const PAID_STATUS = 'paid';

// A conditional decrement can lose to a concurrent draw on the same pool. One
// extra pass over freshly read pools absorbs that without spinning.
const DRAW_PASSES = 2;

function isUniqueViolation(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  return code === '23505' || message.includes('duplicate key value');
}

function parseWholeNonNegative(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function nowIso(now) {
  if (!now) return new Date().toISOString();
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/**
 * Paid pools with interviews left, oldest first so the earliest purchase is
 * spent before a later one.
 */
async function listAvailablePools({ db, billingClientId } = {}) {
  if (!db || !billingClientId) return [];
  const { data, error } = await db
    .from('client_interview_pools')
    .select('id,client_id,quantity_purchased,quantity_remaining,unit_price_cents,discount_pct,total_cents,paid_at,created_at')
    .eq('client_id', billingClientId)
    .eq('status', PAID_STATUS)
    .gt('quantity_remaining', 0)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message || 'Interview pool list failed');
  return data || [];
}

/** How many interviews the client has left across every paid pool. */
async function getPoolRemaining({ db, billingClientId } = {}) {
  const pools = await listAvailablePools({ db, billingClientId });
  let remaining = 0;
  for (const pool of pools) {
    const value = parseWholeNonNegative(pool?.quantity_remaining);
    if (value != null) remaining += value;
  }
  return remaining;
}

async function findDrawForInterview(db, interviewId) {
  const { data, error } = await db
    .from('client_interview_pool_draws')
    .select('id,pool_id,interview_id')
    .eq('interview_id', interviewId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Interview pool draw lookup failed');
  return data || null;
}

/**
 * Takes one interview from the client's pool.
 *
 * `billingClientId` is the payer — the parent when the role belongs to a child.
 * `clientId` and `roleId` are the role's own, recorded on the draw so the pool
 * can be reported per entity and per role later.
 *
 * The decrement is conditional on the value that was read, so a concurrent draw
 * loses rather than over-spending the pool.
 */
async function drawFromPool({ db, billingClientId, clientId, roleId, interviewId, now } = {}) {
  if (!db || !billingClientId || !roleId || !interviewId) {
    return { drawn: false, reason: 'invalid_request' };
  }

  const existingDraw = await findDrawForInterview(db, interviewId);
  if (existingDraw) {
    return { drawn: false, reason: 'already_drawn', pool_id: existingDraw.pool_id };
  }

  let sawContention = false;
  for (let pass = 0; pass < DRAW_PASSES; pass += 1) {
    const pools = await listAvailablePools({ db, billingClientId });
    if (!pools.length) return { drawn: false, reason: 'no_pool' };

    sawContention = false;
    for (const pool of pools) {
      const remaining = parseWholeNonNegative(pool.quantity_remaining);
      if (remaining == null || remaining <= 0) continue;

      const drawnAt = nowIso(now);
      const { data: decremented, error: decrementError } = await db
        .from('client_interview_pools')
        .update({ quantity_remaining: remaining - 1 })
        .eq('id', pool.id)
        .eq('quantity_remaining', remaining)
        .eq('status', PAID_STATUS)
        .select('id')
        .maybeSingle();
      if (decrementError) throw new Error(decrementError.message || 'Interview pool draw failed');
      if (!decremented) {
        // Someone else moved this pool between the read and the write.
        sawContention = true;
        continue;
      }

      const { error: drawError } = await db
        .from('client_interview_pool_draws')
        .insert({
          pool_id: pool.id,
          client_id: clientId || billingClientId,
          role_id: roleId,
          interview_id: interviewId,
          drawn_at: drawnAt
        });

      if (drawError) {
        // The interview was drawn for concurrently. Give the unit straight back
        // rather than leaving the client short.
        await db
          .from('client_interview_pools')
          .update({ quantity_remaining: remaining })
          .eq('id', pool.id)
          .eq('quantity_remaining', remaining - 1);
        if (isUniqueViolation(drawError)) {
          return { drawn: false, reason: 'already_drawn', pool_id: pool.id };
        }
        throw new Error(drawError.message || 'Interview pool draw failed');
      }

      return { drawn: true, pool_id: pool.id, remaining: remaining - 1 };
    }

    if (!sawContention) break;
  }

  return { drawn: false, reason: sawContention ? 'contended' : 'no_pool' };
}

/**
 * Marks a pool paid and makes its interviews spendable.
 *
 * Conditional on the row still being pending, so a redelivered Stripe event
 * cannot refill a pool that has already been drawn down.
 */
async function markPoolPaid({ db, poolId, stripePaymentIntentId, now } = {}) {
  if (!db || !poolId) return { paid: false, reason: 'invalid_request' };

  const { data: pool, error: lookupError } = await db
    .from('client_interview_pools')
    .select('id,client_id,quantity_purchased,quantity_remaining,status')
    .eq('id', poolId)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message || 'Interview pool lookup failed');
  if (!pool) return { paid: false, reason: 'not_found' };
  if (String(pool.status) === PAID_STATUS) return { paid: false, reason: 'already_paid', pool };

  const paidAt = nowIso(now);
  const { data: updated, error: updateError } = await db
    .from('client_interview_pools')
    .update({
      status: PAID_STATUS,
      quantity_remaining: pool.quantity_purchased,
      stripe_payment_intent_id: stripePaymentIntentId || null,
      paid_at: paidAt
    })
    .eq('id', poolId)
    .eq('status', 'pending')
    .select('id,client_id,quantity_purchased,quantity_remaining')
    .maybeSingle();
  if (updateError) throw new Error(updateError.message || 'Interview pool paid update failed');
  if (!updated) return { paid: false, reason: 'not_pending' };

  return { paid: true, pool: updated };
}

/** Marks a pool failed. Only a pending pool can fail. */
async function markPoolFailed({ db, poolId } = {}) {
  if (!db || !poolId) return { failed: false, reason: 'invalid_request' };
  const { data, error } = await db
    .from('client_interview_pools')
    .update({ status: 'failed' })
    .eq('id', poolId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message || 'Interview pool failed update failed');
  return { failed: !!data };
}

module.exports = {
  PAID_STATUS,
  drawFromPool,
  getPoolRemaining,
  listAvailablePools,
  markPoolFailed,
  markPoolPaid
};
