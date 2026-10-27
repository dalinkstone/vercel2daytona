# Python

## Setup

Install into the application's virtual environment from a
[vercel2daytona checkout](https://github.com/dalinkstone/vercel2daytona):

```sh
python -m pip install /path/to/vercel2daytona/packages/py-sdk
```

Requires Python 3.11+. There is no PyPI release. Configure `DAYTONA_API_KEY`,
`DAYTONA_IMAGE`, and `DAYTONA_WORKDIR`. The tested Python image is
`python:3.12-bookworm` with workdir `/root`; select a different existing guest user
with `DAYTONA_USER` when the application requires it.

## Preview and apply

```sh
python -m vercel2daytona migrate /path/to/app
python -m vercel2daytona migrate /path/to/app --write
```

Use `python -m vercel2daytona lint /path/to/app --json` for agent or CI diagnostics.
The CLI leaves dependency files unchanged. Record the adapter source/wheel in the
app's dependency workflow before deployment. See [migration fixes](migration.md).

## Async file job

The automatic source change is:

```diff
-from vercel import sandbox
+from vercel2daytona import sandbox
```

The resulting program keeps the async API:

```python
import asyncio
from vercel2daytona import sandbox

async def main():
    async with sandbox.create_sandbox(
        persistent=False, execution_time_limit=300,
    ) as box:
        await box.fs.write_text("input.txt", "hello")
        result = await box.run_process(
            "python", ["-c", "print(open('input.txt').read())"],
            capture_output=True, check=True,
        )
        print(result.stdout)

asyncio.run(main())
```

## Sync file job

Use the sync import without converting the app to async:

```diff
-from vercel.sandbox import sync as sandbox
+from vercel2daytona.sandbox import sync as sandbox
```

```python
from vercel2daytona.sandbox import sync as sandbox

with sandbox.create_sandbox(persistent=False, execution_time_limit=300) as box:
    box.fs.write_text("input.txt", "hello")
    result = box.run_process(
        "python", ["-c", "print(open('input.txt').read())"],
        capture_output=True, check=True,
    )
    print(result.stdout)
```

`check=True` raises `subprocess.CalledProcessError` on nonzero exit. Both context
managers delete the sandbox on exit. Time limits are in seconds and must be
positive multiples of 60. Sync handles stay on their creating thread, outside an
async event loop. Previews, persistence, detached work, and streaming require
native Daytona code.
