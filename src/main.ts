// bohr-io/deploy-action: a thin wrapper that runs the latest bohr CLI (npm "bohr", packages/cli), which does the
// work: `bohr action`. The CLI reads this action's inputs (INPUT_*) and writes its outputs ($GITHUB_OUTPUT),
// environment ($GITHUB_ENV), masks and job summary itself, so they reach this step unchanged.
//
// The CLI is installed into the runner's temporary folder with npm and started with this Node.js directly, not
// through npx: npx starts a package's bin through `sh -c`, and sh drops the environment variables whose names
// have a hyphen, which is how the runner passes inputs (INPUT_BUILD-PLAN, INPUT_INSTANCE-URL).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The CLI every run uses: always the latest release, as bohr v1's action did. */
export const CLI_PACKAGE = 'bohr@latest';
/** Runs another package spec instead ("bohr@4.0.0", a tarball), to test a release before it becomes latest. */
export const CLI_PACKAGE_ENV = 'BOHR_CLI_PACKAGE';

export interface Invocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** npm on PATH is a .cmd script on Windows, which only runs through a shell. */
  shell: boolean;
}

interface Options {
  execPath?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  exists?: (path: string) => boolean;
}

/**
 * How to install the CLI into `prefix`: with the npm of the Node.js that runs this action (the runner's own), or
 * npm from PATH. Only npm's own output and exit code matter; the install never sees the step's inputs.
 */
export function installation(prefix: string, env: NodeJS.ProcessEnv = process.env, options: Options = {}): Invocation {
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const nodeDir = dirname(execPath);
  const npmCli = [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((path) => exists(path));
  const spec = env[CLI_PACKAGE_ENV]?.trim() || CLI_PACKAGE;
  const npmArgs = ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', '--loglevel=error', spec];
  if (npmCli !== undefined) return { command: execPath, args: [npmCli, ...npmArgs], env, shell: false };
  return { command: 'npm', args: npmArgs, env, shell: (options.platform ?? process.platform) === 'win32' };
}

/** The installed CLI's entry point, from its package.json "bin". */
export function cliEntry(
  prefix: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  const packageDir = join(prefix, 'node_modules', 'bohr');
  const manifest = JSON.parse(read(join(packageDir, 'package.json'))) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.bohr;
  if (!bin) throw new Error('The installed bohr package has no "bohr" executable.');
  return join(packageDir, bin);
}

/**
 * How to start the CLI: this Node.js (the runner's own, as the action always ran on), with the step's environment
 * untouched. The CLI gets this step's folder and PATH as well (BOHR_ACTION_CWD, BOHR_ACTION_PATH), so what it
 * starts (wrangler) sees the job's Node.js, as before.
 */
export function invocation(entry: string, env: NodeJS.ProcessEnv = process.env, options: Options = {}): Invocation {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return {
    command: options.execPath ?? process.execPath,
    args: [entry, 'action'],
    env: { ...env, BOHR_ACTION_CWD: options.cwd ?? process.cwd(), BOHR_ACTION_PATH: env[pathKey] ?? '' },
    shell: false,
  };
}

export function run(start: Invocation, output: 'inherit' | 'stderr' = 'inherit'): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(start.command, start.args, {
      env: start.env,
      shell: start.shell,
      // npm's own output goes to the log, never to what the CLI reads
      stdio: output === 'inherit' ? 'inherit' : ['ignore', process.stderr, process.stderr],
    });
    child.once('error', (error) => {
      process.stdout.write(
        `::error::Could not start ${start.command} (${error.message}). Set up Node.js (actions/setup-node) before this action.\n`,
      );
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/** Installs the latest CLI, then runs `bohr action`; resolves with the exit code for the step. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const prefix = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'bohr-cli-'));
  const installed = await run(installation(prefix, env), 'stderr');
  if (installed !== 0) {
    process.stdout.write(
      `::error::Could not install the bohr CLI (${env[CLI_PACKAGE_ENV]?.trim() || CLI_PACKAGE}) from npm.\n`,
    );
    return installed;
  }
  return run(invocation(cliEntry(prefix), env));
}

// Not when the tests import it
if (!process.env.VITEST) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
