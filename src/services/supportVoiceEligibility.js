'use strict';

const { normalizePlanTier } = require('./billingModel');
const { DEMO_CLIENT_ID } = require('./salesDemo');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INHERITED_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);

function validScopeId(value) { return typeof value === 'string' && UUID.test(value); }
async function one(db, table, columns, key, value) {
  const result = await db.from(table).select(columns).eq(key, value).maybeSingle();
  if (result.error) throw new Error('SUPPORT_VOICE_SCOPE_LOOKUP');
  return result.data;
}
async function memberships(db, userId) {
  let result = await db.from('client_members').select('client_id,role').eq('user_id_uuid', userId);
  if (result.error?.code === '42703') result = await db.from('client_members').select('client_id,role').eq('user_id', userId);
  if (result.error || !Array.isArray(result.data)) throw new Error('SUPPORT_VOICE_MEMBERSHIP_LOOKUP');
  return result.data;
}

// Re-read trusted Auth identity, membership and the selected scope on every check.
// An Essential scope cannot borrow eligibility from another Pro membership.
async function checkScope({ serviceDb, userId, clientId }) {
  if (!validScopeId(userId) || !validScopeId(clientId) || clientId === DEMO_CLIENT_ID) return false;
  try {
    const auth = await serviceDb.auth.admin.getUserById(userId);
    const user = auth.data?.user;
    if (auth.error || !user || user.id !== userId || user.app_metadata?.sales_demo_client_id ||
        (user.banned_until && Date.parse(user.banned_until) > Date.now())) return false;
    const selected = await one(serviceDb, 'clients', 'id,parent_client_id,archived_at', 'id', clientId);
    if (!selected || selected.archived_at || selected.id === DEMO_CLIENT_ID) return false;
    const owner = selected.parent_client_id
      ? await one(serviceDb, 'clients', 'id,parent_client_id,archived_at', 'id', selected.parent_client_id)
      : selected;
    if (!owner || owner.archived_at || owner.parent_client_id || owner.id === DEMO_CLIENT_ID) return false;
    let admin = await one(serviceDb, 'admins', 'id,is_active', 'user_id', userId);
    if (!admin && user.email) admin = await one(serviceDb, 'admins', 'id,is_active', 'email', user.email);
    if (admin?.is_active !== true) {
      const grants = await memberships(serviceDb, userId);
      const authorized = grants.some(grant => grant.client_id === clientId ||
        (selected.parent_client_id && grant.client_id === owner.id && INHERITED_ROLES.has(String(grant.role).trim().toLowerCase().replace(/[ -]+/g, '_'))));
      if (!authorized) return false;
    }
    const settings = await one(serviceDb, 'client_plan_settings', 'plan_tier', 'client_id', owner.id);
    return ['pro', 'enterprise'].includes(normalizePlanTier(settings?.plan_tier));
  } catch { return false; }
}

async function supportVoiceEligible(scope) {
  let timer;
  try {
    return await Promise.race([
      checkScope(scope),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { supportVoiceEligible, validScopeId };
