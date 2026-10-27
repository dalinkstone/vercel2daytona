# Validation

Source reference: `@vercel/sandbox@3.9.0`. Target: `@daytona/sdk@0.226.1`.
The adapter implements the bounded contract in [COMPATIBILITY.md](./COMPATIBILITY.md).

## Local and packaging checks

Verified with Node 24.19.0 on macOS. GitHub Actions also runs the same checks on
Linux with Node 22 and 24. The exact declared minimum Node release has not been
tested separately.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:types
npm run test:package
```

- 30 offline tests cover argv quoting, closed stdin, separate output, nonzero exits,
  detached handles, binary files, typed missing-file handling, expiry conversion,
  cleanup errors, unsupported features, symbol binding, safe migration writes,
  backups, monorepo manifests and previously installed adapter dependencies.
- Type assertions check foreground/detached return types and unsupported options.
- The package test builds an npm archive, installs it into a separate consumer
  with lifecycle scripts disabled, runs the installed binary, previews/applies an
  actual source migration, imports the ESM API, and typechecks consumer code.
- All 166 source-lock dependency resolutions use npm registry tarballs.
- CI action revisions are pinned and cloud credentials are not needed by CI.

## Live Daytona verification

Passed on **2026-10-27 UTC** (2026-10-26 in Los Angeles), using the stable Daytona
API, `node:22-bookworm`, `/home/node`, and guest user `node`.
[Machine-readable results](./verification/live-2026-10-27.json) contain no account
identifiers, credentials, sandbox IDs or preview URLs.

Verified:

1. Sandbox creation with native wall-clock TTL.
2. Binary writes/reads, relative cwd, missing files and readable streams.
3. Literal argv quoting, closed stdin, create-time env, file mode, separate output
   streams and nonzero command exit.
4. Detached HTTP server, sandbox and command reconnect, and public preview access.
5. Extension of the existing expiry deadline.
6. Explicit deletion, followed by a not-found lookup.
7. Native one-minute expiry observed through the Daytona API, without an adapter
   timer or explicit deletion. Both owned test sandboxes were confirmed gone.

Reproduce with an appropriate account and configured target image:

```sh
DAYTONA_RUN_LIVE=1 npm run test:live
```

The suite creates at most two short-lived sandboxes. It defaults to no cloud
activity without the explicit gate. A local authenticated CLI profile was used
for the recorded run; no credentials or profile-specific launcher are committed.

## Limits

This does not prove full Vercel compatibility. Persistent lifecycle, snapshots,
Drives, per-command env, advanced process control and structured firewall features
remain blocked. Private preview security, complete network isolation and arbitrary
images/applications require separate acceptance testing. The static linter cannot
prove compatibility through opaque application wrappers or excluded files.
