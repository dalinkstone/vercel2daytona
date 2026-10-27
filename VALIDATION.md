# Testing

## Verified

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript unit tests | 34 passed | `npm test` |
| Python unit tests | 26 passed | `python -m unittest discover -s packages/py-sdk/tests` |
| TypeScript migration | Vercel and Daytona results match; both sandboxes deleted | [Receipt](verification/migration-2026-10-27.json) |
| Python async and sync migrations | Results match; all four sandboxes deleted | [Receipt](verification/python-migration-2026-10-27.json) |
| Daytona TTL | Native expiry and explicit deletion passed | [Receipt](verification/live-2026-10-27.json) |

Live tests ran on 2026-10-27 UTC. They cover files, permissions, argument quoting,
stdout/stderr, nonzero exits, and cleanup. TypeScript also checks an HTTP server.
These results cover the supplied examples, not every application or image.

## Local checks

From the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:types
npm run test:package

python -m pip install -e './packages/py-sdk[test]'
python -m unittest discover -s packages/py-sdk/tests
python -m build --no-isolation --wheel packages/py-sdk
```

CI builds and installs the Python wheel, then runs its tests. Tests also lint the
skill's examples and verify diagnostic links; packaging checks typecheck the
TypeScript example. Cloud tests are opt-in.

The skill passed format validation and an isolated agent trial: a disposable
TypeScript report was migrated with six passing offline integration tests and
an unchanged frontend. A persistent Python workspace was correctly flagged for
native migration and left unchanged. This trial made no cloud calls.

## Live migration tests

Configure `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, and
`DAYTONA_API_KEY`. `DAYTONA_JWT_TOKEN` plus `DAYTONA_ORGANIZATION_ID` also works.
Keep credentials in your environment or an ignored local file.

```sh
# TypeScript: one sandbox per provider
DAYTONA_RUN_LIVE=1 DAYTONA_PUBLIC_PREVIEW=1 \
DAYTONA_IMAGE=node:22-bookworm DAYTONA_WORKDIR=/home/node DAYTONA_USER=node \
npm run test:migration

# Python: async and sync, two sandboxes per provider
DAYTONA_RUN_LIVE=1 \
DAYTONA_IMAGE=python:3.12-bookworm DAYTONA_WORKDIR=/root \
python packages/py-sdk/tests/migration_live.py
```

Each runner tests the original Vercel program, applies the installed migration
CLI, compares Daytona results, and confirms deletion through the native APIs.
Sandboxes have five-minute lifetimes. TypeScript's demo exposes a public HTTP
endpoint. The runners print a sanitized JSON receipt path.
