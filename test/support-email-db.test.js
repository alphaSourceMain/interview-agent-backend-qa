const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const exec = promisify(execFile);
const socket = process.env.SUPPORT_EMAIL_TEST_PG_SOCKET;
const args = ['-h', socket || '', '-p', '55473', '-U', 'support_email_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc'];
// Only the disposable socket path can enable this test; no production/QA connection URL accepted.
const disposable = /^\/private\/tmp\/alphascreen-support-email-db\.[a-zA-Z0-9]+$/.test(socket || '');
test('real database concurrent claim commits one winner', { skip: !disposable }, async () => {
  const keys = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
  const query = `set role service_role; select public.claim_support_email_draft('${keys[0]}','${keys[1]}','${keys[2]}');`;
  const results = await Promise.all(Array.from({ length: 8 }, () => exec('/opt/homebrew/bin/psql', [...args, query])));
  assert.equal(results.filter(r => /[a-f0-9]{8}-[a-f0-9-]{27}/.test(r.stdout)).length, 1);
});
for (const role of ['anon', 'authenticated']) {
  test(`${role} cannot read private drafts or claim or inspect membership`, { skip: !disposable }, async () => {
    for (const query of ['select * from private_support_email.drafts', "select public.claim_support_email_draft(repeat('4',64),repeat('5',64),repeat('6',64))", "select public.support_email_confirmed_user('client@example.invalid')"]) {
      await assert.rejects(exec('/opt/homebrew/bin/psql', [...args, `set role ${role}; ${query};`]), error => /permission denied/.test(error.stderr));
    }
  });
}
