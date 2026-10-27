import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../dist/analyze.js';

const run = code => analyze({ '/app/index.ts': code });
const errors = result => result.diagnostics.filter(d => d.severity === 'error');
const prefix = "import { Sandbox as Box } from '@vercel/sandbox';\n";

test('supported disposable job gets import-only edit, leaving comments and strings intact', () => {
  const result = run(prefix + `// @vercel/sandbox\nconst text = '@vercel/sandbox';\nconst box = await Box.create({ persistent: false, timeout: 5 * 60_000 });\nconst result = await box.runCommand('node', ['--version']);\nconsole.log(await result.stdout());\nawait box.stop();`);
  assert.deepEqual(errors(result), []);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].replacement, 'vercel2daytona');
  assert.ok(result.diagnostics.some(d => d.code === 'V2D_TTL'));
});

test('aliases and namespace references are resolved by binding, without matching shadowed names', () => {
  const result = run(`import * as sdk from '@vercel/sandbox';
const Root = sdk.Sandbox;
const box = await Root.create({ persistent: false });
const alias = box;
await alias.snapshot();
function unrelated(box: { snapshot(): void }) { box.snapshot(); }
`);
  assert.equal(errors(result).length, 1);
  assert.equal(errors(result)[0].code, 'V2D_METHOD');
});

test('blocks persistent default, network transforms, snapshots, image aliases, command timeout and stdin', () => {
  const result = run(prefix + `const box = await Box.create({ image: 'vercel/sandbox/node:22', networkPolicy: { allow: ['example.com'] } });
await box.runCommand({ cmd: 'node', timeoutMs: 1000, stdin: true });
await box.snapshot();`);
  for (const code of ['V2D_PERSISTENCE', 'V2D_NETWORK', 'V2D_IMAGE', 'V2D_OPTION', 'V2D_METHOD']) assert.ok(errors(result).some(d => d.code === code), code);
});

test('detects newer Vercel features and unsupported imported exports', () => {
  const result = run(`import { Sandbox, Drive, Snapshot } from '@vercel/sandbox';
const box = await Sandbox.getOrCreate({ name: 'persistent' });
await box.update({ mounts: {} });
box.currentSession();
box.asUser('root');`);
  assert.equal(errors(result).filter(d => d.code === 'V2D_EXPORT').length, 2);
  assert.equal(errors(result).filter(d => d.code === 'V2D_METHOD').length, 4);
});

test('blocks unknown spread/dynamic/computed/escaped handles and reexports', () => {
  const result = run(prefix + `const box = await Box.create({ ...options, persistent: false });
box['snapshot']();
const { runCommand } = box;
consume(box);
export { Sandbox } from '@vercel/sandbox';`);
  for (const code of ['V2D_DYNAMIC_OPTIONS', 'V2D_COMPUTED', 'V2D_FLOW', 'V2D_REEXPORT']) assert.ok(errors(result).some(d => d.code === code), code);
});

test('blocks CJS, dynamic import and subpath imports without edits', () => {
  for (const code of ["const x = require('@vercel/sandbox');", "const x = await import('@vercel/sandbox');", "import x from '@vercel/sandbox/proxy';", "import x = require('@vercel/sandbox');"]) {
    const result = run(code);
    assert.ok(errors(result).length > 0);
    assert.equal(result.edits.length, 0);
  }
});

test('resolves local const options but rejects fractional/dynamic timeout and stop result', () => {
  const result = run(prefix + `const options = { persistent: false, timeout: 30_000 };
const box = await Box.create(options);
const result = await box.stop();`);
  assert.ok(errors(result).some(d => d.code === 'V2D_TIMEOUT'));
  assert.ok(errors(result).some(d => d.code === 'V2D_STOP_RESULT'));
});

test('checks already migrated imports and source syntax errors', () => {
  assert.ok(errors(run("import { Sandbox } from 'vercel2daytona'; const x = await Sandbox.create({});")).some(d => d.code === 'V2D_PERSISTENCE'));
  assert.ok(errors(run('const x = ;')).some(d => d.code === 'V2D_SYNTAX'));
});

test('blocks browser imports, command constructors, implicit escapes and missing identity', () => {
  const result = run(`'use client';
import { Sandbox, Command } from '@vercel/sandbox';
const create = () => Sandbox.create({ persistent: false });
const box = await Sandbox.get({});
const wrapper = { box: box };
`);
  for (const code of ['V2D_CLIENT_RUNTIME', 'V2D_EXPORT', 'V2D_FLOW', 'V2D_IDENTITY']) assert.ok(errors(result).some(d => d.code === code), code);
});
