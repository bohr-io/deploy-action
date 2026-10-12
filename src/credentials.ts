import { oidcTokens } from './deploy';
import type { Fetch, Sleep } from './http';
import { normalizeInstanceUrl, requestDeployCredentials } from './instance';
import type { Logger } from './log';
import { exportBuildVariables, mask } from './variables';

export interface CredentialsOptions {
  instanceUrl: string;
}

export interface CredentialsDependencies {
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

export interface CredentialsResult {
  accountId: string;
  /** Names of the build variables exported to the next steps. */
  variables: string[];
}

/**
 * Credentials mode (`credentials: 'true'`), for projects in their owner's Cloudflare account: asks the bohr
 * instance for the production deploy's Cloudflare credentials and build variables with the run's GitHub
 * OIDC token. Every value is masked. The build variables go to the environment of the next steps; the
 * Cloudflare token and account go to this step's outputs (cloudflare-api-token, cloudflare-account-id), so
 * only the step that maps them (the deploy) gets them, not the install and build. Nothing is deployed.
 */
export async function credentials(
  options: CredentialsOptions,
  deps: CredentialsDependencies,
): Promise<CredentialsResult> {
  const { logger } = deps;
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  const idToken = oidcTokens(deps.getIdToken, logger, deps.now ?? Date.now);

  const result = await logger.group('Request the deploy credentials', async () => {
    const token = await idToken();
    const answer = await requestDeployCredentials({
      instanceUrl,
      token,
      fetch: deps.fetch,
      sleep: deps.sleep,
      log: (message) => logger.info(message),
    });
    // Before anything else can print them
    mask(logger, answer.apiToken);
    mask(logger, answer.accountId);
    for (const value of Object.values(answer.buildVariables)) mask(logger, value);
    logger.info(`Got the Cloudflare credentials of account ${answer.accountId} from ${instanceUrl}.`);
    return answer;
  });

  deps.setOutput('cloudflare-api-token', result.apiToken);
  deps.setOutput('cloudflare-account-id', result.accountId);

  const variables = exportBuildVariables(result.buildVariables, logger, deps.exportVariable);
  return { accountId: result.accountId, variables };
}
