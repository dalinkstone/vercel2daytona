# TypeScript

Run supported `@vercel/sandbox` workflows on Daytona. Requires Node.js 22.4+.

## Install

Build the package from source:

```sh
git clone https://github.com/dalinkstone/vercel2daytona.git
cd vercel2daytona
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
```

Install the archive in your application:

```sh
npm install /path/to/vercel2daytona/vercel2daytona-0.1.0.tgz
```

For CI, keep the archive in your application's `vendor/` directory.

## Configure

```sh
export DAYTONA_API_KEY="your-daytona-key"
export DAYTONA_IMAGE="node:22-bookworm"
export DAYTONA_WORKDIR="/home/node"
export DAYTONA_USER="node"
```

Choose an image with the tools, directory, and guest user your application needs.
Remove Vercel's `token`, `teamId`, and `projectId` from sandbox creation options.

## Migrate

```sh
npx --no-install vercel2daytona migrate .
npx --no-install vercel2daytona migrate . --write
```

The CLI rewrites imports and preserves the installed adapter dependency.
When run directly from this checkout, it adds a local `file:` dependency if needed.
Review the changes and update your application's lockfile before deploying.
Use `npx --no-install vercel2daytona lint . --json` for CI or agent diagnostics, including links to
[migration fixes](../skills/vercel2daytona/references/migration.md).

## Run

```ts
import { Sandbox } from 'vercel2daytona'

const box = await Sandbox.create({ persistent: false })
try {
  await box.writeFiles([{ path: 'hello.txt', content: Buffer.from('hello') }])
  const result = await box.runCommand('node', ['--version'])
  console.log(await result.stdout())
} finally {
  await box.delete()
}
```

`timeout` is in **milliseconds**, defaults to 300,000, and must be a positive
multiple of 60,000. Expiry deletes the sandbox.

## Public previews

Set `DAYTONA_PUBLIC_PREVIEW=1` before using `ports` and `box.domain(port)`.
This makes previews public across the sandbox; ports aren't an access allowlist.
For private previews, use `box.daytona.getPreviewLink(port)` and its authentication.

For custom runtime mappings, use `createSandboxClass({ image, workdir, images })`.
See [compatibility](../COMPATIBILITY.md) and [tests](../VALIDATION.md).
