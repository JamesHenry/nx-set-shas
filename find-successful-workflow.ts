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
        `WARNING: Working directory '${workingDirectory}' doesn't exist.\n`,
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
        { encoding: "utf-8" },
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
    //todo move to inputs
    const getLastSkippedCommitAfterBase = true;
    const messagesToSkip = ["[skip ci]"];
    if (getLastSkippedCommitAfterBase && BASE_SHA) {
      BASE_SHA = await findLastSkippedCommitAfterSha(
        stripNewLineEndings(BASE_SHA),
        stripNewLineEndings(HEAD_SHA),
        messagesToSkip,
        mainBranchName,
      );
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow === "true") {
        reportFailure(mainBranchName);
        return;
      } else {
        process.stdout.write("\n");
        process.stdout.write(
          `WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}', or the latest successful workflow was connected to a commit which no longer exists on that branch (e.g. if that branch was rebased)\n`,
        );
        process.stdout.write(
          `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`,
        );
        process.stdout.write("\n");
        process.stdout.write(
          `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`,
        );
        if (fallbackSHA) {
          BASE_SHA = fallbackSHA;
          process.stdout.write(`Using provided fallback SHA: ${fallbackSHA}\n`);
        } else {
          process.stdout.write(
            `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`,
          );
          process.stdout.write("\n");
          process.stdout.write(
            `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`,
          );
          process.stdout.write("\n");

          const commitCountOutput = spawnSync(
            "git",
            ["rev-list", "--count", `origin/${mainBranchName}`],
            { encoding: "utf-8" },
          ).stdout;
          const commitCount = parseInt(
            stripNewLineEndings(commitCountOutput),
            10,
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
        `Found the last successful workflow run on 'origin/${mainBranchName}'\n`,
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
    process.stdout.write("\n");
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
          lastSuccessfulEvent === "push" ||
          lastSuccessfulEvent === "workflow_dispatch"
            ? branch
            : undefined,
        workflow_id,
        event: lastSuccessfulEvent,
        status: "success",
      },
    )
    .then(({ data: { workflow_runs } }) =>
      workflow_runs.map((run: { head_sha: any }) => run.head_sha),
    );

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
    `^refs/heads/gh-readonly-queue/${mainBranchName}/pr-(\\d+)-${base_sha}$`,
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
  return string.replace("\n", "");
}
/**
 * Takes in an sha and then will walk forward in time finding the last commit that was a skip-ci type to use that as the new base
 */
async function findLastSkippedCommitAfterSha(
  baseSha: string,
  headSha: string,
  messagesToSkip: string[] = [],
  branchName: string,
): Promise<string | undefined> {
  process.stdout.write(
    `Checking commits from "${baseSha}" onwards for skip ci messages\n`,
  );
  if (!messagesToSkip.length) {
    process.stdout.write(`messagesToSkip was empty, returning\n`);
    return;
  }
  const octokit = new ProxifiedClient();
  const baseCommit = await getCommit(octokit, baseSha);
  const headCommit = await getCommit(octokit, headSha);
  const commits = (
    await findAllCommitsBetweenShas(octokit, branchName, baseCommit, headCommit)
  ).filter((c) => c.sha !== baseSha);
  process.stdout.write(`Got ${commits.length} total commits to check:\n`);
  const sortedCommits = commits.sort((a, b) => a.date.localeCompare(b.date));

  let newBaseSha = baseSha;
  for (const commit of sortedCommits) {
    const containsAnySkipMessages = messagesToSkip.some(
      (m) => commit.message.indexOf(m) >= 0,
    );
    process.stdout.write(
      `[${commit.sha}][${containsAnySkipMessages}]: ${commit.message}\n`,
    );
    if (containsAnySkipMessages) {
      newBaseSha = commit.sha;
      continue;
    }
    return newBaseSha;
  }
  return newBaseSha;
}

async function findAllCommitsBetweenShas(
  octokit: Octokit,
  branchName: string,
  baseCommit: SimplifiedCommit,
  headCommit: SimplifiedCommit,
  page = 1,
): Promise<SimplifiedCommit[]> {
  process.stdout.write(
    `Finding all commits on branch "${branchName}" between ${baseCommit.sha}|${baseCommit.date} and ${headCommit.sha}|${headCommit.date}, page: ${page}\n`,
  );
  let commits = (
    await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      sha: branchName,
      since: baseCommit.date,
      until: headCommit.date,
      page,
      per_page: 100,
    })
  ).data.map(getSimplifiedCommit);
  const resultsContainsHead = commits.some((c) => c.sha === headCommit.sha);
  if (!resultsContainsHead) {
    //need to get the next page as we haven't reached the head yet.
    commits = commits.concat(
      await findAllCommitsBetweenShas(
        octokit,
        branchName,
        baseCommit,
        headCommit,
        page + 1,
      ),
    );
  }
  return commits;
}

/**
 * Gets the specified commit by its SHA
 */
async function getCommit(octokit: Octokit, commitSha: string) {
  process.stdout.write(`Getting commit for sha: ${commitSha}\n`);
  const fullCommit = (
    await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}", {
      owner,
      repo,
      commit_sha: commitSha,
    })
  ).data;
  process.stdout.write(`SHA get succeeded: ${commitSha}\n`);
  return getSimplifiedCommit(fullCommit);
}
/**
 * strips out properties from the GitHub commit object to a simplified version for working with
 */
function getSimplifiedCommit(commit: Commit): SimplifiedCommit {
  return {
    sha: commit.sha,
    message: commit.commit.message,
    date: commit.commit.committer.date,
  };
}
interface SimplifiedCommit {
  sha: string;
  message: string;
  date: string;
}

export interface Commit {
  url: string;
  sha: string;
  node_id: string;
  html_url: string;
  comments_url: string;
  commit: {
    url: string;
    author: null | GitUser;
    committer: null | GitUser1;
    message: string;
    comment_count: number;
    tree: {
      sha: string;
      url: string;
      [k: string]: unknown;
    };
    verification?: Verification;
    [k: string]: unknown;
  };
  author: null | SimpleUser;
  committer: null | SimpleUser1;
  parents: {
    sha: string;
    url: string;
    html_url?: string;
    [k: string]: unknown;
  }[];
  stats?: {
    additions?: number;
    deletions?: number;
    total?: number;
    [k: string]: unknown;
  };
  files?: DiffEntry[];
  [k: string]: unknown;
}
/**
 * Metaproperties for Git author/committer information.
 */
export interface GitUser {
  name?: string;
  email?: string;
  date?: string;
  [k: string]: unknown;
}
/**
 * Metaproperties for Git author/committer information.
 */
export interface GitUser1 {
  name?: string;
  email?: string;
  date?: string;
  [k: string]: unknown;
}
export interface Verification {
  verified: boolean;
  reason: string;
  payload: string | null;
  signature: string | null;
  [k: string]: unknown;
}
/**
 * A GitHub user.
 */
export interface SimpleUser {
  name?: string | null;
  email?: string | null;
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string | null;
  url: string;
  html_url: string;
  followers_url: string;
  following_url: string;
  gists_url: string;
  starred_url: string;
  subscriptions_url: string;
  organizations_url: string;
  repos_url: string;
  events_url: string;
  received_events_url: string;
  type: string;
  site_admin: boolean;
  starred_at?: string;
  [k: string]: unknown;
}
/**
 * A GitHub user.
 */
export interface SimpleUser1 {
  name?: string | null;
  email?: string | null;
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string | null;
  url: string;
  html_url: string;
  followers_url: string;
  following_url: string;
  gists_url: string;
  starred_url: string;
  subscriptions_url: string;
  organizations_url: string;
  repos_url: string;
  events_url: string;
  received_events_url: string;
  type: string;
  site_admin: boolean;
  starred_at?: string;
  [k: string]: unknown;
}
/**
 * Diff Entry
 */
export interface DiffEntry {
  sha: string;
  filename: string;
  status:
    | "added"
    | "removed"
    | "modified"
    | "renamed"
    | "copied"
    | "changed"
    | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch?: string;
  previous_filename?: string;
  [k: string]: unknown;
}
