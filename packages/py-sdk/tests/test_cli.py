import ast
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from vercel2daytona.analyze import CREATE, RUN, analyze
from vercel2daytona.cli import apply, main

PREFIX = "from vercel import sandbox\n"
BODY = "with sandbox.create_sandbox(persistent=False) as box:\n    result = box.run_process('python', ['-V'], capture_output=True)\n    print(result.stdout)\n"


def errors(source):
    return [d for d in analyze(source)["diagnostics"] if d["severity"] == "error"]


class AnalyzeTests(unittest.TestCase):
    def test_live_fixtures_have_only_configuration_warnings(self):
        for name in ["async_app.py", "sync_app.py"]:
            source = (Path(__file__).parent / "fixtures" / name).read_text()
            result = analyze(source)
            self.assertFalse(errors(source), result["diagnostics"])
            self.assertEqual(len(result["edits"]), 2)
            self.assertEqual({d["code"] for d in result["diagnostics"]}, {"V2D_CONFIG", "V2D_TTL"})

    def test_async_and_sync_import_forms(self):
        for prefix in [PREFIX, "from vercel.sandbox import sync as sandbox\n", "import vercel.sandbox as sandbox\n", "import vercel.sandbox.sync as sandbox\n"]:
            with self.subTest(prefix=prefix):
                result = analyze(prefix + BODY)
                self.assertFalse(errors(prefix + BODY))
                self.assertEqual(len(result["edits"]), 1)
        source = "from vercel.sandbox import create_sandbox as create\nasync def main():\n    async with create(persistent=False) as box:\n        await box.destroy()\n"
        self.assertFalse(errors(source))

    def test_blockers_and_dynamic_options(self):
        for body, code in [
            ("box = sandbox.create_sandbox()", "V2D_PERSISTENCE"),
            ("box = sandbox.create_sandbox(persistent=False, ports=[80])", "V2D_OPTIONS"),
            ("box = sandbox.create_sandbox(persistent=False, **options)", "V2D_OPTIONS"),
            ("box = sandbox.create_sandbox(persistent=False, execution_time_limit=61)", "V2D_TTL"),
            (BODY + "box.snapshot()", "V2D_METHOD"),
            (BODY + "box.run_process('python')", "V2D_OUTPUT"),
            (BODY + "box.run_process('python', capture_output=True, env={'KEY':'x'})", "V2D_OPTIONS"),
            (BODY + "box.run_process(*args, capture_output=True)", "V2D_OPTIONS"),
            (BODY + "box.fs.open('file')", "V2D_METHOD"),
            (BODY + "box.fs.mkdir('file', recursive=False)", "V2D_OPTIONS"),
        ]:
            with self.subTest(body=body):
                self.assertIn(code, [d["code"] for d in errors(PREFIX + body)])

    def test_aliases_shadowing_and_handle_escape(self):
        self.assertFalse(errors(PREFIX + "sdk = sandbox\n" + BODY.replace("sandbox.create", "sdk.create")))
        for suffix in ["consumer(box)", "objects = [box]", "objects = {'box':box}", "box['snapshot']()", "run = box.run_process", "create = lambda: sandbox.create_sandbox(persistent=False)", "def f(sandbox):\n    return sandbox\n"]:
            with self.subTest(suffix=suffix):
                self.assertIn("V2D_FLOW", [d["code"] for d in errors(PREFIX + BODY + suffix)])
        self.assertTrue(errors(PREFIX + "def f():\n    return sandbox.create_sandbox(persistent=False)\n"))

    def test_unsupported_imports_syntax_and_migrated_code(self):
        for source in ["import vercel", "from vercel import sandbox, blob", "from vercel.sandbox import *", "from vercel.api import session", "__import__('vercel.sandbox')", "importlib.import_module('vercel.sandbox')", "box = ("]:
            self.assertTrue(errors(source), source)
        self.assertFalse(errors("from vercel import blob\n" + PREFIX + BODY))
        self.assertFalse(errors((PREFIX + BODY).replace("vercel", "vercel2daytona")))
        self.assertEqual(analyze((PREFIX + BODY).replace("vercel", "vercel2daytona"))["edits"], [])

    def test_public_sdk_contract_matches_supported_keywords(self):
        import inspect
        from vercel import sandbox
        self.assertTrue(CREATE <= set(inspect.signature(sandbox.create_sandbox).parameters))
        self.assertTrue(RUN <= set(inspect.signature(sandbox.Sandbox.run_process).parameters))


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = self.root / "app.py"
        self.app.write_text(PREFIX + BODY)

    def call(self, *args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            status = main([args[0], str(self.root), *args[1:], "--json"])
        return status, output.getvalue()

    def test_preview_apply_backup_and_second_write(self):
        original = self.app.read_bytes()
        status, preview = self.call("migrate")
        self.assertEqual(status, 0)
        self.assertIn("+from vercel2daytona import sandbox", json.loads(preview)["diff"])
        self.assertEqual(self.app.read_bytes(), original)
        status, output = self.call("migrate", "--write")
        self.assertEqual(status, 0)
        self.assertTrue(json.loads(output)["applied"])
        self.assertEqual(self.app.read_bytes(), original.replace(b"from vercel ", b"from vercel2daytona "))
        self.assertEqual(Path(str(self.app) + ".vercel2daytona.bak").read_bytes(), original)
        self.assertFalse(json.loads(self.call("migrate", "--write")[1])["applied"])

    def test_one_blocker_prevents_all_writes(self):
        (self.root / "bad.py").write_text(PREFIX + "box = sandbox.create_sandbox()\n")
        self.assertEqual(self.call("migrate", "--write")[0], 1)
        self.assertEqual(self.app.read_text(), PREFIX + BODY)
        self.assertFalse(list(self.root.glob("*.bak")))

    def test_never_executes_source_and_skips_hidden_generated_symlinks(self):
        (self.root / "trap.py").write_text("raise RuntimeError('must never execute')\n")
        for name in [".private", "venv", "node_modules", "__pycache__"]:
            (self.root / name).mkdir()
            (self.root / name / "bad.py").write_text("invalid syntax !!!")
        (self.root / "linked.py").symlink_to(self.app)
        status, output = self.call("lint")
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)["files"], 2)
        self.assertEqual(self.call("lint", "--strict")[0], 1)

    def test_refuses_existing_backup_and_concurrent_edits(self):
        backup = Path(str(self.app) + ".vercel2daytona.bak")
        backup.write_text("user backup")
        self.assertEqual(self.call("migrate", "--write")[0], 2)
        self.assertEqual(backup.read_text(), "user backup")
        with self.assertRaisesRegex(ValueError, "changed since analysis"):
            apply(self.root, [(self.app, b"stale", b"new")])

    def test_preserves_encoding_comments_strings_and_line_endings(self):
        original = ("# coding: latin-1\r\n# café vercel\r\nfrom vercel.sandbox import (\r\n    sync as sandbox,\r\n)\r\ntext = 'vercel'\r\n" + BODY.replace("\n", "\r\n")).encode("latin-1")
        self.app.write_bytes(original)
        self.assertEqual(self.call("migrate", "--write")[0], 0)
        self.assertEqual(self.app.read_bytes(), original.replace(b"from vercel.", b"from vercel2daytona."))
        ast.parse(self.app.read_bytes())


if __name__ == "__main__":
    unittest.main()
