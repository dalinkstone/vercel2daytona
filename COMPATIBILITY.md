# Compatibility contract

Checked 2026-10-26 against published `@vercel/sandbox@3.9.0` and
`@daytona/sdk@0.226.1`. The package deliberately implements a subset. Unsupported
options throw `CompatibilityError` before the corresponding operation instead of
being silently discarded. Dynamic JavaScript can bypass static lint; runtime
validation remains necessary. Native calls through `.daytona` use native contracts.

| Vercel surface | Adapter behavior / migration action |
| --- | --- |
| `Sandbox.create` | Requires `persistent: false`; uses a configured OCI image, explicit workdir, 2 CPU / 4 GiB by default and configurable 10 GiB disk. `resources.vcpus` maps to CPU and twice that value in GiB RAM; this is a requested shape, not a performance guarantee. |
| `image`, deprecated `runtime` | Require an explicit `images` mapping via `createSandboxClass`. No VCR credentials or image names are forwarded. Missing source image uses the configured target image. |
| `timeout` | Default 300,000 ms maps to native `ttlMinutes: 5`. Positive whole-minute values are accepted. Other values need explicit `timeoutRounding: 'ceil'` (or `DAYTONA_TIMEOUT_ROUNDING=ceil`) after manual review. Zero is rejected. TTL counts from Daytona creation, including provisioning, rather than a resumed Vercel session. |
| `extendTimeout` | Requires explicit ceiling rounding; adds to refreshed existing expiry and calls `setTtl`. Up to one minute of rounding plus request latency is possible. Calls on one handle serialize; cross-process extensions need an application lock. Expired sandboxes are rejected. |
| `env`, `tags` at create | Env maps to native `envVars`; tags become prefixed labels. Credentials remain backend configuration. Provider-specific credentials/options are rejected. |
| `name`, `Sandbox.get({name})` | Names identify newly created Daytona resources. Reconnect validates adapter ownership/configuration and running state. Existing Vercel names/IDs do not locate or migrate their data. |
| `stop`, `delete`, `await using` | Delete the disposable Daytona sandbox and wait for destruction; repeated deletion on the same handle is safe. `stop` returns void, without Vercel snapshot/session/usage metadata. Native `.daytona.stop()` is a different operation. |
| `runCommand(cmd,args)` / object form | Shell-quotes each argv item and cwd, closes stdin, suppresses input echo, preserves nonzero exit, and uses a fresh Daytona session per command. The executable is not a shell script. Use `sh` plus `['-c', script]` for intentional shell syntax. |
| `detached`, `getCommand`, `wait`, `stdout`, `stderr`, `output` | Detached calls return before polling; collectors wait for completion and cache separate/combined logs. Adapter command IDs encode the Daytona session and command IDs. Sessions/logs live until sandbox disposal. Waits can last until sandbox TTL. |
| Per-command `env` | Blocked: encoding values into a session command would put them in command metadata. Move defaults to create-time `env` when semantically valid, or implement a native execution path with separate env parameters. |
| `timeoutMs`, `signal`, `stdin`, sinks, `logs`, `kill`, command metadata | Blocked. Request timeouts, process deadlines, cancellation, streamed logs and signals require explicit native handling. The adapter does not equate HTTP cancellation with killing a command. |
| `mkDir`, `writeFiles`, `readFileToBuffer`, `readFile` | Relative paths resolve against the configured target workdir, absolute paths stay absolute. Writes accept Buffers and optional modes. Only typed file-not-found errors return null; missing sandbox/auth/transport errors propagate. `readFile` wraps a buffered download in a web stream; it is not constant-memory streaming. |
| `ports`, `domain` | Explicit public-preview opt-in is required. URL results are cached so `domain` stays synchronous. Public access in Daytona applies sandbox-wide; declared ports do not constitute an ingress allowlist. Private/signed URLs require native API use. |
| `networkPolicy` | Only `allow-all` and `deny-all` map to `networkBlockAll`. Structured firewall rules, transforms, proxy forwarding and credential brokering are blocked. |
| Persistence, resume hooks, snapshots, `getOrCreate`, `fork`, Drives/mounts, `source`, users, regions, mutable configuration | Native migration required. Copy data and define lifecycle, image, placement, access, and storage behavior explicitly; no automatic resource migration or security-policy downgrade. |

Vercel 3.9.0 includes `Drive`, stdin and user-related APIs that were absent from
the old 3.2.2 kit. Current Vercel docs default to persistent sandboxes; omission of
`persistent` is not disposable intent. The linter therefore blocks that omission,
including legacy applications until their intended lifecycle has been reviewed.
The earlier RLP migration kit is not part of this standalone package.

The stable Daytona SDK now has native wall-clock `ttlMinutes` and `setTtl`, distinct
from `autoStopInterval`. The adapter disables idle auto-stop and requests ephemeral
deletion. In-progress create failures can leave an uncertain resource until its
TTL; investigate resources by the `vercel2daytona=1` label. SDK deletion failures
are propagated, not swallowed. Creation setup failures attempt cleanup and retain
both errors if cleanup also fails. A failed command launch can leave a session or
command until sandbox cleanup; do not retry non-idempotent work blindly.

## Sources and precedence

The exact published package types/implementation are the signature authority;
live documentation provides service semantics. Scoped live test results are recorded
in [VALIDATION.md](./VALIDATION.md); these do not establish complete provider parity.
The lockfile pins target dependencies; `sources.json` records the source SDK pin
and documentation URLs.

- [Vercel JavaScript SDK](https://vercel.com/docs/sandbox/sdk-reference): API inventory.
- [Vercel persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes): lifecycle expectations.
- [Vercel firewall](https://vercel.com/docs/sandbox/concepts/firewall): policy/brokering differences.
- [Daytona create](https://www.daytona.io/docs/en/typescript-sdk/daytona/): stable creation parameters and units.
- [Daytona sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/): native TTL and preview methods.
- [Daytona processes](https://www.daytona.io/docs/en/typescript-sdk/process/): sessions and separate logs.
- [Daytona files](https://www.daytona.io/docs/en/typescript-sdk/file-system/): binary IO and file permissions.
- [Daytona previews](https://www.daytona.io/docs/en/preview/): public/private access.

The current Vercel website and 3.9.0 declarations disagree on some advanced
signatures (for example fork image overrides). Those operations are blocked here;
inspect the application's exact lockfile before implementing them. Daytona docs
pages can display differing release labels; the published 0.226.1 artifact was
inspected directly for all target method signatures, including TTL.
