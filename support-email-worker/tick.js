'use strict';
const { runRuntime } = require('./src/runtime');
(async () => {
  try {
    if (process.argv.length !== 2) throw Error();
    console.log(JSON.stringify(await runRuntime()));
  } catch (_) { console.error('SUPPORT_EMAIL_RUNTIME_HELD'); process.exitCode = 1; }
})();
