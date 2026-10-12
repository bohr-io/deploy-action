import { type Logger, plural } from './log';

/** Names a build variable cannot take: the runner's, GitHub's and the deploy credentials'. */
const RESERVED_NAME = /^(GITHUB_|RUNNER_|ACTIONS_|CLOUDFLARE_)|^CI$/;
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Masks a value in every later log line, each line of a multi-line value too. */
export function mask(logger: Logger, value: string): void {
  if (value === '') return;
  logger.setSecret(value);
  if (!value.includes('\n')) return;
  for (const line of value.split(/\r?\n/)) if (line.trim() !== '') logger.setSecret(line);
}

/**
 * Exports build variables (already masked) to the environment of the next steps, skipping names the build
 * cannot use. Logs the names, never the values. Returns the names exported.
 */
export function exportBuildVariables(
  variables: Record<string, string>,
  logger: Logger,
  exportVariable: (name: string, value: string) => void,
): string[] {
  const exported: string[] = [];
  for (const [name, value] of Object.entries(variables)) {
    if (!VALID_NAME.test(name) || RESERVED_NAME.test(name)) {
      logger.warning(`Skipped the build variable "${name.replace(/[^\w-]/g, '?')}": not a name the build can use.`);
      continue;
    }
    exportVariable(name, value);
    exported.push(name);
  }
  logger.info(
    exported.length === 0
      ? 'No build variables set in bohr.'
      : `${plural(exported.length, 'build variable')} for the next steps: ${exported.join(', ')}.`,
  );
  return exported;
}
