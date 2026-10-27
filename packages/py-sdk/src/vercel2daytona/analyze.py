"""Conservative Python AST analysis; never imports the application."""

import ast
import io
import tokenize

MODULES = {"vercel", "vercel.sandbox", "vercel.sandbox.sync", "vercel2daytona", "vercel2daytona.sandbox", "vercel2daytona.sandbox.sync"}
CREATE = {"name", "persistent", "execution_time_limit", "env", "tags", "destroy"}
RUN = {"command", "args", "cwd", "capture_output", "check"}
FILE_OPTIONS = {
    "mkdir": {"path", "cwd", "recursive"},
    "read_bytes": {"path", "cwd"},
    "read_text": {"path", "cwd", "encoding", "errors"},
    "write_bytes": {"path", "data", "cwd", "mode"},
    "write_text": {"path", "text", "cwd", "mode", "encoding", "errors"},
}
MEMBERS = {
    "module": {"create_sandbox"},
    "box": {"name", "fs", "run_process", "stop", "destroy"},
    "fs": set(FILE_OPTIONS),
    "result": {"args", "returncode", "stdout", "stderr", "check_returncode"},
}
METHODS = {"create_sandbox", "run_process", "stop", "destroy", "check_returncode", *FILE_OPTIONS}


def constant(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mult)):
        left, right = constant(node.left), constant(node.right)
        if type(left) in (int, float) and type(right) in (int, float):
            return left + right if isinstance(node.op, ast.Add) else left * right
    return None


class Analyzer(ast.NodeVisitor):
    def __init__(self, source, tree):
        self.source = source
        self.lines = source.splitlines(keepends=True)
        self.bindings = {}
        self.diagnostics = []
        self.edits = []
        self.imports = 0
        self.parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

    def report(self, node, code, message, severity="error"):
        self.diagnostics.append({"line": node.lineno, "column": node.col_offset + 1, "severity": severity, "code": code, "message": message})

    def kind(self, node):
        if isinstance(node, ast.Await):
            return self.kind(node.value)
        if isinstance(node, ast.Name):
            return self.bindings.get(node.id)
        if isinstance(node, ast.Attribute) and self.kind(node.value) == "box" and node.attr == "fs":
            return "fs"
        if isinstance(node, ast.Call):
            if self.method(node.func) == ("module", "create_sandbox"):
                return "box"
            if self.method(node.func) == ("box", "run_process"):
                return "result"
        return None

    def method(self, node):
        if isinstance(node, ast.Name) and self.bindings.get(node.id) == "create":
            return "module", "create_sandbox"
        if isinstance(node, ast.Attribute):
            return self.kind(node.value), node.attr
        return None, None

    def import_edit(self, node):
        segment = ast.get_source_segment(self.source, node)
        local_lines = segment.splitlines(keepends=True)
        base = sum(map(len, self.lines[:node.lineno - 1]))
        base += len(self.lines[node.lineno - 1].encode("utf8")[:node.col_offset].decode("utf8"))
        for token in tokenize.generate_tokens(io.StringIO(segment).readline):
            if token.type == tokenize.NAME and token.string == "vercel":
                offset = base + sum(map(len, local_lines[:token.start[0] - 1])) + token.start[1]
                self.edits.append({"start": offset, "end": offset + len("vercel"), "replacement": "vercel2daytona"})
                return

    def visit_ImportFrom(self, node):
        module = node.module or ""
        if node.level or not module.startswith(("vercel", "vercel2daytona")):
            return
        if module == "vercel" and all(item.name != "sandbox" for item in node.names):
            return
        if module not in MODULES:
            self.report(node, "V2D_IMPORT", "Provider submodules and custom sessions need manual migration")
            return
        valid = True
        for item in node.names:
            binding = item.asname or item.name
            if module in {"vercel", "vercel2daytona"} and item.name == "sandbox":
                self.bindings[binding] = "module"
            elif module.endswith(".sandbox") and item.name == "sync":
                self.bindings[binding] = "module"
            elif module.endswith((".sandbox", ".sandbox.sync")) and item.name == "create_sandbox":
                self.bindings[binding] = "create"
            elif module.endswith((".sandbox", ".sandbox.sync")) and item.name in {"CompletedProcess", "SandboxPathNotFoundError"}:
                pass
            else:
                valid = False
                self.report(node, "V2D_IMPORT", f"{item.name} has no automatic Python mapping")
        self.imports += 1
        self.report(node, "V2D_CONFIG", "Configure Daytona credentials, DAYTONA_IMAGE and DAYTONA_WORKDIR", "warning")
        if valid and (module.startswith("vercel.") or module == "vercel"):
            self.import_edit(node)

    def visit_Import(self, node):
        for item in node.names:
            if not item.name.startswith(("vercel", "vercel2daytona")):
                continue
            if item.name not in MODULES or not item.name.endswith((".sandbox", ".sandbox.sync")) or not item.asname or len(node.names) != 1:
                self.report(node, "V2D_IMPORT", "Use an aliased sandbox import or from vercel import sandbox")
                continue
            self.bindings[item.asname] = "module"
            self.imports += 1
            self.report(node, "V2D_CONFIG", "Configure Daytona credentials, DAYTONA_IMAGE and DAYTONA_WORKDIR", "warning")
            if item.name.startswith("vercel."):
                self.import_edit(node)

    def visit_FunctionDef(self, node):
        outer = self.bindings
        self.bindings = dict(outer)
        for arg in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs):
            if arg.arg in self.bindings:
                self.report(node, "V2D_FLOW", "Shadowed provider names require manual review")
                self.bindings.pop(arg.arg)
        for statement in node.body:
            self.visit(statement)
        self.bindings = outer

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Assign(self, node):
        self.visit(node.value)
        kind = self.kind(node.value)
        for target in node.targets:
            if isinstance(target, ast.Name):
                if target.id in self.bindings and self.bindings[target.id] != kind:
                    self.report(node, "V2D_FLOW", "Reassigned provider names require manual review")
                if kind:
                    self.bindings[target.id] = kind
                else:
                    self.bindings.pop(target.id, None)
            elif kind:
                self.report(node, "V2D_FLOW", "Stored or destructured provider handles require manual review")

    def visit_AnnAssign(self, node):
        if node.value:
            self.visit_Assign(ast.Assign(targets=[node.target], value=node.value, lineno=node.lineno, col_offset=node.col_offset))

    def visit_With(self, node):
        for item in node.items:
            self.visit(item.context_expr)
            kind = self.kind(item.context_expr)
            if kind and isinstance(item.optional_vars, ast.Name):
                self.bindings[item.optional_vars.id] = kind
        for statement in node.body:
            self.visit(statement)

    visit_AsyncWith = visit_With

    def visit_Attribute(self, node):
        kind = self.kind(node.value)
        if kind in MEMBERS:
            if node.attr not in MEMBERS[kind]:
                self.report(node, "V2D_METHOD", f"{kind}.{node.attr} needs a native Daytona migration")
            elif node.attr in METHODS:
                parent = self.parents.get(node)
                if not isinstance(parent, ast.Call) or parent.func is not node:
                    self.report(node, "V2D_FLOW", "Extracted provider methods require manual review")
        self.generic_visit(node)

    def visit_Call(self, node):
        kind, method = self.method(node.func)
        allowed = None
        if (kind, method) == ("module", "create_sandbox"):
            allowed = CREATE
            if node.args:
                self.report(node, "V2D_OPTIONS", "create_sandbox accepts keyword arguments only")
            options = {k.arg: k.value for k in node.keywords}
            if constant(options.get("persistent")) is not False:
                self.report(node, "V2D_PERSISTENCE", "Set persistent=False")
            if "destroy" in options and constant(options["destroy"]) is not True:
                self.report(node, "V2D_PERSISTENCE", "destroy=False is unsupported")
            if "execution_time_limit" in options:
                value = constant(options["execution_time_limit"])
                if type(value) not in (int, float) or value <= 0 or value % 60:
                    self.report(node, "V2D_TTL", "Use a positive whole-minute execution_time_limit in seconds")
            self.report(node, "V2D_TTL", "Expiry and stop destroy the disposable Daytona sandbox", "warning")
        elif (kind, method) == ("box", "run_process"):
            allowed = RUN
            options = {k.arg: k.value for k in node.keywords}
            if constant(options.get("capture_output")) is not True:
                self.report(node, "V2D_OUTPUT", "Set capture_output=True; live output is unsupported")
            if len(node.args) > 2:
                self.report(node, "V2D_OPTIONS", "Only command and args can be positional")
        elif kind == "fs" and method in FILE_OPTIONS:
            allowed = FILE_OPTIONS[method]
            if method == "mkdir":
                for k in node.keywords:
                    if k.arg == "recursive" and constant(k.value) is not True:
                        self.report(node, "V2D_OPTIONS", "mkdir requires recursive=True")
        elif kind == "box" and method in {"stop", "destroy"} or kind == "result" and method == "check_returncode":
            allowed = set()
            if node.args:
                self.report(node, "V2D_OPTIONS", f"{method} accepts no arguments")
        if allowed is not None:
            if any(isinstance(arg, ast.Starred) for arg in node.args):
                self.report(node, "V2D_OPTIONS", "Expanded positional arguments require manual review")
            for keyword in node.keywords:
                if keyword.arg not in allowed:
                    self.report(keyword, "V2D_OPTIONS", f"{keyword.arg or '**options'} needs manual migration")
        for arg in (*node.args, *(k.value for k in node.keywords)):
            if self.kind(arg):
                self.report(arg, "V2D_FLOW", "Provider handle passed to another function; review its consumers")
        dynamic = isinstance(node.func, ast.Name) and node.func.id == "__import__" or isinstance(node.func, ast.Attribute) and node.func.attr == "import_module"
        if dynamic and node.args and isinstance(node.args[0], ast.Constant) and str(node.args[0].value).startswith("vercel"):
            self.report(node, "V2D_IMPORT", "Dynamic provider imports require manual review")
        self.generic_visit(node)

    def visit_Return(self, node):
        if node.value and self.kind(node.value):
            self.report(node, "V2D_FLOW", "Provider handle escapes this function; review its consumers")
        self.generic_visit(node)

    def visit_Lambda(self, node):
        if self.kind(node.body):
            self.report(node, "V2D_FLOW", "Provider handle escapes this lambda; review its consumers")
        self.generic_visit(node)

    def visit_Subscript(self, node):
        if self.kind(node.value):
            self.report(node, "V2D_FLOW", "Computed provider access requires manual review")
        self.generic_visit(node)

    def visit_Dict(self, node):
        for value in node.values:
            if self.kind(value):
                self.report(value, "V2D_FLOW", "Provider handle stored in a container; review its consumers")
        self.generic_visit(node)

    def visit_List(self, node):
        for value in node.elts:
            if self.kind(value):
                self.report(value, "V2D_FLOW", "Provider handle stored in a container; review its consumers")
        self.generic_visit(node)

    visit_Tuple = visit_List
    visit_Set = visit_List


def analyze(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        return {"imports": 0, "edits": [], "diagnostics": [{"line": error.lineno or 1, "column": error.offset or 1, "severity": "error", "code": "V2D_SYNTAX", "message": error.msg}]}
    visitor = Analyzer(source, tree)
    visitor.visit(tree)
    return {"imports": visitor.imports, "edits": visitor.edits, "diagnostics": visitor.diagnostics}
