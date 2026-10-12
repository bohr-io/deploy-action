// bohr-io/deploy-action: a thin wrapper that runs the latest bohr CLI (npm "bohr", packages/cli), which does the
// work: `npx --yes bohr@latest action`. The CLI reads this action's inputs (INPUT_*) and writes its outputs
// ($GITHUB_OUTPUT), environment ($GITHUB_ENV), masks and job summary itself, so they reach this step unchanged.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** The CLI every run uses: always the latest release, as bohr v1's action did. */
export const CLI_PACKAGE = 'bohr@latest';
/** Runs another package spec instead ("bohr@4.0.0", a tarball), to test a release before it becomes latest. */
export const CLI_PACKAGE_ENV = 'BOHR_CLI_PACKAGE';

export interface Invocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** npx on PATH is a .cmd script on Windows, which only runs through a shell. */
  shell: boolean;
}

/**
 * How to start the CLI. npx comes from the Node.js that runs this action (the runner's own, whatever the job set
 * up), so the CLI runs on the same Node.js the action always ran on; without it, from PATH. The CLI gets back
 * this step's folder and PATH (BOHR_ACTION_CWD, BOHR_ACTION_PATH), so what it starts (wrangler) sees the job's
 * Node.js, as before.
 */
export function invocation(
  env: NodeJS.ProcessEnv = process.env,
  options: { execPath?: string; platform?: NodeJS.Platform; cwd?: string; exists?: (path: string) => boolean } = {},
): Invocation {
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const nodeDir = dirname(execPath);
  const npxCli = [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].find((path) => exists(path));

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const path = env[pathKey] ?? '';
  const runEnv: NodeJS.ProcessEnv = { ...env, BOHR_ACTION_CWD: options.cwd ?? process.cwd(), BOHR_ACTION_PATH: path };
  // Another spec (a version, a tarball) goes through --package, which also installs tarballs
  const spec = env[CLI_PACKAGE_ENV]?.trim();
  const npxArgs = spec ? ['--yes', '--package', spec, 'bohr', 'action'] : ['--yes', CLI_PACKAGE, 'action'];
  if (npxCli !== undefined) {
    // The package's `#!/usr/bin/env node` must find this Node.js first
    runEnv[pathKey] = path === '' ? nodeDir : `${nodeDir}${delimiter}${path}`;
    return { command: execPath, args: [npxCli, ...npxArgs], env: runEnv, shell: false };
  }
  return { command: 'npx', args: npxArgs, env: runEnv, shell: platform === 'win32' };
}

export function run(start: Invocation = invocation()): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(start.command, start.args, { env: start.env, shell: start.shell, stdio: 'inherit' });
    child.once('error', (error) => {
      process.stdout.write(
        `::error::Could not start the bohr CLI with npx (${error.message}). Set up Node.js (actions/setup-node) before this action.\n`,
      );
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

// Not when the tests import it
if (!process.env.VITEST) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
