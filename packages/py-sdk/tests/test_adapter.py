import asyncio
import os
import socket
import subprocess
import tempfile
import unittest
from datetime import timedelta
from pathlib import PurePosixPath
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from daytona import DaytonaFileNotFoundError
from vercel2daytona import sandbox
from vercel2daytona.sandbox import sync
from vercel2daytona.sandbox import _adapter


class NoNetwork(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        patch.object(socket.socket, "connect", side_effect=AssertionError("Network disabled")).start()
        patch.dict(os.environ, {"DAYTONA_IMAGE": "python:3.12-bookworm", "DAYTONA_WORKDIR": "/root"}, clear=True).start()


def native():
    box = NS(name="test", delete=AsyncMock(), fs=NS(
        upload_file=AsyncMock(), download_file=AsyncMock(return_value=b"hello"),
        create_folder=AsyncMock(), set_file_permissions=AsyncMock(),
    ), process=NS(
        create_session=AsyncMock(), execute_session_command=AsyncMock(return_value=NS(cmd_id="cmd")),
        get_session_command=AsyncMock(return_value=NS(exit_code=7)),
        get_session_command_logs=AsyncMock(return_value=NS(stdout="out", stderr="err")),
    ))
    client = NS(create=AsyncMock(return_value=box), close=AsyncMock())
    return box, client


class AdapterTests(NoNetwork, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.native, self.client = native()
        self.factory = patch.object(_adapter, "AsyncDaytona", return_value=self.client).start()

    async def test_lifecycle_uses_native_ttl_and_closes_client(self):
        op = sandbox.create_sandbox(persistent=False, execution_time_limit=timedelta(minutes=2), env={"A": "B"})
        async with op as box:
            params = self.client.create.call_args.args[0]
            self.assertEqual((params.ttl_minutes, params.auto_stop_interval, params.auto_delete_interval), (2, 0, 0))
            self.assertTrue(params.ephemeral)
            self.assertEqual(params.env_vars, {"A": "B"})
        self.native.delete.assert_awaited_once_with(timeout=60, wait=True)
        self.client.close.assert_awaited_once()
        await box.destroy()
        with self.assertRaises(sandbox.CompatibilityError):
            await op
        with self.assertRaises(sandbox.CompatibilityError):
            await box.fs.read_bytes("file")

    async def test_unsupported_creation_fails_before_client(self):
        for params in [{}, {"persistent": True}, {"persistent": False, "ports": [80]}, {"persistent": False, "destroy": False}, {"persistent": False, "execution_time_limit": 61}, {"persistent": False, "env": {"A": 1}}]:
            with self.subTest(params=params), self.assertRaises(sandbox.CompatibilityError):
                await sandbox.create_sandbox(**params)
        self.factory.assert_not_called()

    async def test_commands_preserve_exit_and_streams(self):
        async with sandbox.create_sandbox(persistent=False) as box:
            result = await box.run_process("python", ["-V"], capture_output=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (7, "out", "err"))
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                await box.run_process("python", ["-V"], capture_output=True, check=True)
            self.assertEqual(caught.exception.stderr, "err")

    async def test_rejects_command_options_before_launch(self):
        async with sandbox.create_sandbox(persistent=False) as box:
            for options in [{}, {"capture_output": True, "env": {"KEY": "value"}}, {"capture_output": True, "kill_after": 1}, {"capture_output": True, "input": "x"}]:
                with self.assertRaises(sandbox.CompatibilityError):
                    await box.run_process("python", **options)
            self.native.process.create_session.assert_not_called()

    async def test_shell_quoting_and_closed_stdin(self):
        with tempfile.TemporaryDirectory(prefix="v2d quote '") as directory:
            os.environ["DAYTONA_WORKDIR"] = directory
            async with sandbox.create_sandbox(persistent=False) as box:
                args = ["two words", "apostrophe'", "$(printf injected)", "; echo injected", "*", ""]
                await box.run_process("/usr/bin/printf", ["%s\\n", *args], capture_output=True)
                request = self.native.process.execute_session_command.call_args.args[1]
                run = subprocess.run(["/bin/sh", "-c", request.command], capture_output=True, text=True, check=True)
                self.assertEqual(run.stdout.splitlines(), args)
                self.assertTrue(request.run_async)
                self.assertTrue(request.suppress_input_echo)
                self.assertTrue(request.command.endswith("< /dev/null"))

    async def test_files_modes_paths_and_typed_missing_error(self):
        async with sandbox.create_sandbox(persistent=False) as box:
            await box.fs.write_bytes(PurePosixPath("data.bin"), b"\0\xff", cwd="job", mode=0o640)
            self.native.fs.upload_file.assert_awaited_with(b"\0\xff", "/root/job/data.bin")
            self.native.fs.set_file_permissions.assert_awaited_with("/root/job/data.bin", mode="640")
            await box.fs.write_text("text", text="héllo")
            self.native.fs.upload_file.assert_awaited_with("héllo".encode(), "/root/text")
            self.assertEqual(await box.fs.read_text("text"), "hello")
            self.native.fs.download_file.side_effect = DaytonaFileNotFoundError("gone")
            with self.assertRaises(sandbox.SandboxPathNotFoundError):
                await box.fs.read_bytes("gone")
            self.native.fs.download_file.side_effect = RuntimeError("auth failure")
            with self.assertRaisesRegex(RuntimeError, "auth failure"):
                await box.fs.read_bytes("file")
            calls = self.native.fs.upload_file.call_count
            with self.assertRaises(sandbox.CompatibilityError):
                await box.fs.write_bytes("file", b"x", mode=0o7777)
            self.assertEqual(calls, self.native.fs.upload_file.call_count)

    async def test_cleanup_preserves_both_errors_and_can_retry(self):
        self.native.delete.side_effect = RuntimeError("delete failed")
        with self.assertRaises(ExceptionGroup) as caught:
            async with sandbox.create_sandbox(persistent=False) as box:
                raise ValueError("work failed")
        self.assertEqual([str(e) for e in caught.exception.exceptions], ["work failed", "delete failed"])
        self.native.delete.side_effect = None
        await box.destroy()

    async def test_cancelled_creation_cleans_up_late_result(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def create(*args, **kwargs):
            started.set()
            await finish.wait()
            return self.native
        self.client.create.side_effect = create
        task = asyncio.ensure_future(sandbox.create_sandbox(persistent=False))
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        finish.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.native.delete.assert_awaited_once_with(timeout=60, wait=True)
        self.client.close.assert_awaited_once()

    async def test_failed_client_close_retries_without_deleting_again(self):
        box = await sandbox.create_sandbox(persistent=False)
        self.client.close.side_effect = RuntimeError("close failed")
        with self.assertRaisesRegex(RuntimeError, "close failed"):
            await box.destroy()
        self.client.close.side_effect = None
        await box.destroy()
        self.native.delete.assert_awaited_once()
        self.assertEqual(self.client.close.await_count, 2)

    async def test_cancelled_destroy_preserves_failure_and_allows_retry(self):
        box = await sandbox.create_sandbox(persistent=False)
        started, finish = asyncio.Event(), asyncio.Event()

        async def delete(**kwargs):
            started.set()
            await finish.wait()
            raise RuntimeError("delete failed")

        self.native.delete.side_effect = delete
        task = asyncio.create_task(box.destroy())
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        finish.set()
        with self.assertRaises(BaseExceptionGroup) as caught:
            await task
        self.assertIsInstance(caught.exception.exceptions[0], asyncio.CancelledError)
        self.assertEqual(str(caught.exception.exceptions[1]), "delete failed")
        self.native.delete.side_effect = None
        await box.destroy()
        self.assertEqual(self.native.delete.await_count, 2)
        self.client.close.assert_awaited_once()

    async def test_creation_and_close_errors_are_both_preserved(self):
        self.client.create.side_effect = ValueError("create failed")
        self.client.close.side_effect = RuntimeError("close failed")
        with self.assertRaises(ExceptionGroup) as caught:
            await sandbox.create_sandbox(persistent=False)
        self.assertEqual([str(e) for e in caught.exception.exceptions], ["create failed", "close failed"])

    async def test_sync_api_rejects_active_loop_before_creation(self):
        with self.assertRaises(sandbox.CompatibilityError):
            sync.create_sandbox(persistent=False)
        self.factory.assert_not_called()


class SyncTests(NoNetwork):
    def test_sync_facade_runs_same_adapter_and_cleans_up(self):
        box, client = native()
        with patch.object(_adapter, "AsyncDaytona", return_value=client):
            with sync.create_sandbox(persistent=False) as handle:
                self.assertEqual(handle.run_process("echo", capture_output=True).returncode, 7)
                handle.fs.write_text("hello", "world")
                self.assertEqual(handle.fs.read_text("hello"), "hello")
            handle.destroy()
            box.delete.assert_awaited_once()
            client.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
