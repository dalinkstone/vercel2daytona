# TypeScript and JavaScript

## Setup

If `vercel2daytona` is already installed in the app, use its CLI. Otherwise build
and pack a checkout of [vercel2daytona](https://github.com/dalinkstone/vercel2daytona):

```sh
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
```

Install the archive as an app runtime dependency. Keep it in the app's `vendor/`
directory when CI must reinstall it. There is no npm registry release.

```sh
npm install --ignore-scripts ./vendor/vercel2daytona-0.1.0.tgz
```

Configure `DAYTONA_API_KEY`, `DAYTONA_IMAGE`, and `DAYTONA_WORKDIR` in the backend.
For Node jobs, the tested image is `node:22-bookworm`, workdir `/home/node`, and
`DAYTONA_USER=node`. Choose an image with the app's actual tools and permissions.

## Preview and apply

From the application directory:

```sh
npx --no-install vercel2daytona migrate .
npx --no-install vercel2daytona migrate . --write
```

Use `npx --no-install vercel2daytona lint . --json` for agent or CI diagnostics.
Resolve errors and review warnings before applying. See [migration fixes](migration.md).

## Disposable file job

For a supported job, the automatic source change is the import:

```diff
-import { Sandbox } from '@vercel/sandbox'
+import { Sandbox } from 'vercel2daytona'
```

This is the resulting program:

```ts
import { Sandbox } from 'vercel2daytona'

const box = await Sandbox.create({ persistent: false, timeout: 300_000 })
try {
  await box.writeFiles([{ path: 'input.txt', content: Buffer.from('hello') }])
  const result = await box.runCommand('node', [
    '-e', 'const fs = require("node:fs"); console.log(fs.readFileSync("input.txt", "utf8"))',
  ])
  if (result.exitCode !== 0) throw new Error(await result.stderr())
  console.log(await result.stdout())
} finally {
  await box.delete()
}
```

`runCommand` preserves arguments; use `sh` with `['-c', script]` only when shell
syntax is intentional. Reads and command output are buffered. `timeout` is in
milliseconds and must be a positive multiple of 60,000.

For detached commands, reconnects, and previews, consult the
[adapter contract](https://github.com/dalinkstone/vercel2daytona/blob/main/COMPATIBILITY.md)
and the linked Daytona Markdown pages before changing the app.
