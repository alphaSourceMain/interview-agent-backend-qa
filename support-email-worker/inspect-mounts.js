'use strict';
// Operator metadata command. Never opens a secret, refreshes a grant or connects.
const fs = require('node:fs');
const { NAME, PATHS } = require('./src/runtime-config');
try {
  if (process.argv.length !== 2 || process.platform !== 'linux' || process.env.RENDER !== 'true' || process.env.RENDER_SERVICE_NAME !== NAME || process.env.SUPPORT_EMAIL_WORKER_ENABLED !== 'false') throw Error();
  const manifest = {};
  for (const dir of ['/etc', '/etc/secrets']) {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || ![0, process.getuid()].includes(s.uid) || (s.mode & 0o022)) throw Error();
  }
  for (const [key, file] of Object.entries(PATHS)) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || ![0, process.getuid()].includes(s.uid) || ![0o400,0o600,0o444,0o644].includes(s.mode & 0o7777) || s.size<2 || s.size>32768) throw Error();
    manifest[key] = { uid: s.uid, mode: (s.mode & 0o7777).toString(8).padStart(4, '0') };
  }
  console.log(JSON.stringify({ status: 'metadata_only', manifest }));
} catch (_) { console.error('SUPPORT_EMAIL_MOUNT_INSPECTION_HELD'); process.exitCode = 1; }
