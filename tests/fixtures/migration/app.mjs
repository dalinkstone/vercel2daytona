import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Sandbox } from '@vercel/sandbox';

const sandbox = await Sandbox.create({
  // Provider-specific authentication: remove these three fields when migrating.
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
  name: process.env.V2D_SANDBOX_NAME,
  persistent: false,
  timeout: 300_000,
  ports: [3000],
  env: { REPORT_LABEL: 'migration-demo' },
});

let failure;
try {
  const inspect = await sandbox.runCommand('node', ['-e', 'console.log(JSON.stringify({workdir:process.cwd(),node:process.version}))']);
  assert.equal(inspect.exitCode, 0);
  const environment = JSON.parse(await inspect.stdout());
  assert.ok(environment.workdir.startsWith('/'));
  const jobdir = `${environment.workdir}/report-job`;
  const orders = [
    { sku: 'book', quantity: 2, unitCents: 1200 },
    { sku: 'pen', quantity: 3, unitCents: 250 },
    { sku: 'book', quantity: 1, unitCents: 1500 },
  ];
  const expected = {
    label: 'migration-demo', orders: 3, revenueCents: 4650,
    items: [
      { sku: 'book', units: 3, revenueCents: 3900 },
      { sku: 'pen', units: 3, revenueCents: 750 },
    ],
  };
  const binary = Buffer.from([0, 1, 127, 128, 255]);
  await sandbox.mkDir(jobdir);
  await sandbox.writeFiles([
    { path: `${jobdir}/worker.mjs`, content: await readFile(new URL('./worker.mjs', import.meta.url)) },
    { path: `${jobdir}/orders.json`, content: Buffer.from(JSON.stringify(orders)), mode: 0o640 },
    { path: `${jobdir}/binary`, content: binary },
  ]);
  assert.deepEqual(await sandbox.readFileToBuffer({ path: 'binary', cwd: jobdir }), binary);
  assert.equal(await sandbox.readFileToBuffer({ path: `${jobdir}/missing` }), null);

  const build = await sandbox.runCommand({ cmd: 'node', args: ['worker.mjs', 'build'], cwd: jobdir });
  assert.equal(build.exitCode, 0);
  const stdout = await build.stdout();
  const stderr = await build.stderr();
  assert.deepEqual(JSON.parse(stdout), expected);
  assert.equal(stderr, 'report-built\n');
  const file = await sandbox.readFileToBuffer({ path: 'report.json', cwd: jobdir });
  assert.deepEqual(JSON.parse(file.toString()), expected);
  const mode = await sandbox.runCommand('stat', ['-c', '%a', `${jobdir}/orders.json`]);
  assert.equal(mode.exitCode, 0);
  assert.equal((await mode.stdout()).trim(), '640');

  const args = ['two words', "apostrophe'", '$(printf injected)', '; printf injected', '*', ''];
  const literal = await sandbox.runCommand('node', ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),stdin:require("fs").readFileSync(0,"utf8")}))', '--', ...args]);
  assert.equal(literal.exitCode, 0);
  const literalOutput = JSON.parse(await literal.stdout());
  assert.deepEqual(literalOutput, { args, stdin: '' });
  const rejected = await sandbox.runCommand({ cmd: 'node', args: ['worker.mjs', 'invalid'], cwd: jobdir });
  assert.equal(rejected.exitCode, 7);
  const rejectedStderr = await rejected.stderr();
  assert.equal(rejectedStderr, 'expected build or serve\n');

  const server = await sandbox.runCommand({ cmd: 'node', args: ['worker.mjs', 'serve'], cwd: jobdir, detached: true });
  assert.equal(server.exitCode, null);
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const candidate = await fetch(`${sandbox.domain(3000)}/report`, { signal: AbortSignal.timeout(5000) });
      if (candidate.ok) { response = candidate; break; }
      await candidate.body?.cancel();
    } catch { /* The provider route and process can take a moment to become ready. */ }
    await delay(1000);
  }
  assert.ok(response, 'HTTP report endpoint did not become ready');
  const httpReport = await response.json();
  assert.deepEqual(httpReport, expected);
  const missing = await fetch(`${sandbox.domain(3000)}/missing`, { signal: AbortSignal.timeout(5000) });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not found' });
  console.log(JSON.stringify({ environment, result: {
    report: expected, stdout, stderr, rejectedExitCode: rejected.exitCode, rejectedStderr,
    binaryHex: binary.toString('hex'), fileMode: '640', literalOutput,
    reportSha256: createHash('sha256').update(file).digest('hex'),
    httpStatus: response.status, httpReport, missingStatus: missing.status,
  } }));
} catch (error) {
  failure = error;
  throw error;
} finally {
  try { await sandbox.delete(); }
  catch (cleanup) { throw new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Program cleanup failed'); }
}
