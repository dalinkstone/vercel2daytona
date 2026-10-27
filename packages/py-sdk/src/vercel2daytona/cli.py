import argparse
import difflib
import io
import json
import os
import stat
import sys
import tokenize
from pathlib import Path

from .analyze import analyze

SKIP = {"node_modules", "dist", "build", "vendor", "venv", "env", "__pycache__", "site-packages"}


def collect(root):
    for folder, directories, names in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if not d.startswith(".") and d not in SKIP and not Path(folder, d).is_symlink())
        for name in sorted(names):
            path = Path(folder, name)
            if name.endswith(".py") and not name.startswith(".") and not path.is_symlink():
                yield path


def apply(root, changes):
    for path, before, after in changes:
        if path.resolve() != path or not path.is_relative_to(root) or not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError(f"Refusing non-regular path: {path}")
        if path.read_bytes() != before:
            raise ValueError(f"File changed since analysis: {path}")
        if Path(str(path) + ".vercel2daytona.bak").exists():
            raise ValueError(f"Backup already exists: {path}")
    for path, before, after in changes:
        with open(str(path) + ".vercel2daytona.bak", "xb") as backup:
            os.chmod(backup.name, stat.S_IMODE(path.stat().st_mode))
            backup.write(before)
    for path, before, after in changes:
        fd = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "r+b") as target:
            if target.read() != before:
                raise ValueError(f"File changed before write: {path}; restore its backup")
            target.seek(0)
            target.write(after)
            target.truncate()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check and migrate supported Vercel Sandbox Python imports")
    parser.add_argument("command", choices=["lint", "migrate"])
    parser.add_argument("directory", nargs="?", default=".")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true", help="Treat review warnings as errors")
    parser.add_argument("--write", action="store_true", help="Apply migration with exclusive backups")
    args = parser.parse_args(argv)
    if args.write and args.command != "migrate":
        parser.error("--write requires migrate")
    try:
        root = Path(args.directory).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("Pass a project directory")
        changes, diagnostics = [], []
        files = imports = 0
        for path in collect(root):
            before = path.read_bytes()
            encoding, _ = tokenize.detect_encoding(io.BytesIO(before).readline)
            source = before.decode(encoding)
            result = analyze(source)
            files += 1
            imports += result["imports"]
            diagnostics.extend({"file": str(path.relative_to(root)), **item} for item in result["diagnostics"])
            after = source
            for edit in sorted(result["edits"], key=lambda e: e["start"], reverse=True):
                after = after[:edit["start"]] + edit["replacement"] + after[edit["end"]:]
            if after != source and args.command == "migrate":
                changes.append((path, before, after.encode(encoding)))
        blocked = any(d["severity"] == "error" or args.strict for d in diagnostics)
        if blocked:
            changes = []
        if args.write and not blocked:
            apply(root, changes)
        patches = []
        for path, before, after in changes:
            encoding, _ = tokenize.detect_encoding(io.BytesIO(before).readline)
            name = str(path.relative_to(root))
            patches.append("".join(difflib.unified_diff(before.decode(encoding).splitlines(keepends=True), after.decode(encoding).splitlines(keepends=True), fromfile=name, tofile=name)))
        report = {"files": files, "imports": imports, "blocked": blocked, "applied": bool(args.write and changes), "diagnostics": diagnostics, "changes": [str(p.relative_to(root)) for p, _, _ in changes], "diff": "\n".join(patches)}
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            for d in diagnostics:
                print(f'{d["file"]}:{d["line"]}:{d["column"]} {d["severity"]} {d["code"]} {d["message"]}')
            for path, before, after in changes:
                print(f'{"Updated" if args.write else "Would update"} {path.relative_to(root)}')
            if not args.write and patches:
                print(report["diff"])
            print(f'{files} Python files; {imports} SDK imports; {"blocked" if blocked else str(len(changes)) + " changes"}')
        return 1 if blocked else 0
    except (OSError, ValueError, UnicodeError, SyntaxError) as error:
        print(f"vercel2daytona: {error}", file=sys.stderr)
        return 2
