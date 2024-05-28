import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/action";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

const {
  runId,
  repo: { repo, owner },
  eventName,
} = github.context;
process.env.GITHUB_TOKEN = process.argv[2];
const mainBranchName = process.argv[3];
const errorOnNoSuccessfulWorkflow = process.argv[4];
const lastSuccessfulEvent = process.argv[5];
const workingDirectory = process.argv[6];
const workflowId = process.argv[7];
const fallbackSHA = process.argv[8];
const defaultWorkingDirectory = ".";

const ProxifiedClient = Octokit.plugin(proxyPlugin);

let BASE_SHA: string;
(async () => {
  if (workingDirectory !== defaultWorkingDirectory) {
    if (existsSync(workingDirectory)) {
      process.chdir(workingDirectory);
    } else {
      process.stdout.write("\n");
      process.stdout.write(
        `WARNING: Working directory '${workingDirectory}' doesn't exist.\n`
      );
    }
  }

  const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  const HEAD_SHA = headResult.stdout;

  if (
    (["pull_request", "pull_request_target"].includes(eventName) &&
      !github.context.payload.pull_request.merged) ||
    eventName == "merge_group"
  ) {
    try {
      const mergeBaseRef = await findMergeBaseRef();
      const baseResult = spawnSync(
        "git",
        ["merge-base", `origin/${mainBranchName}`, mergeBaseRef],
        { encoding: "utf-8" }
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
        lastSuccessfulEvent
      );
    } catch (e) {
      core.setFailed(e.message);
      return;
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow === "true") {
        reportFailure(mainBranchName);
        return;
      } else {
        process.stdout.write("\n");
        process.stdout.write(
          `WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}', or the latest successful workflow was connected to a commit which no longer exists on that branch (e.g. if that branch was rebased)\n`
        );
        process.stdout.write(
          `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`
        );
        process.stdout.write("\n");
        process.stdout.write(
          `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`
        );
        if (fallbackSHA) {
          BASE_SHA = fallbackSHA;
          process.stdout.write(`Using provided fallback SHA: ${fallbackSHA}\n`);
        } else {
          process.stdout.write(
            `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`
          );
          process.stdout.write("\n");
          process.stdout.write(
            `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`
          );
          process.stdout.write("\n");

          const commitCountOutput = spawnSync(
            "git",
            ["rev-list", "--count", `origin/${mainBranchName}`],
            { encoding: "utf-8" }
          ).stdout;
          const commitCount = parseInt(
            stripNewLineEndings(commitCountOutput),
            10
          );

          const LAST_COMMIT_CMD = `origin/${mainBranchName}${
            commitCount > 1 ? "~1" : ""
          }`;
          const baseRes = spawnSync("git", ["rev-parse", LAST_COMMIT_CMD], {
            encoding: "utf-8",
          });
          BASE_SHA = baseRes.stdout;
        }
        core.setOutput("noPreviousBuild", "true");
      }
    } else {
      process.stdout.write("\n");
      process.stdout.write(
        `Found the last successful workflow run on 'origin/${mainBranchName}'\n`
      );
      process.stdout.write(`Commit: ${BASE_SHA}\n`);
    }
  }
  core.setOutput("base", stripNewLineEndings(BASE_SHA));
  core.setOutput("head", stripNewLineEndings(HEAD_SHA));
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
  octokit.hook.before("request", (options) => {
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
  lastSuccessfulEvent: string
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
    process.stdout.write("\n");
    process.stdout.write(
      `Workflow Id not provided. Using workflow '${workflow_id}'\n`
    );
  }
  let shas = [];
  // if there are several events separated by comma
  if (lastSuccessfulEvent.includes(",")) {
    // find the greatest workflow id among the types and retrieve the sha
    const events = lastSuccessfulEvent.split(",");
    const workflowIdMap = new Map();
    for (const event of events) {
      const workflowRun = await octokit
        .request(
          `GET /repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs`,
          {
            owner,
            repo,
            // on non-push workflow runs we do not have branch property
            branch:
              lastSuccessfulEvent === "push" ||
              lastSuccessfulEvent === "workflow_dispatch"
                ? branch
                : undefined,
            event,
            workflow_id,
          }
        )
        .then(({ data }) => {
          return data.workflow_runs[0];
        });
      workflowIdMap.set(workflowRun.id, workflowRun.head_sha);
    }
    shas.push(workflowIdMap.get(Math.max(...workflowIdMap.keys())));
  } else {
    // fetch all workflow runs on a given repo/branch/workflow with push and success
    shas = await octokit
      .request(
        `GET /repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs`,
        {
          owner,
          repo,
          // on non-push workflow runs we do not have branch property
          branch:
            lastSuccessfulEvent === "push" ||
            lastSuccessfulEvent === "workflow_dispatch"
              ? branch
              : undefined,
          workflow_id,
          event: lastSuccessfulEvent,
          status: "success",
        }
      )
      .then(({ data: { workflow_runs } }) =>
        workflow_runs.map((run: { head_sha: any }) => run.head_sha)
      );
  }

  return await findExistingCommit(octokit, branch, shas);
}

async function findMergeBaseRef(): Promise<string> {
  if (eventName == "merge_group") {
    const mergeQueueBranch = await findMergeQueueBranch();
    return `origin/${mergeQueueBranch}`;
  } else {
    return "HEAD";
  }
}

function findMergeQueuePr(): string {
  const { head_ref, base_sha } = github.context.payload.merge_group;
  const result = new RegExp(
    `^refs/heads/gh-readonly-queue/${mainBranchName}/pr-(\\d+)-${base_sha}$`
  ).exec(head_ref);
  return result ? result.at(1) : undefined;
}

async function findMergeQueueBranch(): Promise<string> {
  const pull_number = findMergeQueuePr();
  if (!pull_number) {
    throw new Error("Failed to determine PR number");
  }
  process.stdout.write("\n");
  process.stdout.write(`Found PR #${pull_number} from merge queue branch\n`);
  const octokit = new ProxifiedClient();
  const result = await octokit.request(
    `GET /repos/${owner}/${repo}/pulls/${pull_number}`,
    { owner, repo, pull_number: +pull_number }
  );
  return result.data.head.ref;
}

/**
 * Get first existing commit
 */
async function findExistingCommit(
  octokit: Octokit,
  branchName: string,
  shas: string[]
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
  commitSha: string
): Promise<boolean> {
  try {
    spawnSync("git", ["cat-file", "-e", commitSha], {
      stdio: ["pipe", "pipe", null],
    });

    // Check the commit exists in general
    await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}", {
      owner,
      repo,
      commit_sha: commitSha,
    });

    // Check the commit exists on the expected main branch (it will not in the case of a rebased main branch)
    const commits = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      sha: branchName,
      per_page: 100,
    });

    return commits.data.some(
      (commit: { sha: string }) => commit.sha === commitSha
    );
  } catch {
    return false;
  }
}

/**
 * Strips LF line endings from given string
 */
function stripNewLineEndings(string: string): string {
  return string.replace("\n", "");
}
