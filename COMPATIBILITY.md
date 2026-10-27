# Compatibility

The adapters support disposable Vercel Sandbox workflows. Unsupported options
raise an error; they aren't silently ignored.

## Supported APIs

| Operation | TypeScript | Python, async and sync |
| --- | --- | --- |
| Create | `Sandbox.create({ persistent: false })` | `create_sandbox(persistent=False)` |
| Delete | `delete()`, `stop()` | `destroy()`, `stop()`, context exit |
| Run commands | `runCommand()` | `run_process(capture_output=True)` |
| Command results | `exitCode`, `stdout()`, `stderr()` | `returncode`, `stdout`, `stderr`, `check=True` |
| Files | `mkDir`, `writeFiles`, `readFileToBuffer`, `readFile` | `fs.mkdir`, `read_bytes`, `read_text`, `write_bytes`, `write_text` |
| Detached commands | `detached: true`, `getCommand`, `wait` | Native SDK required |
| Reconnect | `Sandbox.get({ name })` for adapter-created sandboxes | Native SDK required |
| Public previews | `ports`, `domain`, explicit opt-in | Native SDK required |
| Extend lifetime | `extendTimeout`, explicit rounding opt-in | Native SDK required |

## Behavior to review

- **Lifecycle:** default lifetime is five minutes. Expiry, stop, and delete destroy
  the sandbox. Idle auto-stop is disabled. Persistence, resume, snapshots, forks,
  and Drives require native Daytona code.
- **Time units:** TypeScript uses milliseconds; Python uses seconds. Lifetimes
  must be positive whole minutes. TypeScript can opt into ceiling rounding with
  `DAYTONA_TIMEOUT_ROUNDING=ceil`; extending time uses the same opt-in.
- **Environment:** configure the Daytona image, workdir, and guest user. Vercel
  image names, credentials, sandbox IDs, and stored data aren't transferred.
  Absolute paths stay absolute; relative paths use the configured workdir.
- **Commands:** arguments are shell-quoted, stdin is closed, and output is
  buffered. Per-command env, stdin, signals, process deadlines, and live streams
  require native code. Set common env values at sandbox creation.
- **Files:** reads are buffered. Python raises `SandboxPathNotFoundError` for
  missing files; TypeScript returns `null`. Other provider errors propagate.
- **Resources:** defaults are 2 CPU, 4 GiB RAM, and 10 GiB disk. TypeScript maps
  `resources.vcpus` to CPU and twice that value in GiB RAM. Python resource
  overrides require native code.
- **Networking:** TypeScript maps `allow-all`/`deny-all`; other policies require
  native code. Public previews are sandbox-wide. Private preview authentication
  and structured firewall rules need application-specific handling.

## Migration CLI

Both CLIs inspect source without executing it. Preview is the default; `--write`
creates exclusive `.vercel2daytona.bak` backups. Errors block all writes.
`--json` emits a report with a `helpUrl` for each diagnostic; `--strict` also fails
on review warnings. `migrate` runs the same checks as `lint`, so a separate lint
pass is optional. See [migration fixes](skills/vercel2daytona/references/migration.md).

Exit codes: **0** passed, **1** diagnostics, **2** tool error. Hidden paths,
dependencies, build output, and symlinks are skipped. Dynamic imports, opaque
wrappers, and escaped handles need manual review; lint isn't a whole-program proof.

Neither CLI installs dependencies. Python leaves dependency files unchanged;
TypeScript adds an adapter dependency when needed. A filesystem failure can leave
partial writes: restore affected files from their backups.

## SDK references

| Language | Vercel | Daytona |
| --- | --- | --- |
| TypeScript | [`@vercel/sandbox` 3.9.0](https://vercel.com/docs/sandbox/sdk-reference) | [`@daytona/sdk` 0.226.1](https://www.daytona.io/docs/en/typescript-sdk/) |
| Python | [`vercel` 0.12.1 / `vercel-sandbox` 0.10.0](https://vercel.com/docs/sandbox/python-sdk-reference) | [`daytona` 0.226.1](https://www.daytona.io/docs/en/python-sdk/) |

[Verified scenarios](VALIDATION.md) · [SDK provenance](sources.json)
