import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona, DaytonaFileNotFoundError, type Sandbox as DaytonaSandbox } from '@daytona/sdk';
import { COMMAND_KEYS, CREATE_KEYS, CompatibilityError, onlyKeys, positive, quote, string, stringMap } from './contracts.js';

export { CompatibilityError } from './contracts.js';

export interface AdapterOptions {
  client?: Daytona;
  /** OCI image accessible to Daytona; choose the runtime, user and tooling explicitly. */
  image: string;
  /** Existing absolute directory in that image. No implicit /vercel path rewriting. */
  workdir: string;
  user?: string;
  /** Vercel runtime/image identifier -> Daytona OCI image. */
  images?: Record<string, string>;
  publicPreview?: boolean;
  /** Default rejects sub-minute values. ceil explicitly accepts up to one minute of rounding. */
  timeoutRounding?: 'reject' | 'ceil';
  diskGiB?: number;
}

export interface CreateOptions {
  name?: string;
  persistent: false;
  image?: string;
  runtime?: string;
  resources?: { vcpus: number };
  timeout?: number;
  ports?: number[];
  env?: Record<string, string>;
  tags?: Record<string, string>;
  networkPolicy?: 'allow-all' | 'deny-all';
}

export interface RunCommandOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  detached?: boolean;
}

type Logs = { stdout?: string; stderr?: string; output?: string };
export type CommandFinished = Command & { exitCode: number };
const OWNER_LABEL = 'vercel2daytona';
const META_LABEL = 'vercel2daytona.config';

function minutes(timeout: number, rounding: AdapterOptions['timeoutRounding']): number {
  positive(timeout, 'timeout in milliseconds');
  if (timeout % 60_000 !== 0 && rounding !== 'ceil') {
    throw new CompatibilityError('Daytona TTL uses whole minutes. Use a multiple of 60000ms or explicitly configure timeoutRounding: "ceil".');
  }
  return Math.ceil(timeout / 60_000);
}

function absolute(path: string, base: string): string {
  string(path, 'path');
  return posix.resolve(base, path);
}

function noOptions(options: unknown): void {
  onlyKeys(options ?? {}, [], 'options');
}

export class Command {
  readonly cmdId: string;
  exitCode: number | null = null;
  private logs?: Logs;
  private pending?: Promise<CommandFinished>;
  constructor(private readonly box: DaytonaSandbox, private readonly sessionId: string, private readonly commandId: string) {
    this.cmdId = `${sessionId}/${encodeURIComponent(commandId)}`;
  }
  async wait(options?: Record<string, never>): Promise<CommandFinished> {
    noOptions(options);
    // Concurrent collectors share polling; a failed request can be retried.
    this.pending ??= this.finish().catch(error => { this.pending = undefined; throw error; });
    return this.pending;
  }
  private async finish(): Promise<CommandFinished> {
    while (this.exitCode === null) {
      const state = await this.box.process.getSessionCommand(this.sessionId, this.commandId);
      if (state.exitCode != null) this.exitCode = state.exitCode;
      else await delay(200);
    }
    this.logs = await this.box.process.getSessionCommandLogs(this.sessionId, this.commandId);
    return this as CommandFinished;
  }
  async output(stream: 'stdout' | 'stderr' | 'both' = 'both', options?: Record<string, never>): Promise<string> {
    noOptions(options);
    if (!['stdout', 'stderr', 'both'].includes(stream)) throw new CompatibilityError('Unknown output stream');
    await this.wait();
    return (stream === 'both' ? this.logs?.output : this.logs?.[stream]) ?? '';
  }
  stdout(options?: Record<string, never>): Promise<string> { return this.output('stdout', options); }
  stderr(options?: Record<string, never>): Promise<string> { return this.output('stderr', options); }
}

export class SandboxHandle {
  readonly persistent = false;
  readonly name: string;
  readonly sandboxId: string;
  private deleted = false;
  private deleting?: Promise<void>;
  private extending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly daytona: DaytonaSandbox,
    private readonly config: AdapterOptions,
    private readonly previews: Map<number, string>,
    readonly timeout: number,
  ) {
    this.name = daytona.name;
    this.sandboxId = daytona.id;
  }
  get expiresAt(): Date {
    if (!this.daytona.autoDestroyAt) throw new CompatibilityError('Daytona did not return an expiry; call refreshData and inspect the native sandbox');
    return new Date(this.daytona.autoDestroyAt);
  }
  private active(): void {
    if (this.deleted || this.deleting) throw new CompatibilityError('Sandbox has been deleted or is being deleted');
  }
  runCommand(command: string, args?: string[], options?: Record<string, never>): Promise<CommandFinished>;
  runCommand(command: RunCommandOptions & { detached: true }): Promise<Command>;
  runCommand(command: RunCommandOptions & { detached?: false }): Promise<CommandFinished>;
  runCommand(command: RunCommandOptions): Promise<Command>;
  async runCommand(command: string | RunCommandOptions, args: string[] = [], options?: Record<string, never>): Promise<Command> {
    this.active();
    noOptions(options);
    const params: RunCommandOptions = typeof command === 'string' ? { cmd: command, args } : command;
    onlyKeys(params, COMMAND_KEYS, 'runCommand');
    string(params.cmd, 'cmd');
    if (!params.cmd) throw new CompatibilityError('cmd must not be empty');
    if (params.cmd.startsWith('-')) throw new CompatibilityError('Use an absolute path for executables whose names start with a hyphen');
    if (!Array.isArray(params.args ?? [])) throw new CompatibilityError('args must be an array');
    for (const arg of params.args ?? []) string(arg, 'argument');
    if (params.detached !== undefined && typeof params.detached !== 'boolean') throw new CompatibilityError('detached must be boolean');
    const cwd = absolute(params.cwd ?? this.config.workdir, this.config.workdir);
    const argv = [params.cmd, ...(params.args ?? [])].map(quote);
    // A separate shell per command preserves argv without leaking cd/export into another call.
    const script = `cd ${quote(cwd)} && exec ${argv.join(' ')}`;
    const sessionId = `v2d-${randomUUID()}`;
    await this.daytona.process.createSession(sessionId);
    const result = await this.daytona.process.executeSessionCommand(sessionId, {
      command: `sh -c ${quote(script)} < /dev/null`, runAsync: true, suppressInputEcho: true,
    });
    if (!result.cmdId) throw new Error(`Daytona did not return a command ID for session ${sessionId}`);
    const handle = new Command(this.daytona, sessionId, result.cmdId);
    return params.detached ? handle : handle.wait();
  }
  async getCommand(cmdId: string, options?: Record<string, never>): Promise<Command> {
    this.active();
    noOptions(options);
    string(cmdId, 'cmdId');
    const match = /^(v2d-[a-f0-9-]{36})\/([^/]+)$/.exec(cmdId);
    if (!match) throw new CompatibilityError('getCommand requires a command ID created by vercel2daytona');
    const session = match[1]!;
    const id = decodeURIComponent(match[2]!);
    const state = await this.daytona.process.getSessionCommand(session, id);
    const command = new Command(this.daytona, session, id);
    command.exitCode = state.exitCode ?? null;
    return command;
  }
  async mkDir(path: string, options?: Record<string, never>): Promise<void> {
    this.active();
    noOptions(options);
    await this.daytona.fs.createFolder(absolute(path, this.config.workdir), '755');
  }
  async writeFiles(files: { path: string; content: Buffer; mode?: number }[], options?: Record<string, never>): Promise<void> {
    this.active();
    noOptions(options);
    if (!Array.isArray(files)) throw new CompatibilityError('files must be an array');
    const uploads = files.map(file => {
      onlyKeys(file, ['path', 'content', 'mode'], 'file');
      if (!Buffer.isBuffer(file.content)) throw new CompatibilityError('writeFiles requires Buffer content');
      if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777)) throw new CompatibilityError('Invalid Unix file mode');
      return { source: file.content, destination: absolute(file.path, this.config.workdir) };
    });
    if (uploads.length) await this.daytona.fs.uploadFiles(uploads);
    for (const [index, file] of files.entries()) {
      if (file.mode !== undefined) await this.daytona.fs.setFilePermissions(uploads[index]!.destination, { mode: file.mode.toString(8) });
    }
  }
  async readFileToBuffer(file: { path: string; cwd?: string }, options?: Record<string, never>): Promise<Buffer | null> {
    this.active();
    noOptions(options);
    onlyKeys(file, ['path', 'cwd'], 'file');
    try {
      return await this.daytona.fs.downloadFile(absolute(file.path, absolute(file.cwd ?? this.config.workdir, this.config.workdir)));
    } catch (error) {
      if (error instanceof DaytonaFileNotFoundError) return null;
      throw error;
    }
  }
  async readFile(file: { path: string; cwd?: string }, options?: Record<string, never>): Promise<ReadableStream<Uint8Array> | null> {
    const buffer = await this.readFileToBuffer(file, options);
    return buffer === null ? null : new ReadableStream({ start(controller) { controller.enqueue(buffer); controller.close(); } });
  }
  domain(port: number): string {
    this.active();
    const url = this.previews.get(port);
    if (!url) throw new CompatibilityError('domain requires a declared port and explicit publicPreview: true configuration');
    return url;
  }
  async extendTimeout(duration: number, options?: Record<string, never>): Promise<void> {
    this.active();
    noOptions(options);
    positive(duration, 'extension in milliseconds');
    if (this.config.timeoutRounding !== 'ceil') throw new CompatibilityError('extendTimeout needs timeoutRounding: "ceil" because setTtl re-anchors a whole-minute deadline');
    const update = this.extending.then(async () => {
      this.active();
      await this.daytona.refreshData();
      const remaining = this.expiresAt.getTime() - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new CompatibilityError('Cannot extend an expired sandbox');
      await this.daytona.setTtl(Math.ceil((remaining + duration) / 60_000));
      await this.daytona.refreshData();
    });
    this.extending = update.catch(() => undefined);
    return update;
  }
  async delete(options?: Record<string, never>): Promise<void> {
    noOptions(options);
    if (this.deleted) return;
    this.deleting ??= this.daytona.delete(60, true).then(() => { this.deleted = true; }).catch(error => { this.deleting = undefined; throw error; });
    return this.deleting;
  }
  /** Disposable sandbox only. No Vercel session/snapshot/usage result is synthesized. */
  stop(options?: Record<string, never>): Promise<void> { return this.delete(options); }
  [Symbol.asyncDispose](): Promise<void> { return this.delete(); }
}

function resolveConfig(options: AdapterOptions): AdapterOptions {
  onlyKeys(options, ['client', 'image', 'workdir', 'user', 'images', 'publicPreview', 'timeoutRounding', 'diskGiB'], 'adapter');
  string(options.image, 'Daytona image');
  if (!options.image) throw new CompatibilityError('Set DAYTONA_IMAGE or provide an explicit Daytona image');
  string(options.workdir, 'workdir');
  if (!posix.isAbsolute(options.workdir)) throw new CompatibilityError('Set DAYTONA_WORKDIR to an existing absolute path in the target image');
  if (options.user !== undefined) string(options.user, 'user');
  if (options.publicPreview !== undefined && typeof options.publicPreview !== 'boolean') throw new CompatibilityError('publicPreview must be boolean');
  if (options.timeoutRounding !== undefined && !['ceil', 'reject'].includes(options.timeoutRounding)) throw new CompatibilityError('Invalid timeoutRounding');
  positive(options.diskGiB ?? 10, 'diskGiB');
  stringMap(options.images ?? {}, 'images');
  return { ...options, images: { ...options.images } };
}

/** Each factory has independent configuration; no global SDK monkeypatch or import-time cloud calls. */
export function createSandboxClass(options: AdapterOptions | (() => AdapterOptions)) {
  const config = () => resolveConfig(typeof options === 'function' ? options() : options);
  return class Sandbox {
    static async create(params: CreateOptions): Promise<SandboxHandle> {
      const settings = config();
      onlyKeys(params, CREATE_KEYS, 'create');
      if (params.persistent !== false) throw new CompatibilityError('This adapter requires explicit persistent: false. Vercel defaults to true; persistent snapshots/resume need a native migration.');
      if (params.image !== undefined && params.runtime !== undefined) throw new CompatibilityError('Specify image or runtime, not both');
      const sourceImage = params.image ?? params.runtime;
      if (sourceImage !== undefined) string(sourceImage, 'source image/runtime');
      const image = sourceImage === undefined ? settings.image : (Object.hasOwn(settings.images ?? {}, sourceImage) ? settings.images![sourceImage] : undefined);
      if (!image) throw new CompatibilityError('Configure an explicit images mapping for the Vercel image/runtime; provider image names are not portable');
      if (params.name !== undefined) { string(params.name, 'name'); if (!params.name) throw new CompatibilityError('name must not be empty'); }
      stringMap(params.env ?? {}, 'env');
      stringMap(params.tags ?? {}, 'tags');
      onlyKeys(params.resources ?? {}, ['vcpus'], 'resources');
      const cpu = params.resources?.vcpus ?? 2;
      positive(cpu, 'vcpus');
      const timeout = params.timeout ?? 300_000;
      const ttlMinutes = minutes(timeout, settings.timeoutRounding);
      if (!Array.isArray(params.ports ?? [])) throw new CompatibilityError('ports must be an array');
      const ports = [...new Set(params.ports ?? [])];
      if (ports.length > 15) throw new CompatibilityError('At most 15 ports are supported');
      for (const port of ports) { positive(port, 'port'); if (port > 65535) throw new CompatibilityError('Invalid port'); }
      if (ports.length && settings.publicPreview !== true) throw new CompatibilityError('ports require explicit publicPreview: true; use native Daytona signed/private previews otherwise');
      if (params.networkPolicy !== undefined && !['allow-all', 'deny-all'].includes(params.networkPolicy)) throw new CompatibilityError('Structured Vercel firewall rules and credential transforms require a native migration');
      const client = settings.client ?? new Daytona();
      const box = await client.create({
        name: params.name ?? `v2d-${randomUUID()}`, image, user: settings.user,
        envVars: params.env, resources: { cpu, memory: cpu * 2, disk: settings.diskGiB ?? 10 },
        ephemeral: true, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes,
        public: settings.publicPreview === true, networkBlockAll: params.networkPolicy === 'deny-all',
        labels: {
          ...Object.fromEntries(Object.entries(params.tags ?? {}).map(([key, value]) => [`vercel.tag.${key}`, value])),
          [OWNER_LABEL]: '1', [META_LABEL]: JSON.stringify({ workdir: settings.workdir, ports, timeout, publicPreview: settings.publicPreview === true }),
        },
      }, { timeout: 60 });
      try {
        return await wrap(box, settings, ports, timeout);
      } catch (error) {
        try { await box.delete(60, true); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Sandbox setup and cleanup both failed'); }
        throw error;
      }
    }
    static async get(params: { name: string }): Promise<SandboxHandle> {
      const settings = config();
      onlyKeys(params, ['name'], 'get');
      string(params.name, 'name');
      const box = await (settings.client ?? new Daytona()).get(params.name);
      if (box.labels[OWNER_LABEL] !== '1') throw new CompatibilityError('Only reconnect to sandboxes created by vercel2daytona; Vercel IDs/names are not migrated');
      const metadata: unknown = JSON.parse(box.labels[META_LABEL] ?? 'null');
      onlyKeys(metadata, ['workdir', 'ports', 'timeout', 'publicPreview'], 'saved sandbox metadata');
      if (metadata.workdir !== settings.workdir || metadata.publicPreview !== (settings.publicPreview === true)) throw new CompatibilityError('Reconnect with the original workdir and preview configuration');
      if (box.state !== 'started') throw new CompatibilityError('Sandbox is not running; persistent auto-resume is unsupported');
      if (!Array.isArray(metadata.ports) || metadata.ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new CompatibilityError('Invalid saved ports');
      positive(metadata.timeout, 'saved timeout');
      return wrap(box, settings, metadata.ports as number[], metadata.timeout);
    }
  };
}

async function wrap(box: DaytonaSandbox, settings: AdapterOptions, ports: number[], timeout: number): Promise<SandboxHandle> {
  const previews = new Map<number, string>();
  for (const port of ports) {
    if (!box.public || !settings.publicPreview) throw new CompatibilityError('Refusing to turn a private preview into an unauthenticated URL');
    previews.set(port, (await box.getPreviewLink(port)).url);
  }
  return new SandboxHandle(box, settings, previews, timeout);
}

/** Convenience import: credentials are read by the Daytona SDK only when create/get is called. */
export const Sandbox = createSandboxClass(() => ({
  image: process.env.DAYTONA_IMAGE ?? '',
  workdir: process.env.DAYTONA_WORKDIR ?? '',
  user: process.env.DAYTONA_USER,
  publicPreview: process.env.DAYTONA_PUBLIC_PREVIEW === '1',
  timeoutRounding: process.env.DAYTONA_TIMEOUT_ROUNDING === 'ceil' ? 'ceil' : 'reject',
}));
export type Sandbox = SandboxHandle;
