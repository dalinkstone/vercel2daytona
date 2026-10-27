import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Daytona, DaytonaNotFoundError } from '@daytona/sdk';
import { createSandboxClass } from '../dist/adapter.js';

export async function runLive(client, config) {
  const Sandbox = createSandboxClass({ client, ...config, publicPreview: true, timeoutRounding: 'ceil' });
  const results = [];
  const check = (name) => { results.push(name); console.log(`PASS ${name}`); };
  let sandbox;
  let expirySandbox;
  let failure;
  try {
    sandbox = await Sandbox.create({ persistent: false, timeout: 300_000, ports: [3000], env: { V2D_TEST: 'sandbox-env' } });
    await sandbox.daytona.refreshData();
    assert.ok(sandbox.expiresAt.getTime() > Date.now());
    check('create with native TTL');

    await sandbox.mkDir('v2d-test');
    const data = Buffer.from([0, 1, 127, 128, 255]);
    await sandbox.writeFiles([{ path: 'v2d-test/binary', content: data, mode: 0o640 }]);
    assert.deepEqual(await sandbox.readFileToBuffer({ path: 'binary', cwd: 'v2d-test' }), data);
    assert.equal(await sandbox.readFileToBuffer({ path: 'v2d-test/missing' }), null);
    const stream = await sandbox.readFile({ path: 'v2d-test/binary' });
    assert.deepEqual(Buffer.from(await new Response(stream).arrayBuffer()), data);
    check('binary files, cwd, missing files and readable stream');

    const args = ['two words', "apostrophe'", '$(printf injected)', '; printf injected', '*', ''];
    const command = await sandbox.runCommand('node', ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),env:process.env.V2D_TEST,stdin:require("fs").readFileSync(0,"utf8")})); console.error("stderr-marker"); process.exitCode=7', '--', ...args]);
    assert.equal(command.exitCode, 7);
    assert.deepEqual(JSON.parse((await command.stdout()).trim()), { args, env: 'sandbox-env', stdin: '' });
    assert.match(await command.stderr(), /stderr-marker/);
    const mode = await sandbox.runCommand('stat', ['-c', '%a', `${config.workdir}/v2d-test/binary`]);
    assert.equal((await mode.stdout()).trim(), '640');
    check('argv quoting, closed stdin, env, file mode, separate streams and nonzero exit');

    const server = await sandbox.runCommand({ cmd: 'node', args: ['-e', 'require("http").createServer((q,s)=>s.end("vercel2daytona-live-ok")).listen(3000,"0.0.0.0")'], detached: true });
    assert.equal(server.exitCode, null);
    const reconnected = await Sandbox.get({ name: sandbox.name });
    const commandHandle = await reconnected.getCommand(server.cmdId);
    assert.equal(commandHandle.exitCode, null);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(reconnected.domain(3000), { signal: AbortSignal.timeout(5000) });
        if (response.ok && (await response.text()) === 'vercel2daytona-live-ok') { ready = true; break; }
      } catch { /* Retry the test server while it starts. */ }
      await delay(1000);
    }
    assert.ok(ready, 'public preview did not become ready');
    check('detached server, sandbox/command reconnect and public HTTP preview');

    const oldExpiry = sandbox.expiresAt.getTime();
    await sandbox.extendTimeout(60_000);
    assert.ok(sandbox.expiresAt.getTime() >= oldExpiry + 59_000);
    check('extend existing deadline');
    const id = sandbox.sandboxId;
    await sandbox.delete();
    sandbox = undefined;
    await assert.rejects(client.get(id), DaytonaNotFoundError);
    check('explicit deletion confirmed');

    // Observe provider expiry using only the native client, not a local adapter timer.
    expirySandbox = await Sandbox.create({ persistent: false, timeout: 60_000 });
    const expiryId = expirySandbox.sandboxId;
    const deadline = Date.now() + 150_000;
    let expired = false;
    while (Date.now() < deadline) {
      try { await client.get(expiryId); }
      catch (error) {
        if (error instanceof DaytonaNotFoundError) { expired = true; break; }
        throw error;
      }
      await delay(5000);
    }
    assert.ok(expired, 'native one-minute TTL did not destroy sandbox within observation budget');
    expirySandbox = undefined;
    check('native expiry without adapter cleanup timer');
    return { passed: results };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = [];
    for (const owned of [sandbox, expirySandbox]) {
      if (!owned) continue;
      try { await owned.delete(); }
      catch (error) { if (!(error instanceof DaytonaNotFoundError)) cleanup.push(error); }
    }
    if (cleanup.length) throw new AggregateError(failure ? [failure, ...cleanup] : cleanup, 'Live verification cleanup failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.DAYTONA_RUN_LIVE !== '1') throw new Error('Set DAYTONA_RUN_LIVE=1 to authorize two short-lived cloud sandboxes');
  if (!process.env.DAYTONA_IMAGE || !process.env.DAYTONA_WORKDIR) throw new Error('DAYTONA_IMAGE and DAYTONA_WORKDIR are required');
  runLive(new Daytona({ otelEnabled: false }), {
    image: process.env.DAYTONA_IMAGE,
    workdir: process.env.DAYTONA_WORKDIR,
    user: process.env.DAYTONA_USER,
  }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
