import { Sandbox, type Command, type CommandFinished } from '../dist/adapter.js';

async function contract() {
  const sandbox = await Sandbox.create({ persistent: false });
  const foreground: CommandFinished = await sandbox.runCommand('node', ['--version']);
  const code: number = foreground.exitCode;
  const objectForm: CommandFinished = await sandbox.runCommand({ cmd: 'node' });
  const detached: Command = await sandbox.runCommand({ cmd: 'node', detached: true });
  const finished: CommandFinished = await detached.wait();
  const output: string = await finished.stdout();
  const bytes: Buffer | null = await sandbox.readFileToBuffer({ path: 'file' });
  // @ts-expect-error Persistent lifecycle is intentionally unsupported.
  await Sandbox.create({ persistent: true });
  // @ts-expect-error Per-command credentials cannot be encoded into command metadata.
  await sandbox.runCommand({ cmd: 'node', env: { SECRET: 'value' } });
  // @ts-expect-error A request timeout is not a process deadline.
  await sandbox.runCommand({ cmd: 'node', timeoutMs: 1000 });
  void [code, objectForm, output, bytes];
}
void contract; // Typechecked only; never execute cloud operations.
