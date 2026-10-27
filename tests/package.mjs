import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'vercel2daytona-package-')));
const consumer = join(temporary, 'consumer');
await mkdir(consumer);
const npm = (args, cwd) => execFileSync('npm', args, {
  cwd, encoding: 'utf8', timeout: 180_000,
  env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_git: '/usr/bin/false', npm_config_audit: 'false', npm_config_fund: 'false' },
});
const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
assert.ok(packed.files.some(file => file.path === 'dist/cli.js'));
assert.ok(packed.files.some(file => file.path === '.env.example'));
assert.ok(packed.files.some(file => file.path === 'skills/vercel2daytona/SKILL.md'));
assert.ok(packed.files.some(file => file.path === 'skills/vercel2daytona/references/migration.md'));
assert.ok(packed.files.some(file => file.path === 'examples/job.py'));
assert.ok(packed.files.every(file => !/\b__pycache__\b|\.pyc$/.test(file.path)));
assert.ok(packed.files.every(file => !file.path.startsWith('node_modules/') && file.path !== '.env'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'package-consumer', private: true, type: 'module' }));
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--git=/usr/bin/false', join(temporary, packed.filename)], consumer);
const cli = join(consumer, 'node_modules', '.bin', 'vercel2daytona');
assert.match(execFileSync(cli, ['--help'], { cwd: consumer, encoding: 'utf8' }), /vercel2daytona lint/);
const source = "import { Sandbox } from '@vercel/sandbox';\nconst box = await Sandbox.create({ persistent: false });\nawait box.delete();\n";
await writeFile(join(consumer, 'app.mjs'), source);
const before = JSON.parse(execFileSync(cli, ['migrate', consumer, '--json'], { cwd: consumer, encoding: 'utf8' }));
assert.equal(before.blocked, false);
assert.equal(await readFile(join(consumer, 'app.mjs'), 'utf8'), source);
execFileSync(cli, ['migrate', consumer, '--write'], { cwd: consumer, stdio: 'pipe' });
assert.match(await readFile(join(consumer, 'app.mjs'), 'utf8'), /from 'vercel2daytona'/);
assert.equal(await readFile(join(consumer, 'app.mjs.vercel2daytona.bak'), 'utf8'), source);
execFileSync(process.execPath, ['--input-type=module', '-e', 'import { Sandbox, createSandboxClass } from "vercel2daytona"; if (typeof Sandbox.create !== "function" || typeof createSandboxClass !== "function") throw new Error("missing exports");'], { cwd: consumer, stdio: 'pipe' });
await writeFile(join(consumer, 'types.mts'), (await readFile(join(root, 'tests/types.mts'), 'utf8')).replace('../dist/adapter.js', 'vercel2daytona'));
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--lib', 'ES2023,DOM,ESNext.Disposable', 'types.mts'], { cwd: consumer, stdio: 'pipe' });
const guide = await readFile(join(consumer, 'node_modules/vercel2daytona/skills/vercel2daytona/references/typescript.md'), 'utf8');
for (const [index, match] of [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].entries()) {
  const file = `skill-example-${index}.mts`;
  await writeFile(join(consumer, file), match[1]);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--lib', 'ES2023,DOM,ESNext.Disposable', file], { cwd: consumer, stdio: 'pipe' });
}
console.log('PASS packed installation, executable, migration preview/apply, ESM exports, consumer types and skill example');
