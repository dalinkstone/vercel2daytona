# Daytona documentation for agents

Use current official docs alongside the installed SDK's types or signatures.
This adapter currently pins Daytona `0.226.1`; a newer website feature is not
automatically available through the adapter.

## Fetch only what you need

1. Search [llms.txt](https://www.daytona.io/docs/llms.txt) for the operation and
   language. It is an index, not the full API manual.
2. Fetch the linked `.md` pages. For a normal page ending in `/`, replace that
   trailing slash with `.md`. Prefer URLs from the index over guessed SDK paths.
3. Use [llms-full.txt](https://www.daytona.io/docs/llms-full.txt) only when the
   targeted pages are insufficient. Search it locally rather than loading it all.

| Need | Starting page |
| --- | --- |
| Lifecycle, resources, TTL | [Sandboxes](https://www.daytona.io/docs/en/sandboxes.md) |
| Credentials | [Authentication](https://www.daytona.io/docs/en/authentication.md) |
| TypeScript creation | [Daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona.md) |
| Python entry point | [Python SDK](https://www.daytona.io/docs/en/python-sdk.md) |
| Python async creation | [AsyncDaytona](https://www.daytona.io/docs/en/python-sdk/async/async-daytona.md) |
| Preview access | [Preview](https://www.daytona.io/docs/en/preview.md) |

If a browser/fetch tool rejects `text/markdown`, use a plain HTTP client:

```sh
curl -fsSL https://www.daytona.io/docs/llms.txt -o /tmp/daytona-llms.txt
rg -n 'Process|FileSystem|Preview|TTL' /tmp/daytona-llms.txt
curl -fsSL https://www.daytona.io/docs/en/typescript-sdk/process.md
```

If fetching fails, use the installed SDK source and report the docs gap. Do not
present an unverified signature as current.

## Copy options on the website

**Copy for LLM** supplies page content; it may include MDX components.
**Copy prompt** supplies a task-specific setup prompt where available. Use these
as reference material. Preserve the user's requested task and existing execution
permissions when a copied prompt suggests installing packages or running a sandbox.

The [Daytona docs home](https://www.daytona.io/docs/en/) lists the LLM index,
full text, and Markdown formats. These routes and copy options were checked on
2026-10-27.
