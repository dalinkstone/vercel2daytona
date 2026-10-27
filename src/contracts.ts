export const CREATE_KEYS = ['name', 'persistent', 'image', 'runtime', 'resources', 'timeout', 'ports', 'env', 'tags', 'networkPolicy'] as const;
export const COMMAND_KEYS = ['cmd', 'args', 'cwd', 'detached'] as const;
export const SANDBOX_METHODS = ['runCommand', 'getCommand', 'mkDir', 'writeFiles', 'readFileToBuffer', 'readFile', 'domain', 'stop', 'delete', 'extendTimeout'] as const;
export const COMMAND_METHODS = ['wait', 'stdout', 'stderr', 'output'] as const;
export const SANDBOX_PROPERTIES = ['name', 'sandboxId', 'persistent', 'timeout', 'expiresAt', 'daytona'] as const;
export const COMMAND_PROPERTIES = ['cmdId', 'exitCode'] as const;

export class CompatibilityError extends Error {
  readonly code = 'V2D_UNSUPPORTED';
  constructor(message: string) {
    super(message);
    this.name = 'CompatibilityError';
  }
}

export function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompatibilityError(`${label} must be an object`);
}

export function onlyKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new CompatibilityError(`${label}.${key} has no supported mapping; see COMPATIBILITY.md`);
  }
}

export function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) throw new CompatibilityError(`${label} must be a string without NUL bytes`);
}

export function stringMap(value: unknown, label: string): asserts value is Record<string, string> {
  object(value, label);
  for (const [key, item] of Object.entries(value)) {
    string(key, label);
    string(item, `${label}.${key}`);
  }
}

export function positive(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new CompatibilityError(`${label} must be a positive safe integer`);
}

export function quote(value: string): string {
  string(value, 'command argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}
