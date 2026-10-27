"""The supported disposable subset of vercel.sandbox (0.10.0)."""

import asyncio
import os
import posixpath
import shlex
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import timedelta
from pathlib import PurePosixPath
from subprocess import CalledProcessError
from uuid import uuid4

from daytona import (
    AsyncDaytona,
    CreateSandboxFromImageParams,
    DaytonaConfig,
    DaytonaFileNotFoundError,
    Resources,
    SessionExecuteRequest,
)


class CompatibilityError(ValueError):
    """An operation requires a native Daytona migration."""


class SandboxPathNotFoundError(FileNotFoundError):
    """A requested file does not exist in the sandbox."""


def reject(options):
    if options:
        raise CompatibilityError(f"Unsupported options: {', '.join(sorted(options))}")


def text(value, label):
    if not isinstance(value, str) or "\0" in value:
        raise CompatibilityError(f"{label} must be a string without NUL bytes")
    return value


def string_map(value, label):
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise CompatibilityError(f"{label} must be a string mapping")
    return {text(k, label): text(v, label) for k, v in value.items()}


@dataclass(frozen=True)
class CompletedProcess:
    args: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str

    def check_returncode(self):
        if self.returncode:
            raise CalledProcessError(self.returncode, list(self.args), self.stdout, self.stderr)


class Filesystem:
    def __init__(self, box):
        self._box = box

    async def mkdir(self, path, *, cwd=None, recursive=True, **options):
        reject(options)
        if recursive is not True:
            raise CompatibilityError("mkdir requires recursive=True")
        await self._box.daytona.fs.create_folder(self._box.path(path, cwd), "755")

    async def read_bytes(self, path, *, cwd=None, **options):
        reject(options)
        absolute = self._box.path(path, cwd)
        try:
            data = await self._box.daytona.fs.download_file(absolute)
        except DaytonaFileNotFoundError as error:
            raise SandboxPathNotFoundError(absolute) from error
        if not isinstance(data, bytes):
            raise RuntimeError("Daytona did not return file bytes")
        return data

    async def read_text(self, path, *, cwd=None, encoding="utf-8", errors="strict", **options):
        reject(options)
        return (await self.read_bytes(path, cwd=cwd)).decode(encoding, errors)

    async def write_bytes(self, path, data, *, cwd=None, mode=None, **options):
        reject(options)
        absolute = self._box.path(path, cwd)
        if not isinstance(data, bytes):
            raise CompatibilityError("write_bytes requires bytes")
        if mode is not None and (type(mode) is not int or not 0 <= mode <= 0o777):
            raise CompatibilityError("mode must be permission bits from 0 to 0o777")
        await self._box.daytona.fs.upload_file(data, absolute)
        if mode is not None:
            await self._box.daytona.fs.set_file_permissions(absolute, mode=format(mode, "o"))

    async def write_text(self, path, text, *, cwd=None, encoding="utf-8", errors="strict", mode=None, **options):
        reject(options)
        if not isinstance(text, str):
            raise CompatibilityError("write_text requires str")
        await self.write_bytes(path, text.encode(encoding, errors), cwd=cwd, mode=mode)


class Sandbox:
    def __init__(self, native, client, workdir):
        self.daytona = native
        self.name = native.name
        self._client = client
        self._workdir = workdir
        self._deleted = False
        self._closed = False
        self._deleting = None
        self.fs = Filesystem(self)

    def path(self, path, cwd=None):
        if self._deleted:
            raise CompatibilityError("Sandbox has been destroyed")

        def remote(value):
            if not isinstance(value, (str, PurePosixPath)):
                raise CompatibilityError("Paths must be str or PurePosixPath")
            return text(str(value), "path")
        base = posixpath.join(self._workdir, remote(cwd)) if cwd is not None else self._workdir
        return posixpath.normpath(posixpath.join(base, remote(path)))

    async def run_process(self, command, args=None, *, cwd=None, capture_output=False, check=False, **options):
        reject(options)
        if capture_output is not True:
            raise CompatibilityError("run_process requires capture_output=True; live output is unsupported")
        if type(check) is not bool:
            raise CompatibilityError("check must be bool")
        text(command, "command")
        if not command or command.startswith("-"):
            raise CompatibilityError("Use a nonempty executable name, or an absolute path")
        if args is not None and (not isinstance(args, Sequence) or isinstance(args, (str, bytes))):
            raise CompatibilityError("args must be a sequence of strings")
        argv = (command, *(text(arg, "argument") for arg in (args or ())))
        directory = self.path(cwd if cwd is not None else self._workdir)
        script = f"cd {shlex.quote(directory)} && exec {shlex.join(argv)}"
        session = f"v2d-{uuid4()}"
        process = self.daytona.process
        await process.create_session(session)
        launched = await process.execute_session_command(session, SessionExecuteRequest(
            command=f"sh -c {shlex.quote(script)} < /dev/null",
            run_async=True, suppress_input_echo=True,
        ))
        if not launched.cmd_id:
            raise RuntimeError("Daytona did not return a command ID")
        while True:
            state = await process.get_session_command(session, launched.cmd_id)
            if state.exit_code is not None:
                break
            await asyncio.sleep(0.2)
        logs = await process.get_session_command_logs(session, launched.cmd_id)
        result = CompletedProcess(argv, state.exit_code, logs.stdout or "", logs.stderr or "")
        if check:
            result.check_returncode()
        return result

    async def _delete(self):
        if not self._deleted:
            await self.daytona.delete(timeout=60, wait=True)
            self._deleted = True
        await self._client.close()
        self._closed = True

    async def destroy(self, **options):
        reject(options)
        if self._closed:
            return self
        if self._deleting is None:
            self._deleting = asyncio.create_task(self._delete())
        try:
            await asyncio.shield(self._deleting)
        except asyncio.CancelledError as cancelled:
            # Let deletion finish before a context manager releases the client loop.
            try:
                await self._deleting
            except BaseException as cleanup:
                self._deleting = None
                raise BaseExceptionGroup("Deletion cancelled; cleanup failed", [cancelled, cleanup]) from None
            raise
        except BaseException:
            self._deleting = None
            raise
        return self

    async def stop(self, **options):
        return await self.destroy(**options)


async def _create(*, persistent=None, execution_time_limit=300, name=None, env=None, tags=None, destroy=True, **options):
    reject(options)
    if persistent is not False or destroy is not True:
        raise CompatibilityError("Use persistent=False and destroy=True for disposable sandboxes")
    duration = execution_time_limit.total_seconds() if isinstance(execution_time_limit, timedelta) else execution_time_limit
    if type(duration) not in (int, float) or duration <= 0 or duration % 60:
        raise CompatibilityError("execution_time_limit must be positive whole minutes, in seconds")
    image = text(os.environ.get("DAYTONA_IMAGE", ""), "DAYTONA_IMAGE")
    workdir = text(os.environ.get("DAYTONA_WORKDIR", ""), "DAYTONA_WORKDIR")
    if not image or not posixpath.isabs(workdir):
        raise CompatibilityError("Set DAYTONA_IMAGE and an absolute DAYTONA_WORKDIR")
    if name is not None and not text(name, "name"):
        raise CompatibilityError("name must not be empty")
    params = CreateSandboxFromImageParams(
        name=name or f"v2d-{uuid4()}", image=image, os_user=os.environ.get("DAYTONA_USER"),
        env_vars=string_map(env, "env"),
        labels={"vercel2daytona": "python", **{f"vercel.tag.{k}": v for k, v in string_map(tags, "tags").items()}},
        resources=Resources(cpu=2, memory=4, disk=10),
        ephemeral=True, auto_stop_interval=0, auto_delete_interval=0, ttl_minutes=int(duration / 60),
    )
    client = AsyncDaytona(DaytonaConfig(otel_enabled=False))
    pending = asyncio.create_task(client.create(params, timeout=60))
    try:
        native = await asyncio.shield(pending)
    except asyncio.CancelledError as cancelled:
        failures = [cancelled]
        try:
            native = await pending
            await native.delete(timeout=60, wait=True)
        except BaseException as cleanup:
            failures.append(cleanup)
        try:
            await client.close()
        except BaseException as cleanup:
            failures.append(cleanup)
        if len(failures) > 1:
            raise BaseExceptionGroup("Creation cancelled; cleanup failed", failures) from None
        raise
    except BaseException as error:
        try:
            await client.close()
        except BaseException as cleanup:
            raise BaseExceptionGroup("Creation and client cleanup failed", [error, cleanup]) from None
        raise
    return Sandbox(native, client, workdir)


class CreateSandboxOperation:
    def __init__(self, options):
        self._options = options
        self._used = False
        self._box = None

    async def _start(self):
        if self._used:
            raise CompatibilityError("A create operation can only be used once")
        self._used = True
        self._box = await _create(**self._options)
        return self._box

    def __await__(self):
        return self._start().__await__()

    async def __aenter__(self):
        return await self._start()

    async def __aexit__(self, kind, error, traceback):
        try:
            await self._box.destroy()
        except BaseException as cleanup:
            if error is not None:
                raise BaseExceptionGroup("Program and cleanup failed", [error, cleanup]) from None
            raise


def create_sandbox(**options):
    return CreateSandboxOperation(options)
