import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/action';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

const {
  runId,
  repo: { repo, owner },
  eventName,
} = github.context;
const mainBranchName = core.getInput('main-branch-name');
const errorOnNoSuccessfulWorkflow = core.getBooleanInput(
  'error-on-no-successful-workflow',
);
const lastSuccessfulEvent = core.getInput('last-successful-event');
const workingDirectory = core.getInput('working-directory');
const workflowId = core.getInput('workflow-id');
const fallbackSHA = core.getInput('fallback-sha');
const defaultWorkingDirectory = '.';

const ProxifiedClient = Octokit.plugin(proxyPlugin);

let BASE_SHA: string;
(async () => {
  if (workingDirectory !== defaultWorkingDirectory) {
    if (existsSync(workingDirectory)) {
      process.chdir(workingDirectory);
    } else {
      process.stdout.write('\n');
      process.stdout.write(
        `WARNING: Working directory '${workingDirectory}' doesn't exist.\n`,
      );
    }
  }

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  });
  let HEAD_SHA = headResult.stdout;

  if (
    (['pull_request', 'pull_request_target'].includes(eventName) &&
      !github.context.payload.pull_request.merged) ||
    eventName == 'merge_group'
  ) {
    try {
      const mergeBaseRef = await findMergeBaseRef();
      const baseResult = spawnSync(
        'git',
        ['merge-base', `origin/${mainBranchName}`, mergeBaseRef],
        { encoding: 'utf-8' },
      );
      BASE_SHA = baseResult.stdout;
    } catch (e) {
      core.setFailed(e.message);
      return;
    }
  } else {
    try {
      BASE_SHA = await findSuccessfulCommit(
        workflowId,
        runId,
        owner,
        repo,
        mainBranchName,
        lastSuccessfulEvent,
      );
    } catch (e) {
      core.setFailed(e.message);
      return;
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow) {
        reportFailure(mainBranchName);
        return;
      } else {
        process.stdout.write('\n');
        process.stdout.write(
          `WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}', or the latest successful workflow was connected to a commit which no longer exists on that branch (e.g. if that branch was rebased)\n`,
        );
        if (fallbackSHA) {
          BASE_SHA = fallbackSHA;
          process.stdout.write(`Using provided fallback SHA: ${fallbackSHA}\n`);
        } else {
          process.stdout.write(
            `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`,
          );
          process.stdout.write('\n');
          process.stdout.write(
            `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`,
          );
          process.stdout.write('\n');

          const commitCountOutput = spawnSync(
            'git',
            ['rev-list', '--count', `origin/${mainBranchName}`],
            { encoding: 'utf-8' },
          ).stdout;
          const commitCount = parseInt(
            stripNewLineEndings(commitCountOutput),
            10,
          );

          const LAST_COMMIT_CMD = `origin/${mainBranchName}${
            commitCount > 1 ? '~1' : ''
          }`;
          const baseRes = spawnSync('git', ['rev-parse', LAST_COMMIT_CMD], {
            encoding: 'utf-8',
          });
          BASE_SHA = baseRes.stdout;
        }
        core.setOutput('noPreviousBuild', 'true');
      }
    } else {
      process.stdout.write('\n');
      process.stdout.write(
        `Found the last successful workflow run on 'origin/${mainBranchName}'\n`,
      );
      process.stdout.write(`Commit: ${BASE_SHA}\n`);
    }
  }

  BASE_SHA = stripNewLineEndings(BASE_SHA);
  HEAD_SHA = stripNewLineEndings(HEAD_SHA);

  // Log base and head SHAs used for nx affected
  process.stdout.write('\n');
  process.stdout.write('Base SHA');
  process.stdout.write(BASE_SHA);
  process.stdout.write('\n');
  process.stdout.write('Head SHA');
  process.stdout.write(HEAD_SHA);
  process.stdout.write('\n');

  // Optionally set the derived SHAs as NX_BASE and NX_HEAD environment variables for the current job
  if (core.getBooleanInput('set-environment-variables-for-job')) {
    core.exportVariable('NX_BASE', BASE_SHA);
    core.exportVariable('NX_HEAD', HEAD_SHA);
    process.stdout.write(
      'NX_BASE and NX_HEAD environment variables have been set for the current Job',
    );
  }

  core.setOutput('base', BASE_SHA);
  core.setOutput('head', HEAD_SHA);
})();

function reportFailure(branchName: string): void {
  core.setFailed(`
    Unable to find a successful workflow run on 'origin/${branchName}'
    NOTE: You have set 'error-on-no-successful-workflow' on the action so this is a hard error.

    Is it possible that you have no runs currently on 'origin/${branchName}'?
    - If yes, then you should run the workflow without this flag first.
    - If no, then you might have changed your git history and those commits no longer exist.`);
}

function proxyPlugin(octokit: Octokit): void {
  octokit.hook.before('request', (options) => {
    const proxy: URL = getProxyForUrl(options.baseUrl);
    if (proxy) {
      options.request.agent = new HttpsProxyAgent(proxy);
    }
  });
}

/**
 * Find last successful workflow run on the repo
 */
async function findSuccessfulCommit(
  workflow_id: string | undefined,
  run_id: number,
  owner: string,
  repo: string,
  branch: string,
  lastSuccessfulEvent: string,
): Promise<string | undefined> {
  const octokit = new ProxifiedClient();
  if (!workflow_id) {
    workflow_id = await octokit
      .request(`GET /repos/${owner}/${repo}/actions/runs/${run_id}`, {
        owner,
        repo,
        branch,
        run_id,
      })
      .then(({ data: { workflow_id } }) => workflow_id);
    process.stdout.write('\n');
    process.stdout.write(
      `Workflow Id not provided. Using workflow '${workflow_id}'\n`,
    );
  }
  // fetch all workflow runs on a given repo/branch/workflow with push and success
  const shas = await octokit
    .request(
      `GET /repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs`,
      {
        owner,
        repo,
        // on some workflow runs we do not have branch property
        branch:
          lastSuccessfulEvent === 'push' ||
          lastSuccessfulEvent === 'workflow_dispatch'
            ? branch
            : undefined,
        workflow_id,
        event: lastSuccessfulEvent,
        status: 'success',
      },
    )
    .then(({ data: { workflow_runs } }) =>
      workflow_runs.map((run: { head_sha: any }) => run.head_sha),
    );

  return await findExistingCommit(octokit, branch, shas);
}

async function findMergeBaseRef(): Promise<string> {
  if (eventName == 'merge_group') {
    const mergeQueueBranch = await findMergeQueueBranch();
    return `origin/${mergeQueueBranch}`;
  } else {
    return 'HEAD';
  }
}

function findMergeQueuePr(): string {
  const { head_ref, base_sha } = github.context.payload.merge_group;
  const result = new RegExp(
    `^refs/heads/gh-readonly-queue/${mainBranchName}/pr-(\\d+)-${base_sha}$`,
  ).exec(head_ref);
  return result ? result.at(1) : undefined;
}

async function findMergeQueueBranch(): Promise<string> {
  const pull_number = findMergeQueuePr();
  if (!pull_number) {
    throw new Error('Failed to determine PR number');
  }
  process.stdout.write('\n');
  process.stdout.write(`Found PR #${pull_number} from merge queue branch\n`);
  const octokit = new ProxifiedClient();
  const result = await octokit.request(
    `GET /repos/${owner}/${repo}/pulls/${pull_number}`,
    { owner, repo, pull_number: +pull_number },
  );
  return result.data.head.ref;
}

/**
 * Get first existing commit
 */
async function findExistingCommit(
  octokit: Octokit,
  branchName: string,
  shas: string[],
): Promise<string | undefined> {
  for (const commitSha of shas) {
    if (await commitExists(octokit, branchName, commitSha)) {
      return commitSha;
    }
  }
  return undefined;
}

/**
 * Check if given commit is valid
 */
async function commitExists(
  octokit: Octokit,
  branchName: string,
  commitSha: string,
): Promise<boolean> {
  try {
    spawnSync('git', ['cat-file', '-e', commitSha], {
      stdio: ['pipe', 'pipe', null],
    });

    // Check the commit exists in general
    await octokit.request('GET /repos/{owner}/{repo}/commits/{commit_sha}', {
      owner,
      repo,
      commit_sha: commitSha,
    });

    // Check the commit exists on the expected main branch (it will not in the case of a rebased main branch)
    const commits = await octokit.request('GET /repos/{owner}/{repo}/commits', {
      owner,
      repo,
      sha: branchName,
      per_page: 100,
    });

    return commits.data.some(
      (commit: { sha: string }) => commit.sha === commitSha,
    );
  } catch {
    return false;
  }
}

/**
 * Strips LF line endings from given string
 */
function stripNewLineEndings(string: string): string {
  return string.replace('\n', '');
}
