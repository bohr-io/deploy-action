import { resolve } from 'node:path';
import * as core from '@actions/core';
import { prepareBuildPlan } from './build-plan';
import { credentials } from './credentials';
import { type DeployResult, deploy, OIDC_AUDIENCE } from './deploy';
import { formatBytes } from './log';

const DEFAULT_INSTANCE_URL = 'https://app.bohr.io';

/** Action entry point: reads inputs, deploys (or only gets the credentials), sets outputs and the job summary. */
export async function run(): Promise<void> {
  try {
    const credentialsMode = core.getInput('credentials').trim().toLowerCase() === 'true';
    if (core.getInput('build-plan').trim().toLowerCase() === 'true') {
      if (credentialsMode) throw new Error('Set either credentials or build-plan, not both.');
      const phase = core.getInput('phase').trim().toLowerCase() || 'prepare';
      if (phase !== 'prepare') throw new Error(`Unknown phase "${phase}": build-plan only has the "prepare" phase.`);
      await prepareBuildPlan(
        {
          instanceUrl: core.getInput('instance-url') || DEFAULT_INSTANCE_URL,
          workspace: resolve(process.env.GITHUB_WORKSPACE || '.'),
        },
        {
          fetch: globalThis.fetch,
          getIdToken: () => core.getIDToken(OIDC_AUDIENCE),
          logger: { info: core.info, warning: core.warning, setSecret: core.setSecret, group: core.group },
          exportVariable: core.exportVariable,
          setOutput: core.setOutput,
        },
      );
      return;
    }
    if (credentialsMode) {
      await credentials(
        { instanceUrl: core.getInput('instance-url') || DEFAULT_INSTANCE_URL },
        {
          fetch: globalThis.fetch,
          getIdToken: () => core.getIDToken(OIDC_AUDIENCE),
          logger: { info: core.info, warning: core.warning, setSecret: core.setSecret, group: core.group },
          exportVariable: core.exportVariable,
          setOutput: core.setOutput,
        },
      );
      return;
    }
    const result = await deploy(
      {
        workingDirectory: resolve(core.getInput('working-directory') || '.'),
        instanceUrl: core.getInput('instance-url') || DEFAULT_INSTANCE_URL,
        commitSha: process.env.GITHUB_SHA || null,
      },
      {
        fetch: globalThis.fetch,
        getIdToken: () => core.getIDToken(OIDC_AUDIENCE),
        logger: { info: core.info, warning: core.warning, setSecret: core.setSecret, group: core.group },
      },
    );
    core.setOutput('url', result.url);
    core.setOutput('deployment-id', result.deploymentId);
    await writeSummary(result);
  } catch (error) {
    if (error instanceof Error && error.stack) core.debug(error.stack);
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

async function writeSummary(result: DeployResult): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const url = escapeHtml(result.url);
  const uploaded =
    result.uploadedFiles > 0
      ? `${result.uploadedFiles} (${formatBytes(result.uploadedBytes)})`
      : String(result.uploadedFiles);
  try {
    await core.summary
      .addHeading('bohr.io Cloud deploy', 2)
      .addRaw(`<p>Deployed to <a href="${url}">${url}</a></p>`, true)
      .addTable([
        [
          { data: 'Files', header: true },
          { data: 'Uploaded', header: true },
          { data: 'Bytes', header: true },
          { data: 'Worker modules', header: true },
          { data: 'Deployment', header: true },
        ],
        [
          String(result.assetFiles),
          uploaded,
          formatBytes(result.assetBytes),
          String(result.modules),
          escapeHtml(result.deploymentId),
        ],
      ])
      .write();
  } catch (error) {
    core.warning(`Could not write the job summary: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

void run();
