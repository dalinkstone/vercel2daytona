#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, type Analysis } from './analyze.js';

const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'out']);
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const help = `vercel2daytona lint [directory] [--json] [--strict]
vercel2daytona migrate [directory] [--write] [--json]

lint: inspect JS/TS source without executing it. Exit 1 for errors, 2 for tool errors.
migrate: preview import and package.json edits; --write applies only when no errors exist.
Generated directories, hidden entries and symlinks are skipped. Lockfiles are never edited.
`;

export async function collect(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || ignored.has(item.name) || item.isSymbolicLink()) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && sourceExtension.test(item.name) && !/\.d\.[cm]?ts$/.test(item.name)) files[path] = await readFile(path, 'utf8');
    }
  }
  await walk(root);
  return files;
}

interface Change { file: string; before: string; after: string }

export async function plan(root: string, files: Record<string, string>, analysis: Analysis): Promise<Change[]> {
  const changes: Change[] = [];
  for (const [file, before] of Object.entries(files)) {
    let after = before;
    for (const edit of analysis.edits.filter(e => e.file === file).sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.replacement + after.slice(edit.end);
    if (after !== before) changes.push({ file, before, after });
  }
  // Each changed file belongs to its nearest package; never edit an unrelated workspace manifest.
  const manifests = new Set<string>();
  for (const change of changes) {
    let directory = dirname(change.file);
    for (;;) {
      const candidate = join(directory, 'package.json');
      try {
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-regular manifest: ${candidate}`);
        manifests.add(candidate);
        break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (directory === root) throw new Error(`No package.json found for ${relative(root, change.file)}`);
      directory = dirname(directory);
    }
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of manifests) {
    const before = await readFile(file, 'utf8');
    const manifest = JSON.parse(before);
    // An installed CLI is the normal entry point for shared packages. Keep its
    // existing dependency spec, including portable tarball/workspace references.
    if (manifest.dependencies?.vercel2daytona) continue;
    const installed = manifest.devDependencies?.vercel2daytona;
    // Keep @vercel/sandbox installed: ignored files, tools or other consumers may still use it.
    const local = relative(dirname(file), packageRoot).split(sep).join('/');
    manifest.dependencies = { ...manifest.dependencies, vercel2daytona: installed ?? `file:${local.startsWith('.') ? local : `./${local}`}` };
    if (installed) delete manifest.devDependencies.vercel2daytona;
    const indent = /^([ \t]+)"/m.exec(before)?.[1] ?? '  ';
    changes.push({ file, before, after: JSON.stringify(manifest, null, indent) + '\n' });
  }
  return changes;
}

export async function applyChanges(root: string, changes: Change[]): Promise<void> {
  // Validate the entire plan before changing any file. O_NOFOLLOW also protects the final open.
  for (const change of changes) {
    const actual = await realpath(change.file);
    if (actual !== change.file || !actual.startsWith(root + sep)) throw new Error(`Refusing a path outside the project or through a symlink: ${change.file}`);
    if (await readFile(change.file, 'utf8') !== change.before) throw new Error(`File changed since analysis: ${change.file}`);
    try { await lstat(change.file + '.vercel2daytona.bak'); throw new Error(`Backup already exists: ${change.file}.vercel2daytona.bak`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Exclusive backups preserve user edits and permit recovery if a later write fails.
  for (const change of changes) {
    const mode = (await lstat(change.file)).mode;
    await writeFile(change.file + '.vercel2daytona.bak', change.before, { flag: 'wx', mode });
  }
  for (const change of changes) {
    const handle = await open(change.file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (await handle.readFile('utf8') !== change.before) throw new Error(`File changed before write: ${change.file}`);
      const bytes = Buffer.from(change.after);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (bytesWritten === 0) throw new Error(`Unable to finish writing ${change.file}; restore its backup`);
        offset += bytesWritten;
      }
      await handle.truncate(bytes.length);
    } finally { await handle.close(); }
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  const command = args.shift();
  if (command !== 'lint' && command !== 'migrate') throw new Error('Expected lint or migrate; use --help');
  const flags = new Set(args.filter(arg => arg.startsWith('--')));
  for (const flag of flags) if (!['--json', '--strict', '--write'].includes(flag)) throw new Error(`Unknown flag ${flag}`);
  if (command === 'lint' && flags.has('--write')) throw new Error('--write is only valid for migrate');
  const paths = args.filter(arg => !arg.startsWith('--'));
  if (paths.length > 1) throw new Error('Pass one project directory');
  const root = await realpath(resolve(paths[0] ?? '.'));
  const files = await collect(root);
  const analysis = analyze(files);
  const blocked = analysis.diagnostics.some(d => d.severity === 'error' || flags.has('--strict'));
  const changes = command === 'migrate' && !blocked ? await plan(root, files, analysis) : [];
  if (flags.has('--write') && !blocked) await applyChanges(root, changes);
  const report = {
    command, root, files: Object.keys(files).length, imports: analysis.imports, blocked,
    applied: flags.has('--write') && !blocked && changes.length > 0,
    diagnostics: analysis.diagnostics.map(d => ({ ...d, file: relative(root, d.file) })),
    changes: changes.map(change => ({ file: relative(root, change.file), before: change.before, after: change.after })),
  };
  if (flags.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const d of report.diagnostics) console.log(`${d.file}:${d.line}:${d.column} ${d.severity} ${d.code} ${d.message}`);
    for (const change of report.changes) {
      console.log(`\n${report.applied ? 'Updated' : 'Would update'} ${change.file}`);
      console.log(change.after);
    }
    console.log(`\n${report.files} source files; ${report.imports} SDK imports; ${blocked ? 'blocked by diagnostics' : `${changes.length} proposed file changes`}.`);
    if (changes.length) console.log('Build/install the local package and update the application lockfile with lifecycle scripts disabled. Review backups, image configuration and compatibility notes before running cloud workloads.');
    if (!analysis.imports) console.log('No supported static SDK imports found. This is not a compatibility guarantee.');
  }
  return blocked ? 1 : 0;
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`vercel2daytona: ${error.message}`); process.exitCode = 2; });
}
