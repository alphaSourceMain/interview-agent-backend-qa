'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browserLaunchOptions } = require('../src/render/browserRuntime');

test('dev uses a fresh local pipe, explicit flags and DNS denial without web security bypass', async () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = 'development';
  try {
    const options = await browserLaunchOptions('/authored/synthetic/browser');
    assert.equal(options.pipe, true);
    assert.equal(options.userDataDir, undefined);
    assert.ok(options.args.includes('--host-resolver-rules=MAP * ~NOTFOUND'));
    assert.ok(options.args.includes('--disable-webgl'));
    assert.ok(!options.args.some(arg => /disable-web-security|allow-running-insecure-content|remote-debugging-address/.test(arg)));
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});
