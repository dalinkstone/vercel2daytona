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

- 31 offline tests cover argv quoting, closed stdin, separate output, nonzero exits,
  detached handles, binary files, typed missing-file handling, expiry conversion,
  cleanup errors, unsupported features, symbol binding, safe migration writes,
  backups, monorepo manifests, previously installed adapter dependencies, and the
  exact credential blockers/import edit expected for the live migration fixture.
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

## Live Vercel → Daytona migration

Passed on **2026-10-27 UTC**. The [recorded result](./verification/migration-2026-10-27.json)
includes source/migrated program hashes, the shared report checksum, runtime
versions, reviewed configuration changes, and confirmation that both sandboxes
were deleted. The application and its unchanged worker are in
[tests/fixtures/migration](./tests/fixtures/migration).

1. Installed real `@vercel/sandbox@3.9.0` and a packed copy of this adapter into a
   separate temporary application, with package lifecycle scripts disabled.
2. Ran the sales-report program successfully on Vercel's default managed image:
   Node `v24.22.1`, guest workdir `/vercel`.
3. Verified that `migrate --write` refused the three provider-specific credential
   fields and left the source unchanged.
4. Explicitly removed those credential fields and reviewed target credentials,
   image, workdir and public preview configuration. These are manual migration
   steps, not automatic credential translation.
5. Ran the installed CLI's lint, read-only preview and actual migration. Verified
   its exclusive backup, that only the import changed, and that migrated-source
   lint passed with the expected configuration/TTL/preview warnings.
6. Ran the migrated application on Daytona, using `node:22-bookworm`, Node
   `v22.23.4`, guest workdir `/home/node`, and guest user `node`.
7. Compared identical report JSON and checksum, stdout/stderr, nonzero exit 7,
   binary file contents, file mode, literal arguments and closed stdin, and HTTP
   200/404 responses from the detached server.
8. Confirmed each sandbox's deletion using its native provider API.

The app discovers its guest working directory before building absolute paths.
During test development, a relative `cwd` and the older `/vercel/sandbox` path
failed on the current Vercel default image. Those attempts were cleaned up;
the final program makes neither assumption. The adapter needed no code changes.

See the [README reproduction command](./README.md#end-to-end-migration-test).
The two providers ran different Node versions; this proves the tested program's
behavior, not image equivalence, latency equivalence, or general application parity.

## Limits

This does not prove full Vercel compatibility. Persistent lifecycle, snapshots,
Drives, per-command env, advanced process control and structured firewall features
remain blocked. Private preview security, complete network isolation and arbitrary
images/applications require separate acceptance testing. The static linter cannot
prove compatibility through opaque application wrappers or excluded files.
