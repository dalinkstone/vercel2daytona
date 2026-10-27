# Vercel on Daytona

[![CI](https://github.com/dalinkstone/vercel2daytona/actions/workflows/ci.yml/badge.svg)](https://github.com/dalinkstone/vercel2daytona/actions/workflows/ci.yml)

Run supported Vercel Sandbox workflows on Daytona. TypeScript and Python adapters,
with a linter and an import migration CLI for each language.

| Language | Requirements | Setup |
| --- | --- | --- |
| TypeScript / JavaScript | Node.js 22.4+ | [TypeScript guide](docs/typescript.md) |
| Python, async and sync | Python 3.11+ | [Python guide](packages/py-sdk/README.md) |

Install from source; the packages aren't published to npm or PyPI.

## Migrate

Install the adapter, configure Daytona, then preview and apply the migration:

**TypeScript**

```sh
npx --no-install vercel2daytona migrate .
npx --no-install vercel2daytona migrate . --write
```

```diff
-import { Sandbox } from '@vercel/sandbox'
+import { Sandbox } from 'vercel2daytona'
```

**Python**

```sh
python -m vercel2daytona migrate .
python -m vercel2daytona migrate . --write
```

```diff
-from vercel import sandbox
+from vercel2daytona import sandbox
```

Preview includes compatibility checks. Errors block writes; changes get backups.
Use explicitly disposable sandboxes: `persistent: false` in TypeScript or
`persistent=False` in Python. Credentials and images require configuration.

## Agent skill

Copy [skills/vercel2daytona](skills/vercel2daytona) into your agent's skills
directory (Codex: `~/.codex/skills/`), then ask:

> Use $vercel2daytona to migrate this project's Vercel Sandbox code to Daytona.
> Preserve its behavior and verify the changes.

The skill uses Daytona's LLM docs and includes
[migration fixes](skills/vercel2daytona/references/migration.md) with before/after examples.

## Compatibility

Commands, files, and disposable lifecycle are supported in both languages.
TypeScript also supports detached commands, reconnects, and public previews.
Persistence, snapshots, and advanced networking need native Daytona code.

See the [compatibility table](COMPATIBILITY.md) for the supported APIs and limits.

## Examples

| Example | TypeScript | Python |
| --- | --- | --- |
| Run a command | [Job](examples/job.mjs) | [Job](examples/job.py) |
| Migration walkthrough | [Files + commands](skills/vercel2daytona/references/typescript.md) | [Async + sync](skills/vercel2daytona/references/python.md) |
| Before-and-after migration | [Report + HTTP server](tests/fixtures/migration/app.mjs) | [Async report](packages/py-sdk/tests/fixtures/async_app.py) · [Sync report](packages/py-sdk/tests/fixtures/sync_app.py) |

Live migration tests passed on both providers. [Test results and commands](VALIDATION.md).
