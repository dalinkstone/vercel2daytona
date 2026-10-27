"""Synchronous facade; each sandbox owns its asyncio runner and client."""

import asyncio
import threading

from ._adapter import CompatibilityError, CompletedProcess, SandboxPathNotFoundError, _create


class Filesystem:
    def __init__(self, owner):
        self._owner = owner

    def mkdir(self, *args, **kwargs):
        return self._owner._run(self._owner._box.fs.mkdir, *args, **kwargs)

    def read_bytes(self, *args, **kwargs):
        return self._owner._run(self._owner._box.fs.read_bytes, *args, **kwargs)

    def read_text(self, *args, **kwargs):
        return self._owner._run(self._owner._box.fs.read_text, *args, **kwargs)

    def write_bytes(self, *args, **kwargs):
        return self._owner._run(self._owner._box.fs.write_bytes, *args, **kwargs)

    def write_text(self, *args, **kwargs):
        return self._owner._run(self._owner._box.fs.write_text, *args, **kwargs)


def _no_running_loop():
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise CompatibilityError("Use the async API inside an event loop")


class SyncSandbox:
    def __init__(self, box, runner):
        self._box = box
        self._runner = runner
        self._thread = threading.get_ident()
        self._closed = False
        self.name = box.name
        self.fs = Filesystem(self)

    def _run(self, function, *args, **kwargs):
        _no_running_loop()
        if self._closed or threading.get_ident() != self._thread:
            raise CompatibilityError("Use a live sync sandbox on the thread that created it")
        return self._runner.run(function(*args, **kwargs))

    def run_process(self, *args, **kwargs):
        return self._run(self._box.run_process, *args, **kwargs)

    def destroy(self, **options):
        if self._closed:
            if options:
                raise CompatibilityError("destroy does not accept options")
            return self
        self._run(self._box.destroy, **options)
        self._runner.close()
        self._closed = True
        return self

    def stop(self, **options):
        return self.destroy(**options)

    def __enter__(self):
        if self._closed:
            raise CompatibilityError("Sandbox has been destroyed")
        return self

    def __exit__(self, kind, error, traceback):
        try:
            self.destroy()
        except BaseException as cleanup:
            if error is not None:
                raise BaseExceptionGroup("Program and cleanup failed", [error, cleanup]) from None
            raise


def create_sandbox(**options):
    _no_running_loop()
    runner = asyncio.Runner()
    try:
        box = runner.run(_create(**options))
        return SyncSandbox(box, runner)
    except BaseException:
        runner.close()
        raise


__all__ = ["create_sandbox", "SyncSandbox", "CompletedProcess", "SandboxPathNotFoundError", "CompatibilityError"]
