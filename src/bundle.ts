import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, parse, sep } from 'node:path';

export interface WorkerModule {
  /** POSIX path relative to the bundle directory, e.g. "index.js" or "chunks/a.js". */
  name: string;
  contentType: string;
  content: Uint8Array<ArrayBuffer>;
}

export interface WorkerBundle {
  mainModule: string;
  modules: WorkerModule[];
}

/** Runs a command with inherited stdio and resolves with its exit code. */
export type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<number>;

export interface BundleOptions {
  workingDirectory: string;
  /** Wrangler config to bundle with; passed explicitly so wrangler reads the same file we validated. */
  configPath: string;
  /** Absolute path of the Worker entry (`main`). */
  main: string;
  /** Worker `name` from the config. Wrangler wants one even for dry runs, so a placeholder fills in. */
  workerName: string | null;
  run?: CommandRunner;
  log?: (message: string) => void;
}

/** Name passed to wrangler when the config has none; it does not reach the bundle. */
export const PLACEHOLDER_WORKER_NAME = 'bohr-worker';
/** Wrangler writes this note into --outdir; it is not a module. */
const OUTDIR_README = 'README.md';

/** Upload content type of a module written by wrangler, following wrangler's module rules. */
export function moduleContentType(name: string): string {
  switch (extname(name)) {
    case '.js':
    case '.mjs':
      return 'application/javascript+module';
    case '.cjs':
      return 'application/javascript';
    case '.map':
      return 'application/source-map';
    case '.wasm':
      return 'application/wasm';
    case '.bin':
      return 'application/octet-stream';
    default:
      return 'text/plain';
  }
}

/** Arguments for `npx`; --yes lets npx fetch wrangler when the project does not install it. */
export function wranglerArgs(outdir: string, configPath: string, workerName: string | null): string[] {
  const args = ['--yes', 'wrangler', 'deploy', '--dry-run', '--outdir', outdir, '--config', configPath];
  if (!workerName) args.push('--name', PLACEHOLDER_WORKER_NAME);
  return args;
}

/** Bundles the Worker with `wrangler deploy --dry-run --outdir` and reads the modules it wrote. */
export async function bundleWorker(options: BundleOptions): Promise<WorkerBundle> {
  const run = options.run ?? runCommand;
  if (!hasLocalWrangler(options.workingDirectory)) {
    options.log?.(
      'wrangler is not installed in this project, so npx downloads the latest release. Add wrangler to devDependencies to pin it.',
    );
  }
  const outdir = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'bohr-bundle-'));
  try {
    let code: number;
    try {
      code = await run('npx', wranglerArgs(outdir, options.configPath, options.workerName), options.workingDirectory);
    } catch (error) {
      throw new Error(
        `Could not run npx (${(error as Error).message}). Set up Node.js (actions/setup-node) before this action.`,
      );
    }
    if (code !== 0) {
      throw new Error(`wrangler deploy --dry-run failed with exit code ${code}; see its output above.`);
    }
    const modules = await collectModules(outdir);
    const mainModule = resolveMainModule(
      options.main,
      modules.map((module) => module.name),
    );
    return { mainModule, modules };
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}

/** Reads every file wrangler wrote to the outdir (except its README) as a module, sorted by name. */
export async function collectModules(outdir: string): Promise<WorkerModule[]> {
  const names = (await readdir(outdir, { recursive: true })).map((entry) => entry.split(sep).join('/')).sort();
  const modules: WorkerModule[] = [];
  for (const name of names) {
    if (name === OUTDIR_README) continue;
    const absolutePath = join(outdir, name);
    if (!(await stat(absolutePath)).isFile()) continue;
    modules.push({ name, contentType: moduleContentType(name), content: new Uint8Array(await readFile(absolutePath)) });
  }
  return modules;
}

/**
 * Name of the entry module: wrangler names the bundle after the entry with a
 * .js extension (src/index.ts -> index.js); with no_bundle it copies the entry as is.
 */
export function resolveMainModule(main: string, moduleNames: readonly string[]): string {
  const candidates = [`${parse(main).name}.js`, basename(main)];
  const found = candidates.find((candidate) => moduleNames.includes(candidate));
  if (!found) {
    throw new Error(
      `wrangler did not write the entry module ${candidates[0]} for main "${basename(main)}" (it wrote: ${moduleNames.join(', ') || 'nothing'}).`,
    );
  }
  return found;
}

/** Whether node_modules/wrangler exists in the directory or a parent, where npx finds it. */
export function hasLocalWrangler(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules', 'wrangler', 'package.json'))) return true;
    if (dirname(current) === current) return false;
  }
}

export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    // npx is a .cmd script on Windows, which only runs through a shell.
    const windows = process.platform === 'win32';
    const child = spawn(command, windows ? args.map(quoteForCmd) : [...args], {
      cwd,
      stdio: 'inherit',
      shell: windows,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
