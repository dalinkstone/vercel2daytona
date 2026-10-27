# Migration fixes

The CLI rewrites supported imports. Configuration and behavior changes below
are reviewed edits; it does not apply them automatically.

## Configuration

Configure Daytona independently of Vercel. For a Node job, for example:

```sh
export DAYTONA_API_KEY="your-daytona-key"
export DAYTONA_IMAGE="node:22-bookworm"
export DAYTONA_WORKDIR="/home/node"
export DAYTONA_USER="node"
```

Remove Vercel's `token`, `teamId`, and `projectId` from TypeScript creation options.
Python uses Daytona environment configuration through the adapter. Keep credentials
out of source. Vercel image/runtime aliases need an explicit target image choice;
the CLI cannot infer matching tools, ownership, or installed packages.

## Lifecycle

For a job whose files may be discarded after execution:

```diff
-const box = await Sandbox.create({})
+const box = await Sandbox.create({ persistent: false })
```

```diff
-box = await sandbox.create_sandbox()
+box = await sandbox.create_sandbox(persistent=False)
```

These are behavior changes when the source relies on Vercel's persistent default.
Do not apply them to retained workspaces. Use native Daytona lifecycle/storage
APIs for persistence and define what survives stop, restart, and expiry.
Adapter `stop()` deletes state; Vercel session/snapshot/usage return values are
not provided. See [Daytona lifecycle](https://www.daytona.io/docs/en/sandboxes.md).

## Deadlines

The adapter accepts whole-minute sandbox lifetimes: `300_000` milliseconds in
TypeScript, `300` seconds in Python. Preserve a strict 30-second deadline through
native process/lifecycle handling; do not silently change it to a minute.
TypeScript's rounding opt-in requires an intentional deadline change. Process
deadlines, request timeouts, and sandbox lifetimes are separate requirements.

## Command output

If a Python job only needs its result after completion:

```diff
-result = await box.run_process("python", ["job.py"])
+result = await box.run_process("python", ["job.py"], capture_output=True)
```

The same keyword applies to sync calls. Keep `check=True` only where a nonzero
exit should raise. A UI consuming live output needs native streaming code;
buffering is not a transparent replacement.

## Unsupported options

For a value intended for **every command in this sandbox**, move command env to
creation:

```diff
-const box = await Sandbox.create({ persistent: false })
-await box.runCommand({ cmd: 'node', args: ['job.js'], env: { MODE: 'report' } })
+const box = await Sandbox.create({ persistent: false, env: { MODE: 'report' } })
+await box.runCommand('node', ['job.js'])
```

```diff
-box = await sandbox.create_sandbox(persistent=False)
-await box.run_process("python", ["job.py"], env={"MODE": "report"}, capture_output=True)
+box = await sandbox.create_sandbox(persistent=False, env={"MODE": "report"})
+await box.run_process("python", ["job.py"], capture_output=True)
```

Per-command values need native handling if moving them broadens their scope.
Do not put credentials into shell command text. Unsupported stdin, signals,
process deadlines, mounts, and other options require reviewing the corresponding
Daytona API; deleting an option is not a migration.

## Preview access

TypeScript supports public previews only with explicit opt-in. Set
`DAYTONA_PUBLIC_PREVIEW=1` only for an intentionally public sandbox. Daytona's
public setting is sandbox-wide, not a port allowlist.

For a private endpoint, use native preview authentication and preserve the app's
access checks. Python previews require native code. Read
[Daytona previews](https://www.daytona.io/docs/en/preview.md).

## Manual migration

For dynamic imports, opaque wrappers, escaped handles, and unsupported methods,
trace the real call sites and read the relevant [Daytona docs](daytona-docs.md).
Give a replacement only after checking its semantics and installed SDK signature.
Preserve firewall restrictions, retained data, and frontend/backend boundaries.
Existing Vercel IDs cannot reconnect to Daytona resources.

Lint reports terminal/JSON diagnostics, not inline source comments. Its `helpUrl`
points here. A successful import rewrite still needs application tests.
