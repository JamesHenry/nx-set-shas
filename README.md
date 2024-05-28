<p style="text-align: center;"><img src=".github/assets/nx.png" 
width="100%" alt="Nx - Smart, Extensible Build Framework"></p>

<h1 align="center">Set SHAs Action</h2>

✨ A Github Action which sets the base and head SHAs required for the `nx affected` commands in CI

- [Example Usage](#example-usage)
- [Configuration Options](#configuration-options)
- [Permissions in v2+](#permissions-in-v2)
- [Self-hosted runners](#self-hosted-runners)
- [Background](#background)
  - [Problem](#problem)
- [License](#license)

**NOTE:** This documentation is for version `2.x.x+` which now uses the GitHub API to track successful workflows. You can find documentation for version `1.x.x` which used GIT tags [here](https://github.com/nrwl/nx-set-shas/blob/v1/README.md).

**NOTE:** The `v4` does no longer support deprecated Node versions. Supported version is `Node v18+`.

## Example Usage

**.github/workflows/ci.yml**

<!-- start example-usage -->

```yaml
# ... more CI config ...

jobs:
  myjob:
    runs-on: ubuntu-latest
    name: My Job
    steps:
      - uses: actions/checkout@v4
        with:
          # We need to fetch all branches and commits so that Nx affected has a base to compare against.
          fetch-depth: 0

      # In any subsequent steps within this job (myjob) we can reference the resolved SHAs
      # using either the step outputs or environment variables:

      # ===========================================================================
      # OPTION 1) Environment variables
      # ===========================================================================
      - name: Derive appropriate SHAs for base and head for `nx affected` commands
        uses: nrwl/nx-set-shas@v4

      - run: |
          echo "BASE: ${{ env.NX_BASE }}"
          echo "HEAD: ${{ env.NX_HEAD }}"

      # ===========================================================================
      # OPTION 2) Step outputs (in this case we must give the step an "id")
      # ===========================================================================
      - name: Derive appropriate SHAs for base and head for `nx affected` commands
        id: setSHAs
        uses: nrwl/nx-set-shas@v4

      - run: |
          echo "BASE: ${{ steps.setSHAs.outputs.base }}"
          echo "HEAD: ${{ steps.setSHAs.outputs.head }}"

      # ... more CI config ...
```

<!-- end example-usage -->

## Configuration Options

<!-- start configuration-options -->

```yaml
- uses: nrwl/nx-set-shas@v4
  with:
    # The "main" branch of your repository (the base branch which you target with PRs).
    # Common names for this branch include main and master.
    #
    # Default: main
    main-branch-name: ""

    # Applies the derived SHAs for base and head as NX_BASE and NX_HEAD environment variables within the current Job.
    #
    # Default: true
    set-environment-variables-for-job: ""

    # By default, if no successful workflow run is found on the main branch to determine the SHA, we will log a warning and use HEAD~1. Enable this option to error and exit instead.
    #
    # Default: false
    error-on-no-successful-workflow: ""

    # Fallback SHA to use if no successful workflow run is found. This can be useful in scenarios where you need a specific commit as a reference for comparison, especially in newly set up repositories or those with sparse workflow runs.
    #
    # Default: ""
    fallback-sha: ""

    # The type of event to check for the last successful commit corresponding to that workflow-id, e.g. push, pull_request, release etc.
    #
    # Default: push
    last-successful-event: ""

    # The path where your repository is. This is only required for cases where the repository code is checked out or moved to a specific path.
    #
    # Default: .
    working-directory: ""

    # The ID of the github action workflow to check for successful run or the name of the file name containing the workflow.
    # E.g. 'ci.yml'. If not provided, current workflow id will be used
    #
    workflow-id: ""

    # Specifies if the NX_BASE SHA should be set to the last [skip-ci] commit that occurred after the original NX_BASE. Includes [ci skip], [no ci], [skip actions], [actions skip]. Useful if your GitHub action commits tags, version numbers, etc to the repository which should not be included
    # Default: false
    get-last-skip-ci-commit: false
```

<!-- end configuration-options -->

## Permissions in v2+

This Action uses Github API to find the last successful workflow run. If your `GITHUB_TOKEN` has restrictions set please ensure you override them for the workflow to enable read access to `actions` and `contents`:

<!-- start permissions-in-v2 -->

```yaml
jobs:
  myjob:
    runs-on: ubuntu-latest
    name: My Job
    permissions:
      contents: "read"
      actions: "read"
```

<!-- end permissions-in-v2 -->

## Self-hosted runners

This Action supports usage of your own self-hosted runners, but since it uses GitHub APIs you will need to grant it explicit access rights:

<!-- self-hosted runners -->

```yaml
# ... more CI config ...

jobs:
  myjob:
    runs-on: self-hosted
      container: my-org/my-amazing-image:v1.2.3-fresh
    name: My Job
    steps:
      - uses: actions/checkout@v4
        with:
          # We need to fetch all branches and commits so that Nx affected has a base to compare against.
          fetch-depth: 0

      # Mark your git directory as safe
      - name: Set Directory as Safe
        run: |
          git config --system --add safe.directory "$GITHUB_WORKSPACE"
        shell: bash

      - name: Derive appropriate SHAs for base and head for `nx affected` commands
        uses: nrwl/nx-set-shas@v4

      - run: |
          echo "BASE: ${{ env.NX_BASE }}"
          echo "HEAD: ${{ env.NX_HEAD }}"

      # ... more CI config ...
```

<!-- end self-hosted runners -->

## Background

When we run the `affected` command on [Nx](https://nx.dev/), we can specify 2 git history positions - base and head, and it calculates which projects in your repository changed between those 2 commits. We can then run a set of tasks (like building or linting) only on those **affected** projects.

This makes it easy to set up a CI system that scales well with the continuous growth of your repository, as you add more and more projects.

### Problem

Figuring out what these two git commits are might not be as simple as it seems.

On a CI system that runs on submitted PRs, we determine what commits to include in the **affected** calculation by comparing our `HEAD-commit-of-PR-branch` to the commit in the main branch (`master` or `main` usually) from which the PR branch originated. This will ensure the entirety of our PR is always being tested.

But what if we want to set up a continuous deployment system
that, as changes get pushed to `master`, builds and deploys
only the affected projects?
What are the `FROM` and `TO` commits in that case?

Conceptually, what we want is to use the absolute latest commit on the `master` branch as the HEAD, and the previous _successful_ commit on the `master` as the BASE. Note, we want the previous _successful_ one because it is still possible for commits on the `master` branch to fail for a variety of reasons.

The commits therefore can't just be `HEAD` and `HEAD~1`. If a few deployments fail one after another, that means that we're accumulating a list of affected projects that are not getting deployed. Anytime we retry the deployment, we want to include **every commit since the last time we deployed successfully**. That way we ensure we don't accidentally skip deploying a project that has changed.

This action enables you to find:

- Commit SHA from which PR originated (in the case of `pull_request`)
- Commit SHA of the last successful CI run

## License

[MIT](http://opensource.org/licenses/MIT)

Copyright (c) 2021-present Narwhal Technologies Inc.
