'use strict';
const { DEMO_CLIENT_ID, uuid } = require('../src/lib/salesDemo');

// Authored presentation data only. No child tenant, invoice, card, user or
// automation object is created at any provider or in the database.
function buildWorkspace() {
  return {
    version: 1, synthetic: true, read_only: true, client_id: DEMO_CLIENT_ID,
    client: { name: 'Northstar Talent Partners - Sales Demo', company: 'Northstar Talent Partners (fictional)', contact: 'Alex Northstar', email: 'alex@northstar.example.invalid', address: '100 Example Way, Demo City, CO 00000' },
    billing: { plan: 'Pro', status: 'Active', interval: 'Monthly', platform_cents: 59900, role_cents: 69900, currency: 'USD', term_start: '2026-10-01', term_end: '2027-09-30', next_bill: '2026-11-01', auto_renew: true,
      payment_method: 'Example Visa ending 4242', agreement: 'Example 12-month membership — no signed agreement exists',
      invoices: [
        { number: 'DEMO-INV-1003', date: '2026-10-01', description: 'Platform membership + two role openings', platform_cents: 59900, role_cents: 139800, total_cents: 199700, status: 'Paid (example)', paid_date: '2026-10-01' },
        { number: 'DEMO-INV-1002', date: '2026-09-01', description: 'Platform membership', platform_cents: 59900, role_cents: 0, total_cents: 59900, status: 'Paid (example)', paid_date: '2026-09-01' },
        { number: 'DEMO-INV-1001', date: '2026-08-01', description: 'Platform membership', platform_cents: 59900, role_cents: 0, total_cents: 59900, status: 'Paid (example)', paid_date: '2026-08-01' },
      ], roles: [ { name: 'Account Executive', used: 3, included: 30 }, { name: 'Customer Support Specialist', used: 3, included: 30 } ] },
    // Entity rows are organizational examples, deliberately NOT selectable
    // client scopes or grants. Real demo records remain on the one root client.
    entities: [
      { name: 'Northstar Central Office', type: 'Office', status: 'Active', contact: 'Alex Northstar', email: 'alex@northstar.example.invalid' },
      { name: 'Northstar Coastal Branch', type: 'Branch', status: 'Active', contact: 'Jamie Harbor', email: 'jamie@northstar.example.invalid' },
      { name: 'Northstar Mountain Office', type: 'Office', status: 'Archived', contact: 'Sam Summit', email: 'sam@northstar.example.invalid' },
    ],
    members: [
      { name: 'Alex Northstar', email: 'alex@northstar.example.invalid', role: 'Manager', entity: 'Parent client', status: 'Active (example)' },
      { name: 'Jamie Harbor', email: 'jamie@northstar.example.invalid', role: 'Manager', entity: 'Northstar Coastal Branch', status: 'Active (example)' },
      { name: 'Sam Summit', email: 'sam@northstar.example.invalid', role: 'Member', entity: 'Parent client', status: 'Invited (example)' },
    ],
    automation: { name: 'Strong candidate review', resume_min: 80, interview_min: 80, overall_min: 85, frequency: 'Daily at 9:00 AM', recipient: 'alex@northstar.example.invalid', action: 'Manager review before any outreach', queue: [
      { candidate_id: uuid(1001), name: 'Avery Morgan', role: 'Account Executive', score: 92, status: 'Awaiting review (example)' },
      { candidate_id: uuid(2001), name: 'Casey Bennett', role: 'Customer Support Specialist', score: 92, status: 'Awaiting review (example)' },
    ] },
    profile: { name: 'Alex Northstar', email: 'alex@northstar.example.invalid', role: 'Manager', timezone: 'America/Denver', notifications: 'Candidate summaries and manager review digests', appearance: 'System default' },
  };
}
module.exports = { buildWorkspace };
