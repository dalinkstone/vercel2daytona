# Python

Run supported `vercel.sandbox` workflows on Daytona. Includes async and sync APIs,
a linter, and an import migration command. Requires Python 3.11+.

## Install

Install from source into your application's virtual environment:

```sh
git clone https://github.com/dalinkstone/vercel2daytona.git
cd vercel2daytona
python -m pip install ./packages/py-sdk
```

## Configure

```sh
export DAYTONA_API_KEY="your-daytona-key"
export DAYTONA_IMAGE="python:3.12-bookworm"
export DAYTONA_WORKDIR="/root"
```

The image must contain your runtime and the working directory. Set
`DAYTONA_USER` to select an existing guest user. Vercel credentials aren't reused.

## Migrate

```sh
python -m vercel2daytona lint /path/to/app
python -m vercel2daytona migrate /path/to/app
python -m vercel2daytona migrate /path/to/app --write
```

The CLI rewrites supported imports and creates `.vercel2daytona.bak` backups.
Errors block all writes. Dependency files stay unchanged.

```diff
-from vercel import sandbox
+from vercel2daytona import sandbox
```

For synchronous code:

```diff
-from vercel.sandbox import sync as sandbox
+from vercel2daytona.sandbox import sync as sandbox
```

## Run

```python
import asyncio
from vercel2daytona import sandbox

async def main():
    async with sandbox.create_sandbox(persistent=False) as box:
        result = await box.run_process(
            "python", ["-c", "print('hello')"],
            capture_output=True, check=True,
        )
        print(result.stdout)

asyncio.run(main())
```

For sync code, use the sync import, `with`, and ordinary calls without `await`.
Use each sync handle on its creating thread, outside an async event loop.

## Supported APIs

| Area | API |
| --- | --- |
| Lifecycle | `create_sandbox`, `stop`, `destroy`, context managers |
| Commands | `run_process(capture_output=True)`, `check=True`, separate stdout/stderr |
| Files | `fs.mkdir`, `read_text`, `read_bytes`, `write_text`, `write_bytes` |

Set `persistent=False`. `execution_time_limit` is in **seconds**, defaults to 300,
and must be a positive multiple of 60. Expiry, `stop()`, and `destroy()` delete
the sandbox. Command output is buffered; unsupported options raise
`CompatibilityError`. Async calls use Daytona's native async SDK.

Use the native Daytona SDK for previews, detached processes, reconnects,
persistence, snapshots, and streaming. See [compatibility](../../COMPATIBILITY.md)
and [tests](../../VALIDATION.md).
