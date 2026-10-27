import ts from 'typescript';
import { COMMAND_KEYS, COMMAND_METHODS, COMMAND_PROPERTIES, CREATE_KEYS, SANDBOX_METHODS, SANDBOX_PROPERTIES } from './contracts.js';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  helpUrl: string;
}
export interface Edit { file: string; start: number; end: number; replacement: string }
export interface Analysis { diagnostics: Diagnostic[]; edits: Edit[]; imports: number }
type Kind = 'class' | 'namespace' | 'sandbox' | 'command';
const modules = new Set(['@vercel/sandbox', 'vercel2daytona']);
const helpSections: Record<string, string> = {
  V2D_CONFIG: 'configuration', V2D_IMAGE: 'configuration',
  V2D_PERSISTENCE: 'lifecycle', V2D_STOP_RESULT: 'lifecycle', V2D_TTL: 'lifecycle',
  V2D_TIMEOUT: 'deadlines', V2D_OPTION: 'unsupported-options', V2D_PREVIEW: 'preview-access',
};
const helpUrl = (code: string) => `https://github.com/dalinkstone/vercel2daytona/blob/main/skills/vercel2daytona/references/migration.md#${helpSections[code] ?? 'manual-migration'}`;

function optionMessage(key: string): string {
  if (['token', 'teamId', 'projectId'].includes(key)) return `${key} is a Vercel credential; remove it from creation options and configure DAYTONA_API_KEY in the backend environment.`;
  if (key === 'env') return 'Per-command env is unsupported. Move values to create({ env }) only if they should apply to every command; otherwise use native Daytona execution.';
  return `${key} has no supported adapter mapping. Preserve its behavior with native Daytona code; do not just remove the option.`;
}

/** Conservative source analysis, never imports or executes the application. */
export function analyze(files: Record<string, string>): Analysis {
  const host = ts.createCompilerHost({});
  host.readFile = file => files[file];
  host.fileExists = file => Object.hasOwn(files, file);
  host.getSourceFile = (file, version) => files[file] === undefined ? undefined : ts.createSourceFile(file, files[file]!, version, true);
  const program = ts.createProgram(Object.keys(files), { allowJs: true, noResolve: true, noLib: true, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker();
  const diagnostics: Diagnostic[] = [];
  const edits: Edit[] = [];
  const kinds = new Map<ts.Symbol, Kind>();
  let imports = 0;
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const set = (node: ts.Node, kind: Kind) => { const sym = symbol(node); if (sym) kinds.set(sym, kind); };
  const visit = (node: ts.Node, callback: (node: ts.Node) => void): void => { callback(node); ts.forEachChild(node, child => visit(child, callback)); };
  const report = (node: ts.Node, code: string, message: string, severity: Diagnostic['severity'] = 'error') => {
    const sf = node.getSourceFile();
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    diagnostics.push({ file: sf.fileName, line: pos.line + 1, column: pos.character + 1, severity, code, message, helpUrl: helpUrl(code) });
  };
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    return node;
  };
  const kindOf = (value: ts.Expression): Kind | undefined => {
    const node = unwrap(value);
    if (ts.isIdentifier(node)) return kinds.get(symbol(node)!);
    if (ts.isPropertyAccessExpression(node) && kindOf(node.expression) === 'namespace' && node.name.text === 'Sandbox') return 'class';
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const base = kindOf(node.expression.expression);
      const method = node.expression.name.text;
      if (base === 'class' && ['create', 'get', 'getOrCreate', 'fork'].includes(method)) return 'sandbox';
      if (base === 'sandbox' && ['runCommand', 'getCommand'].includes(method)) return 'command';
      if (base === 'command' && method === 'wait') return 'command';
    }
    return undefined;
  };
  const resolve = (value: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression => {
    const node = unwrap(value);
    if (ts.isIdentifier(node)) {
      const sym = symbol(node);
      const decl = sym?.valueDeclaration;
      if (sym && !seen.has(sym) && decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const)) {
        seen.add(sym);
        return resolve(decl.initializer, seen);
      }
    }
    return node;
  };
  const fields = (arg: ts.Expression | undefined, owner: ts.Node, allowed: readonly string[]): Map<string, ts.Expression> => {
    const result = new Map<string, ts.Expression>();
    if (!arg) return result;
    const node = resolve(arg);
    if (!ts.isObjectLiteralExpression(node)) {
      report(arg, 'V2D_DYNAMIC_OPTIONS', 'Options cannot be verified statically. Use a local const object or review a native Daytona migration.');
      return result;
    }
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) {
        report(property, 'V2D_DYNAMIC_OPTIONS', 'Spread/computed options require manual review.');
        continue;
      }
      const key = property.name.text;
      if (!allowed.includes(key)) report(property, 'V2D_OPTION', optionMessage(key));
      if (ts.isPropertyAssignment(property)) result.set(key, resolve(property.initializer));
      else if (ts.isShorthandPropertyAssignment(property)) {
        const sym = checker.getShorthandAssignmentValueSymbol(property);
        const decl = sym?.valueDeclaration;
        result.set(key, decl && ts.isVariableDeclaration(decl) && decl.initializer ? resolve(decl.initializer) : property.name);
      } else report(property, 'V2D_DYNAMIC_OPTIONS', 'Option methods/getters require manual review.');
    }
    return result;
  };
  const sources = program.getSourceFiles();
  for (const sf of sources) {
    for (const error of program.getSyntacticDiagnostics(sf)) {
      const pos = sf.getLineAndCharacterOfPosition(error.start ?? 0);
      diagnostics.push({ file: sf.fileName, line: pos.line + 1, column: pos.character + 1, severity: 'error', code: 'V2D_SYNTAX', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), helpUrl: helpUrl('V2D_SYNTAX') });
    }
    visit(sf, node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text)) {
        imports++;
        const bindings = node.importClause?.namedBindings;
        let supported = true;
        if (!node.importClause || node.importClause.name) { supported = false; report(node, 'V2D_IMPORT', 'Use a named Sandbox import; default and side-effect imports require review.'); }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) {
            const name = item.propertyName?.text ?? item.name.text;
            if (name === 'Sandbox') set(item.name, 'class');
            else if (['Command', 'CommandFinished'].includes(name) && (item.isTypeOnly || node.importClause?.isTypeOnly)) { /* Command types only; no provider constructors. */ }
            else { supported = false; report(item, 'V2D_EXPORT', `${name} is not implemented by the adapter (including Drive, Snapshot and Session).`); }
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) set(bindings.name, 'namespace');
        if (supported && node.moduleSpecifier.text === '@vercel/sandbox') edits.push({ file: sf.fileName, start: node.moduleSpecifier.getStart(sf) + 1, end: node.moduleSpecifier.end - 1, replacement: 'vercel2daytona' });
        report(node, 'V2D_CONFIG', 'Configure DAYTONA_API_KEY, DAYTONA_IMAGE and DAYTONA_WORKDIR. Check the image user, tools and paths.', 'warning');
        if (sf.statements.some(statement => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client')) report(node, 'V2D_CLIENT_RUNTIME', 'The Daytona adapter is for a trusted Node backend; move this import out of the client component.');
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text)) report(node, 'V2D_REEXPORT', 'Provider re-exports require manual review; migrate consumers together.');
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression) && modules.has(node.moduleReference.expression.text)) report(node, 'V2D_IMPORT', 'CommonJS import assignments require manual ESM migration.');
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && (modules.has(node.arguments[0].text) || node.arguments[0].text.startsWith('@vercel/sandbox/'))) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) report(node, 'V2D_IMPORT', 'Dynamic imports and require calls require manual ESM migration.');
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('@vercel/sandbox/')) report(node, 'V2D_IMPORT', 'Vercel Sandbox subpaths have no automatic mapping.');
    });
  }
  // Follow local aliases by symbol, so unrelated/shadowed variables are left alone.
  let changed = true;
  while (changed) {
    const size = kinds.size;
    for (const sf of sources) visit(sf, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const kind = kindOf(node.initializer);
        if (kind) set(node.name, kind);
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
        if (kinds.get(symbol(node.type.typeName)!) === 'class') set(node.name, 'sandbox');
      }
    });
    changed = kinds.size !== size;
  }
  for (const sf of sources) visit(sf, node => {
    if (ts.isElementAccessExpression(node) && kindOf(node.expression)) report(node, 'V2D_COMPUTED', 'Computed provider access requires manual review.');
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name) && node.initializer && kindOf(node.initializer)) report(node, 'V2D_FLOW', 'Destructured provider handles require manual review.');
    if (ts.isReturnStatement(node) && node.expression && kindOf(node.expression)) report(node, 'V2D_FLOW', 'Provider handle escapes this function; check all callers before migrating.');
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && kindOf(node.body)) report(node, 'V2D_FLOW', 'Provider handle escapes this function; check all callers before migrating.');
    if (ts.isPropertyAssignment(node) && kindOf(node.initializer)) report(node, 'V2D_FLOW', 'Provider handle stored in another object requires manual consumer review.');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && kindOf(node.right)) report(node, 'V2D_FLOW', 'Reassigned provider handles require manual review.');
    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments) if (kindOf(arg)) report(arg, 'V2D_FLOW', 'Provider handle passed to another function; check that function manually.');
    }
    if (!ts.isPropertyAccessExpression(node)) return;
    const kind = kindOf(node.expression);
    if (!kind) return;
    const name = node.name.text;
    if (kind === 'namespace') {
      if (name !== 'Sandbox') report(node, 'V2D_EXPORT', `${name} has no namespace mapping.`);
      return;
    }
    const methods: readonly string[] = kind === 'class' ? ['create', 'get'] : kind === 'sandbox' ? SANDBOX_METHODS : COMMAND_METHODS;
    const properties: readonly string[] = kind === 'sandbox' ? SANDBOX_PROPERTIES : kind === 'command' ? COMMAND_PROPERTIES : [];
    if (!methods.includes(name) && !properties.includes(name)) {
      report(node, 'V2D_METHOD', `${kind}.${name} has no supported mapping; use the native Daytona SDK for this capability.`);
      return;
    }
    if (!methods.includes(name)) return;
    const call = node.parent;
    if (!ts.isCallExpression(call) || call.expression !== node) { report(node, 'V2D_FLOW', 'Extracted provider methods require manual review.'); return; }
    if (kind === 'class' && name === 'create') {
      const options = fields(call.arguments[0], call, CREATE_KEYS);
      if (options.get('persistent')?.kind !== ts.SyntaxKind.FalseKeyword) report(call, 'V2D_PERSISTENCE', 'Use persistent: false only for an intentionally disposable job. Retained state or auto-resume requires a native Daytona lifecycle migration.');
      for (const key of ['runtime', 'image']) if (options.has(key)) report(options.get(key)!, 'V2D_IMAGE', 'Provider image/runtime names need an explicit createSandboxClass({ images }) mapping; the default import cannot translate them.');
      if (options.has('ports')) report(options.get('ports')!, 'V2D_PREVIEW', 'Review public access and set publicPreview explicitly. Daytona public previews are sandbox-wide, not a port allowlist.', 'warning');
      const policy = options.get('networkPolicy');
      if (policy && (!ts.isStringLiteral(policy) || !['allow-all', 'deny-all'].includes(policy.text))) report(policy, 'V2D_NETWORK', 'Only allow-all/deny-all map directly; firewall rules, transforms and network identity need manual migration.');
      const timeout = options.get('timeout');
      if (timeout) {
        const value = constantNumber(timeout);
        if (value === undefined || !Number.isSafeInteger(value) || value <= 0 || value % 60000) report(timeout, 'V2D_TIMEOUT', 'Timeout must be a positive whole number of minutes in milliseconds, or manually configure timeoutRounding: "ceil".');
      }
      if (options.has('resources')) fields(options.get('resources'), call, ['vcpus']);
      report(call, 'V2D_TTL', 'Expiry uses Daytona wall-clock TTL from creation; it deletes the disposable sandbox. Idle auto-stop is disabled.', 'warning');
    } else if (kind === 'class' && name === 'get') {
      const options = fields(call.arguments[0], call, ['name']);
      if (!options.has('name')) report(call, 'V2D_IDENTITY', 'get requires a Daytona name created by this adapter; old Vercel identities cannot reconnect.');
    }
    else if (kind === 'sandbox' && name === 'runCommand') {
      const arg = call.arguments[0];
      if (!arg) report(call, 'V2D_COMMAND', 'A command is required.');
      else {
        const value = resolve(arg);
        if (!ts.isStringLiteralLike(value)) fields(arg, call, COMMAND_KEYS);
      }
      if (call.arguments[2]) fields(call.arguments[2], call, []);
    } else if (kind === 'sandbox' && name === 'extendTimeout') report(call, 'V2D_TIMEOUT', 'Extension needs explicit timeoutRounding: "ceil" and application serialization across processes.');
    else if (kind === 'sandbox' && name === 'stop') {
      let parent: ts.Node = call.parent;
      if (ts.isAwaitExpression(parent)) parent = parent.parent;
      if (!ts.isExpressionStatement(parent)) report(call, 'V2D_STOP_RESULT', 'stop() returns void in the disposable adapter; Vercel session/snapshot/usage results are not emulated.');
      fields(call.arguments[0], call, []);
    } else {
      const optionIndex = name === 'delete' || name === 'wait' || name === 'stdout' || name === 'stderr' ? 0 : 1;
      if (call.arguments[optionIndex]) fields(call.arguments[optionIndex], call, []);
      if (name === 'readFile' || name === 'readFileToBuffer') fields(call.arguments[0], call, ['path', 'cwd']);
    }
  });
  const unique = [...new Map(diagnostics.map(d => [`${d.file}:${d.line}:${d.column}:${d.code}`, d])).values()];
  return { diagnostics: unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column), edits, imports };
}

function constantNumber(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) return constantNumber(node.expression);
  if (ts.isBinaryExpression(node)) {
    const left = constantNumber(node.left);
    const right = constantNumber(node.right);
    if (left === undefined || right === undefined) return undefined;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
  }
  return undefined;
}
