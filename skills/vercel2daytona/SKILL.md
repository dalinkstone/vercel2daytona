---
name: vercel2daytona
description: Migrate Vercel Sandbox TypeScript, JavaScript, or Python code to Daytona using vercel2daytona, its linter, and current Daytona documentation. Use for compatibility assessment, migration edits, or migration testing; this skill covers sandbox backends, not Vercel hosting or Next.js deployment.
---

# Vercel Sandbox to Daytona

Preserve the application's behavior while moving sandbox execution to Daytona.
Use the adapter for supported operations and native Daytona code where the
application needs more. Keep hosting, frontend code, and application auth in scope
only when the user requests changes to them.

## Read the right sources

Before choosing Daytona APIs, follow [Daytona docs](references/daytona-docs.md).
Start at `https://www.daytona.io/docs/llms.txt`, then fetch the relevant Markdown
pages. Check the application's installed SDK versions and the adapter's manifest;
current website examples can differ from the installed release. The adapter uses
stable Daytona SDKs, not the old RLP SDK.

Read only the language guide you need:

- [TypeScript / JavaScript](references/typescript.md): installation, import migration, commands, files.
- [Python](references/python.md): async and sync migration, output capture, cleanup.
- [Migration fixes](references/migration.md): interpret linter findings and choose concrete edits.

## Inspect and migrate

1. Find sandbox imports, wrappers, call sites, dependency versions, and application
   tests. Identify retained state, deadlines, command env, output streaming, and
   preview access before selecting an adapter migration. Search beyond files the
   linter scans, including hidden routes and dependency-owned wrappers.
2. Use the existing adapter installation, or install from source as the language
   guide describes. Run `migrate <app>` for a checked preview. For machine-readable
   findings use `lint <app> --json`; each finding includes a location and `helpUrl`.
3. Resolve findings using the smallest behavior-preserving edit. State the file,
   line, reason, and proposed replacement. Use the linked recipes for known
   mappings. For ambiguous behavior, identify the decision needed and continue
   independent migration work; do not invent a native equivalent.
4. Apply `migrate <app> --write` once blockers are resolved. It rewrites supported
   imports, with backups. TypeScript may add an adapter dependency; Python leaves
   dependency files unchanged. Review dependencies and regenerate the app's
   lockfile with its package manager. Retain Vercel dependencies still used elsewhere.

The preview already runs lint. Do not add another wrapper script or require a
separate lint pass before every preview. Passing lint covers detectable patterns,
not arbitrary dynamic code or complete provider parity.

## Preserve semantics

- The adapter is disposable: expiry and stop/delete destroy sandbox state.
  Set `persistent: false` / `persistent=False` only when that matches the job.
  Retained state, resume hooks, or snapshots need a native lifecycle design.
- Keep deadlines and public/private access unchanged unless the user chooses a
  change. Do not round timeouts, enable public previews, or discard firewall
  rules just to satisfy lint.
- Configure Daytona credentials, image, workdir, and guest user independently.
  Vercel credentials, IDs, images, and files do not transfer automatically.

## Verify and report

Run the app's type checks and relevant tests after migration. Check output,
nonzero exits, files, deadlines, preview access, and cleanup as applicable.
For an authorized live test, compare the same workload on both providers and
confirm deletion of the test resources. Use existing authorization and credentials
within the user's scope; never print secret values. If cloud testing is unavailable,
finish offline checks and state what remains unverified.

Report changed files, manual configuration, tests performed, and any remaining
blockers. Distinguish tested behavior from inferred compatibility.
