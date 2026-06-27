'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildClientScopeContext,
  canCreateRolesForClient,
  canManageMembersForClient,
  canViewLegalBillingForClient,
} = require('../src/lib/clientScope');

test('manager parent membership gets retail buyer dashboard permissions and child scope', () => {
  const context = buildClientScopeContext({
    memberships: [{
      client_id: 'parent-client',
      role: 'manager',
      client: { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
    }],
    clients: [
      { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
      { id: 'child-client', name: 'Retail Location', parent_client_id: 'parent-client', entity_label: 'location' },
    ],
  });

  assert.deepEqual(context.accessibleClientIds.sort(), ['child-client', 'parent-client']);
  assert.equal(canCreateRolesForClient(context, 'parent-client'), true);
  assert.equal(canManageMembersForClient(context, 'parent-client'), true);
  assert.equal(canViewLegalBillingForClient(context, 'parent-client'), true);
  assert.equal(context.permissionsByClientId['parent-client'].can_manage_members, true);
  assert.equal(context.permissionsByClientId['parent-client'].can_view_legal_billing, true);
  assert.equal(context.permissionsByClientId['child-client'].can_create_roles, true);
});

test('regular member remains limited in dashboard permissions', () => {
  const context = buildClientScopeContext({
    memberships: [{
      client_id: 'parent-client',
      role: 'member',
      client: { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
    }],
    clients: [
      { id: 'parent-client', name: 'Retail Buyer', parent_client_id: null },
      { id: 'child-client', name: 'Retail Location', parent_client_id: 'parent-client', entity_label: 'location' },
    ],
  });

  assert.deepEqual(context.accessibleClientIds, ['parent-client']);
  assert.equal(canCreateRolesForClient(context, 'parent-client'), false);
  assert.equal(canManageMembersForClient(context, 'parent-client'), false);
  assert.equal(canViewLegalBillingForClient(context, 'parent-client'), false);
  assert.equal(context.permissionsByClientId['parent-client'].can_manage_members, false);
  assert.equal(context.permissionsByClientId['parent-client'].can_view_legal_billing, false);
});
