'use strict';
// Operator metadata command. Never opens a secret, refreshes a grant or connects.
const fs = require('node:fs');
const { PATHS } = require('./src/runtime-config');
const { getRuntimeProfile } = require('./src/runtime-profile');
try {
  if (process.argv.length !== 2 || process.platform !== 'linux' || process.env.RENDER !== 'true' || process.env.SUPPORT_EMAIL_WORKER_ENABLED !== 'false') throw Error();
  const profile = getRuntimeProfile(process.env);
  if (process.env.RENDER_SERVICE_NAME !== profile.name || process.env.SUPABASE_URL !== profile.url) throw Error();
  if (process.env.SUPPORT_EMAIL_SECRET_LAYOUT === 'render-projected-v1') {
    const manifest = require('./src/projected-mounts').inspectProjectedMounts();
    console.log(JSON.stringify({ status: 'metadata_only', layout: 'render-projected-v1', manifest }));
  } else {
  const manifest = {};
  const metadata = [];
  let held = false;
  for (const dir of ['/etc', '/etc/secrets']) {
    const s = fs.lstatSync(dir);
    metadata.push({ name: dir, uid: s.uid, mode: (s.mode & 0o7777).toString(8), directory: s.isDirectory(), symlink: s.isSymbolicLink() });
    if (!s.isDirectory() || s.isSymbolicLink() || ![0, process.getuid()].includes(s.uid) || (s.mode & 0o022)) held = true;
  }
  for (const [key, file] of Object.entries(PATHS)) {
    const s = fs.lstatSync(file);
    metadata.push({ name: key, uid: s.uid, mode: (s.mode & 0o7777).toString(8), regular: s.isFile(), symlink: s.isSymbolicLink(), links: s.nlink, bounded: s.size>=2 && s.size<=32768 });
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || ![0, process.getuid()].includes(s.uid) || ![0o400,0o600,0o444,0o644].includes(s.mode & 0o7777) || s.size<2 || s.size>32768) held = true;
    manifest[key] = { uid: s.uid, mode: (s.mode & 0o7777).toString(8).padStart(4, '0') };
  }
  if (held) { console.log(JSON.stringify({ status: 'metadata_held', process_uid: process.getuid(), metadata })); throw Error(); }
  console.log(JSON.stringify({ status: 'metadata_only', manifest }));
  }
} catch (_) { console.error('SUPPORT_EMAIL_MOUNT_INSPECTION_HELD'); process.exitCode = 1; }
