import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { oidcTokens } from './deploy';
import { errorMessage, type Fetch, type Sleep } from './http';
import { type BuildPlan, normalizeInstanceUrl, requestBuildPlan } from './instance';
import { formatBytes, type Logger, plural, printable } from './log';
import { exportBuildVariables, mask } from './variables';

/** Largest total size of a plan's files the action writes (the instance caps it too). */
const MAX_PLAN_BYTES = 2 * 1024 * 1024;

export interface BuildPlanOptions {
  instanceUrl: string;
  /** Absolute path of the repository checkout ($GITHUB_WORKSPACE): plan paths are relative to it. */
  workspace: string;
}

export interface BuildPlanDependencies {
  fetch: Fetch;
  /** Returns a GitHub OIDC token with audience bohr.io. */
  getIdToken: () => Promise<string>;
  logger: Logger;
  /** Sets an environment variable for the next steps of the job ($GITHUB_ENV). */
  exportVariable: (name: string, value: string) => void;
  /** Sets an output of this step. */
  setOutput: (name: string, value: string) => void;
  sleep?: Sleep;
  now?: () => number;
}

export type BuildPlanResult =
  | { found: false }
  | { found: true; files: { path: string; status: 'written' | 'replaced' | 'unchanged' }[]; variables: string[] };

/**
 * Why a plan's file path is refused, or null: relative, `/`-separated, no `.`/`..`/empty segments, no drive
 * letter, backslash or control character, nothing in .github or .git. Same rules as the instance.
 */
export function invalidPlanPath(path: string): string | null {
  if (path.length === 0 || path.length > 256) return 'must be 1 to 256 characters';
  if (/[\p{Cc}\\:]/u.test(path)) return 'has a control character, a backslash or a colon';
  if (path.startsWith('/')) return 'must be relative to the repository root';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'has an empty, "." or ".." segment';
  }
  if (segments[0]?.toLowerCase() === '.github' || segments.some((segment) => segment.toLowerCase() === '.git')) {
    return 'is inside .github or .git';
  }
  return null;
}

/**
 * Files a plan owns and may replace when the repository has a different copy: the wrangler config, the
 * Worker bohr generated (anything in a .bohr folder) and the v1 functions adapter. Any other file the
 * repository already has with other contents stops the step.
 */
export function planOwns(path: string): boolean {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  return name === 'wrangler.jsonc' || name === 'lambda-adapter.mjs' || segments.slice(0, -1).includes('.bohr');
}

/** Refuses a path whose folders or file are symbolic links, so a plan file cannot land outside the workspace. */
async function existing(workspace: string, path: string): Promise<string | null> {
  const segments = path.split('/');
  for (let index = 1; index <= segments.length; index++) {
    const target = join(workspace, ...segments.slice(0, index));
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(target);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink())
      throw new Error(
        `Cannot write ${printable(path)}: ${printable(segments.slice(0, index).join('/'))} is a symbolic link.`,
      );
    if (index < segments.length && !stats.isDirectory()) {
      throw new Error(
        `Cannot write ${printable(path)}: ${printable(segments.slice(0, index).join('/'))} is not a folder.`,
      );
    }
    if (index === segments.length) {
      if (!stats.isFile()) throw new Error(`Cannot write ${printable(path)}: it exists and is not a file.`);
      return readFile(target, 'utf8');
    }
  }
  return null;
}

/** Checks every file first, then writes them, so a refused plan leaves the workspace as it was. */
async function writePlanFiles(workspace: string, files: Record<string, string>, logger: Logger) {
  let total = 0;
  const planned: { path: string; content: string; status: 'written' | 'replaced' | 'unchanged' }[] = [];
  for (const [path, content] of Object.entries(files)) {
    const problem = invalidPlanPath(path);
    if (problem !== null) throw new Error(`The build plan has an invalid file path "${printable(path)}": ${problem}.`);
    total += Buffer.byteLength(content, 'utf8');
    const current = await existing(workspace, path);
    if (current === null) planned.push({ path, content, status: 'written' });
    else if (current === content) planned.push({ path, content, status: 'unchanged' });
    else if (planOwns(path)) planned.push({ path, content, status: 'replaced' });
    else {
      throw new Error(
        `The repository already has ${printable(path)} with other contents, and the build plan only replaces wrangler.jsonc, lambda-adapter.mjs and files in .bohr. Remove the file from the repository or from the plan.`,
      );
    }
  }
  if (total > MAX_PLAN_BYTES) throw new Error(`The build plan's files exceed ${formatBytes(MAX_PLAN_BYTES)}.`);

  for (const file of planned) {
    const shown = printable(file.path);
    if (file.status === 'unchanged') {
      logger.info(`${shown}: already in the repository.`);
      continue;
    }
    const target = join(workspace, ...file.path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, file.content);
    if (file.status === 'replaced') {
      logger.warning(`${shown}: the repository's copy differs from the build plan's; using the build plan's.`);
    } else {
      logger.info(`${shown}: written (${formatBytes(Buffer.byteLength(file.content, 'utf8'))}).`);
    }
  }
  return planned.map(({ path, status }) => ({ path, status }));
}

/**
 * Build plan mode (`build-plan: 'true'`, `phase: 'prepare'`), for a project bohr hosts whose repository keeps
 * bohr v1's workflow: asks the instance for the project's build plan with the run's GitHub OIDC token. Without
 * one (404), sets `found=false` and does nothing else, so the caller can fall back to bohr v1. With one: masks
 * and exports the build variables for the next steps, writes the plan's files into the workspace and sets the
 * outputs `found`, `node-version`, `install` and `build`. The caller sets up Node.js, installs and builds, then
 * runs this action again in its default mode to deploy.
 */
export async function prepareBuildPlan(
  options: BuildPlanOptions,
  deps: BuildPlanDependencies,
): Promise<BuildPlanResult> {
  const { logger } = deps;
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  const idToken = oidcTokens(deps.getIdToken, logger, deps.now ?? Date.now);

  const plan = await logger.group('Request the build plan', async (): Promise<BuildPlan | null> => {
    let token: string;
    try {
      token = await idToken();
    } catch (error) {
      // Without a token bohr cannot tell which project this is: leave the deploy to the caller's fallback
      logger.warning(`${errorMessage(error)} Continuing without a build plan.`);
      return null;
    }
    const answer = await requestBuildPlan({
      instanceUrl,
      token,
      fetch: deps.fetch,
      sleep: deps.sleep,
      log: (message) => logger.info(message),
    });
    if (answer === null) {
      logger.info(`${instanceUrl} has no build plan for this repository.`);
      return null;
    }
    // Before anything else can print them
    for (const value of Object.values(answer.buildVariables)) mask(logger, value);
    logger.info(
      `Got the build plan from ${instanceUrl}: Node.js ${printable(answer.nodeVersion)}, ${plural(Object.keys(answer.files).length, 'file')}.`,
    );
    return answer;
  });

  if (plan === null) {
    deps.setOutput('found', 'false');
    return { found: false };
  }

  const files = await logger.group('Write the build plan files', () =>
    writePlanFiles(options.workspace, plan.files, logger),
  );
  const variables = exportBuildVariables(plan.buildVariables, logger, deps.exportVariable);
  logger.info(`Install: ${plan.install === null ? 'none' : printable(plan.install)}`);
  logger.info(`Build: ${plan.build === null ? 'none' : printable(plan.build)}`);

  deps.setOutput('found', 'true');
  deps.setOutput('node-version', plan.nodeVersion);
  deps.setOutput('install', plan.install ?? '');
  deps.setOutput('build', plan.build ?? '');
  return { found: true, files, variables };
}
