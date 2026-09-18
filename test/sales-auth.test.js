'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} }
}

const { createRequireSalesRep } = require('../src/middleware/salesAuth')

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

function fakeDb(result) {
  return {
    from(table) {
      assert.equal(table, 'sales_reps')
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() { return result }
      }
    }
  }
}

test('sales authorization requires an authenticated user', async () => {
  const res = responseRecorder()
  await createRequireSalesRep({ db: fakeDb({ data: null, error: null }) })({ user: null }, res, () => assert.fail('next should not run'))
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'authentication_required')
})

test('sales authorization rejects users without an active exact-id roster row', async () => {
  const res = responseRecorder()
  await createRequireSalesRep({ db: fakeDb({ data: null, error: null }) })({ user: { id: 'user-2' } }, res, () => assert.fail('next should not run'))
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'sales_access_denied')
})

test('sales authorization attaches only safe representative fields', async () => {
  const req = { user: { id: 'user-1' } }
  const res = responseRecorder()
  let nextCalled = false
  await createRequireSalesRep({ db: fakeDb({ data: { user_id: 'user-1', email: 'rep@example.com', display_name: 'Rep One', active: true }, error: null }) })(req, res, () => { nextCalled = true })
  assert.equal(nextCalled, true)
  assert.deepEqual(req.salesRep, { user_id: 'user-1', email: 'rep@example.com', display_name: 'Rep One' })
})
