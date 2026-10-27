import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { applyChanges } from '../dist/cli.js';

const cli = resolve('dist/cli.js');
const source = "import { Sandbox } from '@vercel/sandbox';\nconst box = await Sandbox.create({ persistent: false });\nawait box.delete();\n";
async function project(code = source) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vercel2daytona-test-')));
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@vercel/sandbox': '3.9.0' } }, null, 2) + '\n');
  await writeFile(join(root, 'app.ts'), code);
  await writeFile(join(root, 'package-lock.json'), '{"unchanged":true}\n');
  return root;
}
function invoke(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { ...result, report: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : undefined };
}

test('dry run shows edits, writes nothing; apply creates backups and preserves source dependency/lockfile', async () => {
  const root = await project();
  const before = await readFile(join(root, 'package.json'), 'utf8');
  const preview = invoke('migrate', root, '--json');
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.report.applied, false);
  assert.equal(preview.report.changes.length, 2);
  assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), source);
  const result = invoke('migrate', root, '--write', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.applied, true);
  assert.equal(await readFile(join(root, 'app.ts.vercel2daytona.bak'), 'utf8'), source);
  assert.equal(await readFile(join(root, 'package.json.vercel2daytona.bak'), 'utf8'), before);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@vercel/sandbox'], '3.9.0');
  assert.ok(manifest.dependencies.vercel2daytona.startsWith('file:'));
  assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), '{"unchanged":true}\n');
  assert.equal(invoke('migrate', root, '--write', '--json').report.changes.length, 0);
});

test('one blocker prevents all project writes', async () => {
  const root = await project();
  await writeFile(join(root, 'bad.ts'), "import { Sandbox } from '@vercel/sandbox'; await Sandbox.create({});");
  const result = invoke('migrate', root, '--write', '--json');
  assert.equal(result.status, 1);
  assert.equal(result.report.applied, false);
  assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), source);
  await assert.rejects(lstat(join(root, 'app.ts.vercel2daytona.bak')), { code: 'ENOENT' });
});

test('skips hidden/generated directories and symlinks; strict lint fails on review warnings', async () => {
  const root = await project();
  for (const dir of ['node_modules', '.next', 'dist']) {
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, 'bad.ts'), 'const x = ;');
  }
  await symlink(join(root, 'app.ts'), join(root, 'linked.ts'));
  const result = invoke('lint', root, '--json');
  assert.equal(result.status, 0);
  assert.equal(result.report.files, 1);
  assert.equal(invoke('lint', root, '--strict', '--json').status, 1);
});

test('refuses existing backups and changed files without overwriting them', async () => {
  const root = await project();
  await writeFile(join(root, 'app.ts.vercel2daytona.bak'), 'existing backup');
  assert.equal(invoke('migrate', root, '--write').status, 2);
  assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), source);
  await assert.rejects(applyChanges(root, [{ file: join(root, 'app.ts'), before: 'stale', after: 'new' }]), /changed since analysis/);
});

test('updates nearest workspace manifest only', async () => {
  const root = await project('console.log("root");');
  const child = join(root, 'packages', 'app');
  await mkdir(child, { recursive: true });
  await writeFile(join(child, 'package.json'), '{"name":"child"}\n');
  await writeFile(join(child, 'app.ts'), source);
  const result = invoke('migrate', root, '--json');
  assert.equal(result.status, 0);
  assert.ok(result.report.changes.some(c => c.file === 'packages/app/package.json'));
  assert.ok(!result.report.changes.some(c => c.file === 'package.json'));
});

test('rejects malformed syntax and invalid CLI flags', async () => {
  const root = await project('const x = ;');
  assert.equal(invoke('migrate', root, '--write').status, 1);
  assert.equal(invoke('lint', root, '--write').status, 2);
  assert.equal(invoke('lint', root, '--unknown').status, 2);
});

test('CLI entrypoint works through a package-manager-style symlink', async () => {
  const root = await project();
  const bin = join(root, 'vercel2daytona');
  await symlink(cli, bin);
  const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /vercel2daytona lint/);
});

test('migrates an application that already installed the shared package', async () => {
  const root = await project();
  const manifest = JSON.stringify({ dependencies: { vercel2daytona: 'file:vendor/vercel2daytona-0.1.0.tgz' } });
  await writeFile(join(root, 'package.json'), manifest);
  const result = invoke('migrate', root, '--write', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.changes.length, 1);
  assert.match(await readFile(join(root, 'app.ts'), 'utf8'), /from 'vercel2daytona'/);
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest);
});

test('moves an existing dev-only adapter dependency into runtime dependencies', async () => {
  const root = await project();
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { vercel2daytona: 'file:vendor/adapter.tgz', typescript: '5.9.3' } }));
  const result = invoke('migrate', root, '--write', '--json');
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies.vercel2daytona, 'file:vendor/adapter.tgz');
  assert.equal(manifest.devDependencies.vercel2daytona, undefined);
  assert.equal(manifest.devDependencies.typescript, '5.9.3');
});
