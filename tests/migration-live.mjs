import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona, DaytonaNotFoundError } from '@daytona/sdk';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const authFields = ['token', 'teamId', 'projectId'];
export function removeVercelAuthentication(source) {
  for (const [field, variable] of [['token', 'VERCEL_TOKEN'], ['teamId', 'VERCEL_TEAM_ID'], ['projectId', 'VERCEL_PROJECT_ID']]) {
    const line = `  ${field}: process.env.${variable},\n`;
    assert.equal(source.split(line).length, 2, `Expected one explicit ${field} field`);
    source = source.replace(line, '');
  }
  return source;
}

// Keep provider credentials out of installation hooks, opposite-provider runs and reports.
function environment(provider) {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    if (key.startsWith('VERCEL_')) return provider === 'vercel';
    if (key.startsWith('DAYTONA_')) return provider === 'daytona';
    return true;
  }));
}

export async function runMigration() {
  if (process.env.DAYTONA_RUN_LIVE !== '1') throw new Error('Set DAYTONA_RUN_LIVE=1 to authorize one disposable sandbox on each provider');
  for (const key of ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'DAYTONA_IMAGE', 'DAYTONA_WORKDIR']) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  if (process.env.DAYTONA_PUBLIC_PREVIEW !== '1') throw new Error('Set DAYTONA_PUBLIC_PREVIEW=1 for the demo HTTP server');
  const daytona = new Daytona({ otelEnabled: false, requestTimeoutMs: 30_000 });
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'vercel2daytona-migration-')));
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  const fixture = join(root, 'tests/fixtures/migration');
  const original = await readFile(join(fixture, 'app.mjs'), 'utf8');
  for (const name of ['app.mjs', 'worker.mjs']) await copyFile(join(fixture, name), join(consumer, name));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'migration-live-consumer', private: true, type: 'module',
    dependencies: { '@vercel/sandbox': '3.9.0' },
  }, null, 2) + '\n');
  const npm = (args, cwd) => execFileSync('npm', args, {
    cwd, encoding: 'utf8', timeout: 180_000,
    env: { ...environment(), npm_config_ignore_scripts: 'true', npm_config_git: '/usr/bin/false', npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  assert.ok(packed.files.every(file => !file.path.startsWith('.env') || file.path === '.env.example'));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--git=/usr/bin/false', join(temporary, packed.filename)], consumer);
  const { Sandbox: VercelSandbox } = await import(pathToFileURL(join(consumer, 'node_modules/@vercel/sandbox/dist/index.js')).href);
  const credentials = { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID };
  const cli = join(consumer, 'node_modules/.bin/vercel2daytona');
  const cliReport = (args, expectedStatus = 0) => {
    const run = spawnSync(cli, [...args, consumer, '--json'], { cwd: consumer, env: environment(), encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, expectedStatus, 'Unexpected migration CLI exit status');
    return JSON.parse(run.stdout);
  };
  const name = `v2d-e2e-${randomUUID()}`;
  const cleanup = async (provider) => {
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        if (provider === 'vercel') {
          const box = await VercelSandbox.get({ name, ...credentials, resume: false, signal: AbortSignal.timeout(30_000) });
          await box.delete({ signal: AbortSignal.timeout(30_000) });
        } else {
          const box = await daytona.get(name);
          await box.delete(60, true);
        }
      } catch (error) {
        if (provider === 'vercel' ? error.response?.status === 404 : error instanceof DaytonaNotFoundError) return;
        throw error;
      }
      await delay(1000);
    }
    throw new Error(`${provider} sandbox deletion could not be confirmed`);
  };
  const execute = async (provider) => {
    console.log(`Running sales-report program on ${provider}`);
    let result;
    let failure;
    try {
      const run = spawnSync(process.execPath, ['app.mjs'], {
        cwd: consumer, env: { ...environment(provider), V2D_SANDBOX_NAME: name },
        encoding: 'utf8', timeout: 240_000, maxBuffer: 1_000_000,
      });
      if (run.error || run.status !== 0) {
        // SDK errors may include request headers. Redact credentials before diagnostics.
        let diagnostic = run.stderr ?? '';
        for (const [key, value] of Object.entries(process.env)) {
          if (/TOKEN|KEY|PASSWORD|SECRET|ORGANIZATION|TEAM|PROJECT/.test(key) && value?.length >= 8) diagnostic = diagnostic.replaceAll(value, '[redacted]');
        }
        diagnostic = diagnostic.replaceAll(name, '[test-sandbox]').replace(/https?:\/\/[^\s'"<>]+/g, '[url]');
        console.error(diagnostic.slice(0, 8000));
        const assertion = /AssertionError[^\n]*/.exec(run.stderr ?? '')?.[0];
        const status = /(?:status(?:Code)?[=: ]+|HTTP\s+)(\d{3})/.exec(run.stderr ?? '')?.[1];
        throw new Error(`${provider} program failed (${run.error?.code ?? `exit ${run.status}`})${assertion ? `: ${assertion}` : ''}${status ? `; HTTP ${status}` : ''}`);
      }
      const output = run.stdout.trim().split('\n').findLast(line => line.startsWith('{'));
      result = JSON.parse(output);
    } catch (error) { failure = error; }
    try { await cleanup(provider); }
    catch (error) { throw new AggregateError(failure ? [failure, error] : [error], `${provider} cleanup failed`); }
    if (failure) throw failure;
    console.log(`PASS ${provider} program and confirmed sandbox deletion`);
    return result;
  };

  const before = await execute('vercel');
  const blocked = cliReport(['migrate', '--write'], 1);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.applied, false);
  assert.equal(await readFile(join(consumer, 'app.mjs'), 'utf8'), original);
  const errors = blocked.diagnostics.filter(d => d.severity === 'error');
  assert.equal(errors.length, 3);
  for (const field of authFields) assert.ok(errors.some(d => d.code === 'V2D_OPTION' && d.message.startsWith(`${field} `)));
  console.log('PASS linter blocks the three Vercel credential fields without changing source');

  // Explicitly reviewed configuration step, not an automatic behavior of the CLI.
  const prepared = removeVercelAuthentication(original);
  await writeFile(join(consumer, 'app.mjs'), prepared);
  const lint = cliReport(['lint']);
  assert.equal(lint.blocked, false);
  const preview = cliReport(['migrate']);
  assert.equal(preview.applied, false);
  assert.equal(preview.changes.length, 1);
  assert.equal(await readFile(join(consumer, 'app.mjs'), 'utf8'), prepared);
  const applied = cliReport(['migrate', '--write']);
  assert.equal(applied.applied, true);
  const migrated = await readFile(join(consumer, 'app.mjs'), 'utf8');
  assert.equal(migrated, prepared.replace("from '@vercel/sandbox'", "from 'vercel2daytona'"));
  assert.equal(await readFile(join(consumer, 'app.mjs.vercel2daytona.bak'), 'utf8'), prepared);
  assert.equal(cliReport(['lint']).blocked, false);
  console.log('PASS installed CLI preview, import rewrite, backup and migrated-source lint');

  const after = await execute('daytona');
  assert.deepEqual(after.result, before.result);
  const report = {
    checkedAt: new Date().toISOString(), sourceSdk: '@vercel/sandbox@3.9.0', targetSdk: '@daytona/sdk@0.226.1',
    target: { image: process.env.DAYTONA_IMAGE, workdir: process.env.DAYTONA_WORKDIR, user: process.env.DAYTONA_USER },
    passed: ['Vercel program', 'credential-field lint blockers', 'migration preview/apply and backup', 'Daytona program', 'identical program results', 'both sandboxes confirmed deleted'],
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    migratedSha256: createHash('sha256').update(migrated).digest('hex'),
    manualChanges: ['Removed token, teamId and projectId from Sandbox.create', 'Configured Daytona credentials, image, workdir, guest user and public preview in the environment'],
    automaticChanges: ['Changed the SDK import from @vercel/sandbox to vercel2daytona; the packed adapter dependency was already installed'],
    reviewedWarnings: [...new Set(lint.diagnostics.map(d => d.code))],
    environments: { vercel: before.environment, daytona: after.environment },
    resultsMatch: true, cleanupConfirmed: { vercel: true, daytona: true }, result: after.result,
  };
  await writeFile(join(temporary, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS end-to-end migration; sanitized receipt: ${join(temporary, 'result.json')}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigration().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
