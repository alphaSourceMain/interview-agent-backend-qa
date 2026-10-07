// Owner-operated local command. No app/start/cron wiring, no automatic browser launch.
const { loadClient, prepareStore, createInstaller, listenInstaller } = require('../src/lib/supportEmailInstaller');
async function main() {
  if (process.argv.length !== 4) throw new Error('CONFIG');
  const clientPath = process.argv[2], destination = process.argv[3];
  const client = loadClient(clientPath, process.env);
  // Production credential destination is intentionally not supported.
  if (destination !== '/Users/jasongardner/Downloads/alphy-support-qa/grant.json') throw new Error('CONFIG');
  prepareStore(destination);
  const installer = createInstaller({ env: process.env, client, destination });
  const listener = await listenInstaller(installer);
  const stop = () => listener.close();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stdout.write(installer.bootstrapUrl + '\n');
  const status = await listener.done;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  process.stdout.write((status === 'CONNECTED' ? 'STORED' : status === 'REVOKE_UNCONFIRMED' ? status : 'FAILED') + '\n');
  if (status !== 'CONNECTED') process.exitCode = 1;
}
if (require.main === module) main().catch(() => { process.stderr.write('QA connection could not start. Check the reviewed configuration; no credential details are logged.\n'); process.exitCode = 1; });
module.exports = { main };
