"""Opt-in migration test using installed packages and both cloud providers."""

import asyncio
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from daytona import AsyncDaytona, DaytonaConfig, DaytonaNotFoundError
from vercel import sandbox as vercel
from vercel.sandbox import SandboxApiError


def environment(provider=None):
    return {k: v for k, v in os.environ.items() if not (
        k.startswith("VERCEL_") and provider != "vercel" or
        k.startswith("DAYTONA_") and provider != "daytona" or k == "PYTHONPATH"
    )}


def diagnostic(value):
    for key, secret in os.environ.items():
        if re.search("TOKEN|KEY|PASSWORD|SECRET|TEAM|PROJECT|ORGANIZATION", key) and len(secret) >= 8:
            value = value.replace(secret, "[redacted]")
    return re.sub(r"https?://[^\s'\"<>]+", "[url]", value)[:6000]


async def run_migration():
    if os.environ.get("DAYTONA_RUN_LIVE") != "1":
        raise RuntimeError("Set DAYTONA_RUN_LIVE=1 to run two disposable sandboxes on each provider")
    for key in ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "DAYTONA_IMAGE", "DAYTONA_WORKDIR"]:
        if not os.environ.get(key):
            raise RuntimeError(f"{key} is required")
    client = AsyncDaytona(DaytonaConfig(otel_enabled=False))
    temporary = Path(tempfile.mkdtemp(prefix="vercel2daytona-python-"))
    results = {}

    async def cleanup(provider, name):
        for _ in range(15):
            if provider == "vercel":
                try:
                    box = await vercel.get_sandbox(name=name)
                    await box.destroy()
                except SandboxApiError as error:
                    if error.status_code == 404:
                        return
                    raise
            else:
                try:
                    box = await client.get(name)
                    await box.delete(timeout=60, wait=True)
                except DaytonaNotFoundError:
                    return
            await asyncio.sleep(1)
        raise AssertionError(f"{provider} deletion could not be confirmed")

    async def execute(provider, name, folder):
        print(f"Running {folder.name} program on {provider}", flush=True)
        failure = None
        try:
            run = await asyncio.to_thread(subprocess.run, [sys.executable, "app.py"], cwd=folder,
                env={**environment(provider), "V2D_SANDBOX_NAME": name}, capture_output=True, text=True, timeout=240)
            if run.returncode:
                print(diagnostic(run.stderr), file=sys.stderr)
                raise AssertionError(f"{provider} program failed: exit {run.returncode}")
            result = json.loads(next(line for line in reversed(run.stdout.splitlines()) if line.startswith("{")))
        except BaseException as error:
            failure = error
        try:
            await cleanup(provider, name)
        except BaseException as error:
            raise BaseExceptionGroup("Cleanup failed", [failure, error] if failure else [error]) from None
        if failure:
            raise failure
        print(f"PASS {provider}: program and confirmed deletion", flush=True)
        return result

    def cli(command, folder, *flags):
        run = subprocess.run([sys.executable, "-m", "vercel2daytona", command, str(folder), "--json", *flags],
            env=environment(), capture_output=True, text=True, timeout=30)
        if run.returncode:
            raise AssertionError(diagnostic(run.stdout + run.stderr))
        return json.loads(run.stdout)

    try:
        for mode in ["async", "sync"]:
            folder = temporary / mode
            folder.mkdir()
            original = (Path(__file__).parent / "fixtures" / f"{mode}_app.py").read_text()
            app = folder / "app.py"
            app.write_text(original)
            name = f"v2d-py-{uuid4()}"
            before = await execute("vercel", name, folder)
            assert not cli("lint", folder)["blocked"]
            assert not cli("migrate", folder)["applied"]
            assert app.read_text() == original
            assert cli("migrate", folder, "--write")["applied"]
            migrated = app.read_text()
            assert migrated == original.replace("from vercel", "from vercel2daytona")
            assert Path(str(app) + ".vercel2daytona.bak").read_text() == original
            assert not cli("lint", folder)["blocked"]
            after = await execute("daytona", name, folder)
            assert before == after
            results[mode] = {"resultsMatch": True, "cleanupConfirmed": {"vercel": True, "daytona": True},
                "sourceSha256": hashlib.sha256(original.encode()).hexdigest(),
                "migratedSha256": hashlib.sha256(migrated.encode()).hexdigest(), "result": after}
            print(f"PASS {mode}: CLI migration and identical results", flush=True)
    finally:
        await client.close()
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(),
        "versions": {key: importlib.metadata.version(key) for key in ["vercel", "vercel-sandbox", "daytona", "vercel2daytona"]},
        "target": {"image": os.environ["DAYTONA_IMAGE"], "workdir": os.environ["DAYTONA_WORKDIR"]},
        "automaticChanges": ["Rewrote sandbox imports; application logic unchanged"],
        "configuration": ["Daytona credentials, image and workdir supplied through environment variables"],
        "scenarios": results}
    output = temporary / "result.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"PASS Python migration; sanitized receipt: {output}", flush=True)
    return report


if __name__ == "__main__":
    try:
        asyncio.run(run_migration())
    except BaseException as error:
        print(diagnostic(f"{type(error).__name__}: {error}"), file=sys.stderr)
        raise SystemExit(1) from None
