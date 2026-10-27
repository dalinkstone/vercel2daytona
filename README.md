# vercel2daytona

[![CI](https://github.com/dalinkstone/vercel2daytona/actions/workflows/ci.yml/badge.svg)](https://github.com/dalinkstone/vercel2daytona/actions/workflows/ci.yml)

A local migration CLI, CI linter, and TypeScript adapter for **Vercel Sandbox → stable Daytona**.
The target is the published `@daytona/sdk@0.226.1`, checked against
[daytona.io/docs](https://www.daytona.io/docs/). The source reference is
`@vercel/sandbox@3.9.0` and the [current Vercel SDK docs](https://vercel.com/docs/sandbox/sdk-reference).
Source is shared in this repository; the package is not published to npm. Build
from source or install a tarball as below. The manifest retains `private: true`
to prevent accidental npm publication.

The adapter has passed live Daytona checks for explicitly disposable Node backend
workflows, including actual native expiry and cleanup. See [VALIDATION.md](./VALIDATION.md)
for the tested scope and [recorded results](./verification/live-2026-10-27.json). Read
[COMPATIBILITY.md](./COMPATIBILITY.md) before switching a workload. A successful
lint is a static check, not proof of cloud parity. Persistent sandboxes and more
advanced Vercel capabilities need application-specific native Daytona changes.

## Build and inspect

From a source checkout (packed installations already include compiled output):

```sh
git clone https://github.com/dalinkstone/vercel2daytona.git
cd vercel2daytona
npm ci --ignore-scripts
npm run build
npm test
npm run test:types
npm run test:package
node dist/cli.js lint /absolute/path/to/app
node dist/cli.js lint /absolute/path/to/app --json
node dist/cli.js lint /absolute/path/to/app --strict
node dist/cli.js migrate /absolute/path/to/app
```

`lint` exits 1 for incompatible/unanalyzable source, or for review warnings under
`--strict`; tool/configuration failures exit 2. It reads `.js`, `.jsx`, `.ts`,
`.tsx`, `.mjs`, `.cjs`, `.mts` and `.cts`. Hidden directories, dependency/build
directories, declaration files and symlinks are excluded. It does not evaluate
application code, read `.env`, contact either provider, or follow `.gitignore`.
Review excluded code and non-JavaScript clients separately.

The analyzer uses TypeScript ASTs and lexical symbols, follows local aliases and
const option objects, and checks already-migrated imports too. It blocks dynamic
imports, CommonJS, re-exports, unknown option spreads, escaped handles and
unsupported SDK members when detected. This is not a whole-program type/dataflow
proof: indirect module aliases, reflection, dependency-internal calls and opaque
wrappers still require review. Typecheck and test the application after migration.

## Apply the reviewed migration

For a portable application dependency, first run `npm pack --ignore-scripts` in
the built source checkout. Copy `vercel2daytona-0.1.0.tgz` into your application's
`vendor/` directory, then run these commands from the application:

```sh
npm install --ignore-scripts ./vendor/vercel2daytona-0.1.0.tgz
npx --no-install vercel2daytona lint .
npx --no-install vercel2daytona migrate .
# After reviewing diagnostics and the proposed changes:
npx --no-install vercel2daytona migrate . --write
```

Keep the tarball alongside your application's source so fresh builds can install
it. An existing runtime dependency is retained; an existing dev-only adapter
dependency is moved to runtime dependencies. No npm registry release is required.

You can also use the CLI directly from the tool checkout:

```sh
node dist/cli.js migrate /absolute/path/to/app --write
```

The default is a preview. `--write` runs the same checks and refuses all writes
when errors remain. It changes supported import module strings to `vercel2daytona`
and, if absent, adds a local `file:` dependency to each affected file's nearest `package.json`.
It preserves import aliases, comments, formatting outside the module string,
the original Vercel dependency, and existing lockfiles. It creates exclusive
`.vercel2daytona.bak` backups, refuses existing backups or concurrent edits, and
never installs packages or runs application scripts. A filesystem failure can
leave a partially applied migration; restore the affected files from the backups.

The `file:` dependency points to **this package's current location**. Keep it
available, or move the package into your application's workspace and update that
path. After reviewing package scripts and the changes, install dependencies with
lifecycle scripts disabled and regenerate the application lockfile. Typecheck,
test, and only then remove the unused Vercel dependency. For CI distribution,
package the built directory with `npm pack --ignore-scripts`; publication is a
separate step.

## Minimal disposable job

Set `DAYTONA_API_KEY`, `DAYTONA_IMAGE`, and `DAYTONA_WORKDIR` in your trusted backend.
See [.env.example](./.env.example) for placeholders; environment files are not loaded automatically.
The image must be accessible to Daytona and provide `sh`, your executable, and the
specified existing directory. Set `DAYTONA_USER` to the intended existing guest
user; verify ownership and permissions. Image choice is explicit because a Vercel
runtime identifier is not a Daytona image reference.

```ts
import { Sandbox } from 'vercel2daytona';

const sandbox = await Sandbox.create({ persistent: false, timeout: 300_000 });
try {
  await sandbox.writeFiles([{ path: 'hello.txt', content: Buffer.from('hello') }]);
  const command = await sandbox.runCommand('node', ['--version']);
  if (command.exitCode !== 0) throw new Error(await command.stderr());
  console.log(await command.stdout());
} finally {
  await sandbox.delete();
}
```

This ordinary `finally` can replace an earlier work error with a cleanup error.
The [live smoke example](./examples/job.mjs) demonstrates preserving both.
Native TTL supplies crash-independent expiry; `finally` supplies prompt cleanup.

## Explicit image mapping and previews

If the existing source selects `runtime` or `image`, create a backend shim after
reviewing the target environment. The automatic CLI intentionally blocks these
cases because it cannot infer a portable image.

```ts
import { createSandboxClass } from 'vercel2daytona';

export const Sandbox = createSandboxClass({
  image: process.env.DAYTONA_IMAGE!,
  images: { node22: process.env.DAYTONA_NODE22_IMAGE! },
  workdir: process.env.DAYTONA_WORKDIR!,
  user: process.env.DAYTONA_USER,
  publicPreview: true, // Explicit sandbox-wide public access; assess your application auth.
});
```

Then import `Sandbox` from that shim in the manually reviewed files. Calls with
`ports: [3000]` can use synchronous `sandbox.domain(3000)` after creation. Preview
URLs are fetched during create/get; a preview setup failure deletes the new
sandbox. The default convenience import requires `DAYTONA_PUBLIC_PREVIEW=1`
for ports. For private/signed previews, use the native `sandbox.daytona` API and
preserve its authentication contract. The adapter does not change Vercel hosting,
Next.js components, login, domains, or deployment configuration.

## Verification

Offline tests use injected Daytona clients, the actual published SDK types, a
real local shell for argv quoting, and temporary projects for migration safety.
Network access is disabled in the test process. No credentials are loaded.

Live verification passed using `node:22-bookworm`, `/home/node`, and guest user
`node`. It checked files/modes, command quoting, stdin closure, create-time env,
separate output streams, nonzero exit, detached server startup, reconnects, public
HTTP preview, TTL extension, explicit deletion, and actual provider TTL expiry.
Both test sandboxes were confirmed gone. These are scoped checks, not proof of
private preview security, image equivalence or every provider failure mode.

To reproduce, configure credentials and the target image/workdir/user, then run:

```sh
DAYTONA_RUN_LIVE=1 npm run test:live
```

The live suite creates at most two short-lived sandboxes and performs cleanup.
The smaller [job example](./examples/job.mjs) is independently gated with the same
environment flag. CI runs offline and packaging checks on Node 22 and 24 without
cloud credentials. Before production cutover, also run your application's unchanged
acceptance tests against both providers and review preview auth and resource behavior.
