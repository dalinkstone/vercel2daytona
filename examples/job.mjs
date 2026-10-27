import { Sandbox } from '../dist/adapter.js';

// This script creates a billable cloud sandbox only with the explicit gate below.
if (process.env.DAYTONA_RUN_LIVE !== '1') {
  throw new Error('Set DAYTONA_RUN_LIVE=1, DAYTONA_API_KEY, DAYTONA_IMAGE and DAYTONA_WORKDIR to run this live smoke test');
}

const box = await Sandbox.create({ persistent: false, timeout: 300_000 });
let workError;
try {
  const content = Buffer.from([0, 1, 128, 255]);
  await box.writeFiles([{ path: 'vercel2daytona-smoke.bin', content }]);
  const readback = await box.readFileToBuffer({ path: 'vercel2daytona-smoke.bin' });
  if (!readback?.equals(content)) throw new Error('Binary file roundtrip failed');
  const command = await box.runCommand('node', ['-e', 'console.log("daytona-ok"); console.error("stderr-ok"); process.exitCode = 7']);
  if (command.exitCode !== 7 || !(await command.stdout()).includes('daytona-ok') || !(await command.stderr()).includes('stderr-ok')) throw new Error('Command exit/stream contract failed');
  await box.daytona.refreshData();
  if (!(box.expiresAt.getTime() > Date.now())) throw new Error('No future native TTL found');
  console.log('Live binary IO, exit status, stdout/stderr and configured TTL checks passed.');
} catch (error) {
  workError = error;
  throw error;
} finally {
  try { await box.delete(); }
  catch (cleanup) {
    if (workError) throw new AggregateError([workError, cleanup], 'Smoke test and cleanup both failed');
    throw cleanup;
  }
}
