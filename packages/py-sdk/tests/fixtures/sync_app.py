import hashlib
import json
import os
from subprocess import CalledProcessError

from vercel.sandbox import sync as sandbox
from vercel.sandbox import SandboxPathNotFoundError


def main():
    with sandbox.create_sandbox(
        name=os.environ["V2D_SANDBOX_NAME"], persistent=False,
        execution_time_limit=300, env={"REPORT_LABEL": "migration"},
    ) as box:
        box.fs.mkdir("report-job")
        box.fs.write_text("report-job/input.json", "[2, 4, 8]", mode=0o640)
        binary = b"\x00\x01\x7f\x80\xff"
        box.fs.write_bytes("report-job/data.bin", binary)
        assert box.fs.read_bytes("report-job/data.bin") == binary
        try:
            box.fs.read_bytes("report-job/missing")
            raise AssertionError("Missing file was accepted")
        except SandboxPathNotFoundError:
            pass
        script = "import json,os,pathlib,sys; p=pathlib.Path('report-job'); values=json.loads((p/'input.json').read_text()); report={'sum':sum(values),'label':os.environ['REPORT_LABEL']}; (p/'report.json').write_text(json.dumps(report)); print(json.dumps(report)); print('report-built',file=sys.stderr)"
        result = box.run_process("python", ["-c", script], capture_output=True, check=True)
        report = json.loads(result.stdout)
        assert report == {"sum": 14, "label": "migration"}
        assert result.stderr == "report-built\n"
        content = box.fs.read_bytes("report-job/report.json")
        assert json.loads(content) == report
        mode = box.run_process("stat", ["-c", "%a", "report-job/input.json"], capture_output=True, check=True)
        assert mode.stdout.strip() == "640"
        args = ["two words", "apostrophe'", "$(printf injected)", "*", ""]
        quoted = box.run_process("python", ["-c", "import json,sys; print(json.dumps([sys.argv[1:],sys.stdin.read()]))", *args], capture_output=True, check=True)
        assert json.loads(quoted.stdout) == [args, ""]
        try:
            box.run_process("python", ["-c", "import sys; print('rejected',file=sys.stderr); sys.exit(7)"], capture_output=True, check=True)
            raise AssertionError("Nonzero command did not raise")
        except CalledProcessError as error:
            assert error.returncode == 7 and error.stderr == "rejected\n"
        print(json.dumps({"report": report, "sha256": hashlib.sha256(content).hexdigest(), "stdout": result.stdout, "stderr": result.stderr, "mode": mode.stdout.strip(), "binary": binary.hex(), "argv": json.loads(quoted.stdout), "failureExitCode": 7}))


if __name__ == "__main__":
    main()
