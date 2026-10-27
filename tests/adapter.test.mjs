import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DaytonaFileNotFoundError, DaytonaNotFoundError } from '@daytona/sdk';
import { createSandboxClass, CompatibilityError } from '../dist/adapter.js';

function fixture(overrides = {}, config = {}) {
  const calls = [];
  const box = {
    id: 'daytona-id', name: 'test', state: 'started', public: false,
    autoDestroyAt: new Date(Date.now() + 300_000).toISOString(), labels: {},
    process: {
      async createSession(id) { calls.push(['session', id]); },
      async executeSessionCommand(id, request) { calls.push(['exec', id, request]); return { cmdId: 'command' }; },
      async getSessionCommand() { calls.push(['poll']); return { exitCode: 0 }; },
      async getSessionCommandLogs() { calls.push(['logs']); return { stdout: 'out\n', stderr: 'err\n', output: 'out\nerr\n' }; },
    },
    fs: {
      async uploadFiles(files) { calls.push(['upload', files]); },
      async downloadFile(path) { calls.push(['download', path]); return Buffer.from([0, 128, 255]); },
      async createFolder(...args) { calls.push(['mkdir', ...args]); },
      async setFilePermissions(...args) { calls.push(['chmod', ...args]); },
    },
    async getPreviewLink(port) { return { url: `https://preview.invalid/${port}` }; },
    async delete(...args) { calls.push(['delete', ...args]); },
    async refreshData() {},
    async setTtl(value) { calls.push(['ttl', value]); this.autoDestroyAt = new Date(Date.now() + value * 60_000).toISOString(); },
    ...overrides,
  };
  const client = {
    async create(params, options) { calls.push(['create', params, options]); box.labels = params.labels; box.public = params.public; return box; },
    async get(name) { calls.push(['get', name]); return box; },
  };
  const Sandbox = createSandboxClass({ image: 'node:22-bookworm', workdir: '/tmp', client, ...config });
  return { Sandbox, calls, box };
}

test('maps default disposable lifetime to native TTL, never idle auto-stop', async () => {
  const { Sandbox, calls } = fixture();
  const box = await Sandbox.create({ persistent: false, name: 'job', env: { X: 'y' }, resources: { vcpus: 3 }, networkPolicy: 'deny-all' });
  const params = calls[0][1];
  assert.equal(params.ttlMinutes, 5);
  assert.equal(params.autoStopInterval, 0);
  assert.equal(params.autoDeleteInterval, 0);
  assert.equal(params.ephemeral, true);
  assert.equal(params.networkBlockAll, true);
  assert.equal(params.public, false);
  assert.deepEqual(params.resources, { cpu: 3, memory: 6, disk: 10 });
  assert.deepEqual(calls[0][2], { timeout: 60 });
  assert.equal(box.sandboxId, 'daytona-id');
});

test('rejects unsupported or invalid creation before any cloud call', async () => {
  for (const options of [
    {}, { persistent: true }, { persistent: false, source: { type: 'git' } },
    { persistent: false, networkPolicy: { allow: ['example.com'] } },
    { persistent: false, ports: [3000] }, { persistent: false, timeout: 1 },
    { persistent: false, timeout: 0 }, { persistent: false, timeout: NaN },
    { persistent: false, image: 'vercel/sandbox/node:22' },
    { persistent: false, resources: { vcpus: 0 } },
    { persistent: false, ports: '3000' }, { persistent: false, env: { X: 1 } },
    { persistent: false, signal: new AbortController().signal },
  ]) {
    const { Sandbox, calls } = fixture();
    await assert.rejects(Sandbox.create(options), CompatibilityError);
    assert.equal(calls.length, 0);
  }
});

test('explicit image mapping and public preview opt-in', async () => {
  const { Sandbox, calls } = fixture({}, { images: { node22: 'node:22-bookworm' }, publicPreview: true });
  const box = await Sandbox.create({ persistent: false, runtime: 'node22', ports: [3000] });
  assert.equal(calls[0][1].image, 'node:22-bookworm');
  assert.equal(box.domain(3000), 'https://preview.invalid/3000');
  assert.throws(() => box.domain(8000), CompatibilityError);
  const attached = await Sandbox.get({ name: 'test' });
  assert.equal(attached.domain(3000), box.domain(3000));
});

test('command argv survives real shell evaluation without injection, with closed stdin', async () => {
  const { Sandbox, calls } = fixture();
  const box = await Sandbox.create({ persistent: false });
  const args = ['spaces and \'quotes\'', '$(printf injected)', '`printf injected`', '; printf injected', '*', '', '--flag'];
  const result = await box.runCommand({ cmd: process.execPath, args: ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),stdin:require("node:fs").readFileSync(0,"utf8")}))', '--', ...args] });
  const command = calls.find(c => c[0] === 'exec')[2].command;
  const actual = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), { args, stdin: '' });
  assert.equal(calls.find(c => c[0] === 'exec')[2].suppressInputEcho, true);
  assert.equal(result.exitCode, 0);
});

test('preserves nonzero exit and separate streams, with shared concurrent collection', async () => {
  const { Sandbox, box, calls } = fixture();
  box.process.getSessionCommand = async () => ({ exitCode: 7 });
  const sandbox = await Sandbox.create({ persistent: false });
  const cmd = await sandbox.runCommand('node', ['--version']);
  assert.equal(cmd.exitCode, 7);
  assert.deepEqual(await Promise.all([cmd.stdout(), cmd.stderr(), cmd.output()]), ['out\n', 'err\n', 'out\nerr\n']);
  assert.equal(calls.filter(c => c[0] === 'logs').length, 1);
  await assert.rejects(cmd.stdout({ signal: new AbortController().signal }), CompatibilityError);
});

test('detached command returns before polling; can reconnect using its command id', async () => {
  const { Sandbox, calls } = fixture();
  const box = await Sandbox.create({ persistent: false });
  const cmd = await box.runCommand({ cmd: 'node', args: ['server.js'], detached: true });
  assert.equal(cmd.exitCode, null);
  assert.equal(calls.filter(c => c[0] === 'poll').length, 0);
  const attached = await box.getCommand(cmd.cmdId);
  assert.equal(await attached.stdout(), 'out\n');
  await assert.rejects(box.getCommand('vercel-command-id'), CompatibilityError);
});

test('rejects command options instead of ignoring security/timeout/stdio semantics', async () => {
  const { Sandbox, calls } = fixture();
  const box = await Sandbox.create({ persistent: false });
  for (const option of ['timeoutMs', 'signal', 'sudo', 'stdin', 'stdout', 'stderr']) await assert.rejects(box.runCommand({ cmd: 'node', [option]: true }), CompatibilityError);
  await assert.rejects(box.runCommand({ cmd: 'node', env: { 'INVALID-KEY': 'x' } }), CompatibilityError);
  await assert.rejects(box.runCommand('node', ['bad\0arg']), CompatibilityError);
  assert.equal(calls.length, 1);
});

test('binary file IO, cwd, mode and typed missing-file behavior', async () => {
  const { Sandbox, box, calls } = fixture();
  const sandbox = await Sandbox.create({ persistent: false });
  const content = Buffer.from([0, 128, 255]);
  await sandbox.writeFiles([{ path: 'blob', content, mode: 0o640 }]);
  assert.deepEqual(calls.find(c => c[0] === 'upload')[1], [{ source: content, destination: '/tmp/blob' }]);
  assert.deepEqual(calls.find(c => c[0] === 'chmod'), ['chmod', '/tmp/blob', { mode: '640' }]);
  assert.deepEqual(await sandbox.readFileToBuffer({ path: 'blob', cwd: 'nested' }), content);
  assert.equal(calls.at(-1)[1], '/tmp/nested/blob');
  assert.deepEqual(Buffer.from(await new Response(await sandbox.readFile({ path: 'blob' })).arrayBuffer()), content);
  box.fs.downloadFile = async () => { throw new DaytonaFileNotFoundError('missing'); };
  assert.equal(await sandbox.readFileToBuffer({ path: 'missing' }), null);
  box.fs.downloadFile = async () => { throw new DaytonaNotFoundError('sandbox missing'); };
  await assert.rejects(sandbox.readFileToBuffer({ path: 'missing' }), DaytonaNotFoundError);
});

test('cleanup waits for deletion, is idempotent, blocks reuse, and retries failure', async () => {
  const { Sandbox, calls, box } = fixture();
  const sandbox = await Sandbox.create({ persistent: false });
  const remove = box.delete;
  box.delete = async () => { throw new Error('cleanup failed'); };
  await assert.rejects(sandbox.delete(), /cleanup failed/);
  box.delete = remove;
  await Promise.all([sandbox.stop(), sandbox.delete()]);
  assert.deepEqual(calls.filter(c => c[0] === 'delete'), [['delete', 60, true]]);
  await sandbox.delete();
  await assert.rejects(sandbox.runCommand('node'), CompatibilityError);
});

test('setup errors clean up and preserve a second cleanup failure', async () => {
  const first = new Error('preview failed');
  const second = new Error('delete failed');
  const { Sandbox } = fixture({ async getPreviewLink() { throw first; }, async delete() { throw second; } }, { publicPreview: true });
  await assert.rejects(Sandbox.create({ persistent: false, ports: [3000] }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second]);
    return true;
  });
});

test('TTL rounding is opt-in; extension adds to old expiry, serializes local calls', async () => {
  const { Sandbox, calls } = fixture({}, { timeoutRounding: 'ceil' });
  const box = await Sandbox.create({ persistent: false, timeout: 60_001 });
  assert.equal(calls[0][1].ttlMinutes, 2);
  await Promise.all([box.extendTimeout(120_000), box.extendTimeout(60_000)]);
  const values = calls.filter(c => c[0] === 'ttl').map(c => c[1]);
  assert.equal(values[0], 7);
  assert.equal(values[1], 8);
});

test('reconnect refuses unrelated or stopped sandboxes and legacy provider ids', async () => {
  const { Sandbox, box } = fixture();
  await assert.rejects(Sandbox.get({ sandboxId: 'legacy' }), CompatibilityError);
  await assert.rejects(Sandbox.get({ name: 'unrelated' }), CompatibilityError);
  await Sandbox.create({ persistent: false });
  box.state = 'stopped';
  await assert.rejects(Sandbox.get({ name: 'test' }), /not running/);
});
