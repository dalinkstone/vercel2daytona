import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { analyze } from '../dist/analyze.js';
import { removeVercelAuthentication, authFields } from './migration-live.mjs';

test('live migration fixture requires only the reviewed credential changes before its import rewrite', async () => {
  const source = await readFile(new URL('./fixtures/migration/app.mjs', import.meta.url), 'utf8');
  const errors = analyze({ '/app.mjs': source }).diagnostics.filter(d => d.severity === 'error');
  assert.equal(errors.length, 3);
  for (const field of authFields) assert.ok(errors.some(d => d.code === 'V2D_OPTION' && d.message.startsWith(`${field} `)));
  const prepared = removeVercelAuthentication(source);
  const result = analyze({ '/app.mjs': prepared });
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), []);
  assert.deepEqual([...new Set(result.diagnostics.map(d => d.code))].sort(), ['V2D_CONFIG', 'V2D_PREVIEW', 'V2D_TTL']);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].replacement, 'vercel2daytona');
});
