# Reusable GitHub Workflows for CI/CD

This repository contains reusable GitHub Actions workflows designed to streamline the process of building, publishing,
and deploying containerized applications across your organization.

## Workflows Overview

This repository contains four main reusable workflows:

1. **Update Deployment Manifest** (`.github/workflows/update-deployment.yml`): Updates deployment manifests in a
   separate repository with new image tags.
2. **Three language-specific container build workflows**:
    - **Java** (`.github/workflows/java-docker-build-push.yml`): Builds and publishes container
      images for Java applications.
    - **Golang** (`.github/workflows/golang-docker-build-push.yml`): Builds and publishes container
      images for Node.js applications.
    - **Web (NodeJS)** (`.github/workflows/web-docker-build-push`): Builds and publishes Node.jscontainer
      images for `web-base`-based applications

## Prerequisites

Before using these workflows, ensure you have:

-   **GitHub Repository**: A source code repository to build from
-   **Dockerfile**: A properly configured Dockerfile in your repository

---

For @mssfoobar, we've already configured the following, other organizations will need to set these up as well:

-   **GitHub Container Registry**: Access to ghcr.io or another container registry
-   **Deployment Repository**: A separate repository containing your deployment manifests
-   **GitHub App**: A GitHub App with appropriate permissions for updating the deployment repository
    -   `DEPLOYMENT_APP_ID`: The ID of your GitHub App used for authentication
    -   `DEPLOYMENT_APP_PRIVATE_KEY`: The private key of your GitHub App used for authentication

## Setup Instructions

### 1. Create Your Workflow File

1. Create a new file in your repository at `.github/workflows/build-deploy.yml`
2. Copy the example workflow (`dev-build-service.yml`) as a starting point
3. Customize the environment variables and triggers as needed

## Workflow Details

### Docker Build and Push Workflow

**File**: `.github/workflows/web-docker-build-push.yml`

#### Inputs

| Name            | Description                                    | Required | Default |
| --------------- | ---------------------------------------------- | -------- | ------- |
| `image_prefix`  | Container registry prefix (e.g., ghcr.io)      | Yes      | -       |
| `org_name`      | Organization name (e.g. mssfoobar)             | Yes      | -       |
| `app_name`      | Application name (e.g. gis/gis-app)            | Yes      | -       |
| `build_context` | Directory containing the Dockerfile (e.g. app) | Yes      | -       |

#### Outputs

| Name        | Description                                  |
| ----------- | -------------------------------------------- |
| `image_tag` | The full image tag that was built and pushed |

This image tag is meant to be used during the deployment manifest file update stage.

#### Behavior

This workflow:

1. Checks out your repository
2. Logs in to the container registry
3. Builds the Docker image with appropriate tags
4. Pushes the image to the registry
5. Sets additional tags (latest/latest-dev) based on trigger context

### Update Deployment Manifest Workflow

**File**: `.github/workflows/update-deployment.yml`

#### Inputs

| Name              | Description                                     | Required | Default |
| ----------------- | ----------------------------------------------- | -------- | ------- |
| `org_name`        | GitHub organization name (e.g. mssfoobar)       | Yes      | -       |
| `manifest_repo`   | Repository containing the deployment manifests  | Yes      | -       |
| `manifest_branch` | Branch in the manifest repository to update     | Yes      | -       |
| `manifest_path`   | Path to the manifest file within the repository | Yes      | -       |
| `new_image_tag`   | New image tag to be updated in the manifest     | Yes      | -       |

#### Secrets

| Name                         | Description                           | Required |
| ---------------------------- | ------------------------------------- | -------- |
| `DEPLOYMENT_APP_ID`          | GitHub App ID for deployment          | Yes      |
| `DEPLOYMENT_APP_PRIVATE_KEY` | GitHub App Private Key for deployment | Yes      |

#### Behavior

This workflow:

1. Generates a GitHub App token for authentication
2. Checks out the manifest repository
3. Updates the image tag in the manifest file
4. Commits and pushes the changes back to the manifest repository

The GitHub App is required to allow the workflow to have access to modify the manifest repository's contents. Please
ensure your GitHub App is configured to have access to modify contents the target repo.

## Example Usage

You can find examples in the `workflow-templates` folder.

### Additional Matrix Build Example

WARNING: I generated this workflow example with an LLM! It will almost certainly not work, because I believe `env`'s
can't be used inside the "with" section. Please update accordingly. I'll come back and test this when I'm free
(someday...)

Below is an example of how to use a matrix strategy for repositories containing multiple services with different
language stacks:

```yaml
name: Multi-Service Build and Deploy

on:
    push:
        branches: [main, dev]
    pull_request:
        branches: [main]
    workflow_dispatch:

env:
    ORG_NAME: your-org-name
    IMAGE_PREFIX: ghcr.io
    MANIFEST_REPO: your-org/manifests
    MANIFEST_BRANCH: main

jobs:
    # Define the service matrix
    matrix-prep:
        runs-on: ubuntu-latest
        outputs:
            services: ${{ steps.set-matrix.outputs.services }}
        steps:
            - id: set-matrix
              run: |
                  echo "services=[
                    {
                      \"name\": \"api\", 
                      \"type\": \"java\", 
                      \"context\": \"./services/java-api\",
                      \"manifest_path\": \"deployments/api/deployment.yaml\"
                    },
                    {
                      \"name\": \"frontend\", 
                      \"type\": \"nodejs\", 
                      \"context\": \"./services/nodejs-frontend\",
                      \"manifest_path\": \"deployments/frontend/deployment.yaml\"
                    },
                    {
                      \"name\": \"data-processor\", 
                      \"type\": \"python\", 
                      \"context\": \"./services/python-processor\",
                      \"manifest_path\": \"deployments/data-processor/deployment.yaml\"
                    }
                  ]" >> $GITHUB_OUTPUT

    # Build each service using the appropriate workflow
    build-images:
        needs: matrix-prep
        strategy:
            matrix:
                service: ${{ fromJSON(needs.matrix-prep.outputs.services) }}
            fail-fast: false
        name: Build ${{ matrix.service.name }}
        uses: ./.github/workflows/${{ matrix.service.type }}-build-push.yml
        with:
            image_prefix: ${{ env.IMAGE_PREFIX }}
            org_name: ${{ env.ORG_NAME }}
            app_name: ${{ matrix.service.name }}
            build_context: ${{ matrix.service.context }}

    # Update deployments for each service (on main branch or workflow_dispatch)
    update-deployments:
        needs: build-images
        if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'
        strategy:
            matrix:
                service: ${{ fromJSON(needs.matrix-prep.outputs.services) }}
            fail-fast: false
        name: Update ${{ matrix.service.name }} Deployment
        uses: ./.github/workflows/update-deployment.yml
        with:
            org_name: ${{ env.ORG_NAME }}
            manifest_repo: ${{ env.MANIFEST_REPO }}
            manifest_branch: ${{ env.MANIFEST_BRANCH }}
            manifest_path: ${{ matrix.service.manifest_path }}
            new_image_tag: ${{ needs.build-images.outputs[format('{0}_image_tag', matrix.service.name)] }}
        secrets:
            DEPLOYMENT_APP_ID: ${{ vars.DEPLOYMENT_APP_ID }}
            DEPLOYMENT_APP_PRIVATE_KEY: ${{ secrets.DEPLOYMENT_APP_PRIVATE_KEY }}
```

## NPM Lazy + Snapshot Release Pattern

Four reusable workflows for npm projects (single package or multi-package
workspaces) that follow the **lazy + snapshot release** model. The pattern:

| Branch     | Trigger    | What runs               | Dist-tag |
|------------|------------|-------------------------|----------|
| `develop`  | every push | snapshot publish        | `@alpha` |
| `*/rc`     | every push | snapshot publish        | `@next`  |
| `main`     | every push | stable publish          | `@latest`|

**Lazy version bumps**: `changeset version` (the real one, no `--snapshot`)
runs only at the actual release ceremony — manually on the rc branch before
opening the rc → main PR. develop and rc publish snapshots that mutate
package.json transiently in CI and never commit. This avoids GitHub's
anti-recursion gotcha entirely (`GITHUB_TOKEN`-authenticated pushes don't
trigger downstream workflows), so plain `GITHUB_TOKEN` is sufficient — no PAT
or App-token needed.

**Per-package detection** in `npm-snapshot-publish` ensures only packages
whose version actually changed (because a pending changeset affected them)
are published; unchanged packages are skipped.

Canonical implementation: see [mssfoobar/aa-cli](https://github.com/mssfoobar/aa-cli).

### Package manager

All three workflows that install dependencies (`npm-pr-validation`,
`npm-snapshot-publish`, `npm-stable-publish`) accept a `package-manager`
input — `npm` (default) or `pnpm`. With `pnpm`, the workflow installs pnpm
via `pnpm/action-setup`, uses `pnpm install --frozen-lockfile`, caches
`pnpm-lock.yaml`, and invokes scripts via `pnpm <script>`. The snapshot
publish reusable additionally swaps its per-package detection from reading
`package.json#workspaces` to `pnpm list -r --depth=-1 --json`, and publishes
via `pnpm --filter "./<path>" publish --no-git-checks` (path-based filter,
mirroring the npm path's `--workspace <path>`).

**Prerequisite for `pnpm`:** consumers must either declare `packageManager`
in their root `package.json` (preferred — locks the same version locally
and in CI) **or** pass `pnpm-version` to the reusable. Without one of
these, `pnpm/action-setup` errors. Example:

```json
{
  "packageManager": "pnpm@10.16.1"
}
```

`changeset-check.yml` doesn't install anything, so it has no
`package-manager` input.

### Workflows

#### `npm-pr-validation.yml`

PR-validation gate. Runs lint / format-check (both opt-in) / typecheck /
build / test from the repo root or a working directory.

```yaml
on:
  pull_request:
    branches: [develop]
jobs:
  validate:
    uses: mssfoobar/.github/.github/workflows/npm-pr-validation.yml@main
    with:
      node-version: '20'
      run-lint: true
      run-format-check: true
```

#### `changeset-check.yml`

Required check that enforces every PR carries a `.changeset/*.md` file (or
marker-less changeset for no-bump changes). Skips dependabot PRs and the
`changeset-release/*` branch automatically.

```yaml
on:
  pull_request:
    branches: [develop]
jobs:
  check:
    uses: mssfoobar/.github/.github/workflows/changeset-check.yml@main
```

#### `npm-snapshot-publish.yml`

Publishes a snapshot version on every push to develop or `*/rc`. Mutates
package.json transiently via `changeset version --snapshot=<tag>.<run_number>`,
then publishes only packages whose version actually changed. Versions look
like `0.1.0-alpha.123` (paired with `prereleaseTemplate: "{tag}"` in
`.changeset/config.json`).

```yaml
on:
  push:
    branches: [develop, '*/rc']
jobs:
  publish-alpha:
    if: github.ref == 'refs/heads/develop'
    uses: mssfoobar/.github/.github/workflows/npm-snapshot-publish.yml@main
    with:
      tag: alpha
      scope: '@mssfoobar'

  publish-rc:
    if: endsWith(github.ref, '/rc')
    uses: mssfoobar/.github/.github/workflows/npm-snapshot-publish.yml@main
    with:
      tag: rc
      scope: '@mssfoobar'
```

The consuming repo doesn't need to define a `release:<tag>` script — this
workflow runs `changeset version --snapshot=<tag>.<run_number>` itself,
detects which packages got bumped, and publishes them directly.

For a `pnpm` consumer, set `package-manager: pnpm` on each job. Pin the
pnpm version via `package.json#packageManager` in the consumer (see
[Package manager](#package-manager) above).

#### `npm-stable-publish.yml`

Publishes the stable release on push to main, after the rc → main PR has
merged with a real `changeset version` commit baked in. Uses
`changesets/action@v1` in publish mode — idempotent, only publishes
packages whose version isn't already on the registry, creates a GitHub
Release per published package.

```yaml
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: mssfoobar/.github/.github/workflows/npm-stable-publish.yml@main
    with:
      scope: '@mssfoobar'
```

The consuming repo must define `release:stable`. Use `changeset publish`
— **not** `npm publish --workspaces` or `pnpm publish -r`. `changesets/
action@v1` parses the publish command's stdout to detect what got
published and create matching GitHub Releases; only `changeset publish`'s
output format is recognised. The other commands publish successfully but
silently produce no Releases.

```json
{
  "scripts": {
    "release:stable": "changeset publish"
  }
}
```

`changeset publish` works for both npm and pnpm consumers — it calls
`npm publish` per workspace internally. Crucially, `changeset version`
(run on the rc branch before opening the rc → main PR) normalises any
`workspace:*` / `workspace:^` dep ranges to concrete versions, so
`changeset publish` doesn't need pnpm's runtime rewriting.

### Required `.changeset/config.json` block

```json
{
  "snapshot": {
    "useCalculatedVersion": true,
    "prereleaseTemplate": "{tag}"
  }
}
```

`useCalculatedVersion: true` makes the snapshot reflect the natural
next-version trajectory (`0.1.0-alpha.123` rather than `0.0.0-alpha.123`).
`prereleaseTemplate: "{tag}"` is a passthrough — the snapshot id from the
CLI becomes the entire prerelease portion.

### Branch protection — required checks

On the integration branch (typically `develop`):
- `validate` (from `npm-pr-validation.yml`)
- `check` (from `changeset-check.yml`)

On main:
- `validate` only (`check` only fires on PRs into develop).

No bypass actors needed — nothing CI-driven pushes to a protected branch.

### When to use the eager pattern instead

`npm-changeset-release.yml` and `monorepo-changeset-release.yml` (also in
this repo) use the older **eager-bump** pattern: every push to the watched
branch consumes pending changesets and commits a version bump back to the
branch. They require a GitHub App with branch-protection bypass to push
through ruleset gating. Use them when:

- You want each commit on develop tied to a specific deterministic version
  (rather than internal testers tracking `@alpha`).
- The team prefers the eager-bump audit trail over the lazy ceremony.

The lazy + snapshot pattern is the recommended default for new npm
projects. See [aa-cli's git history](https://github.com/mssfoobar/aa-cli/pulls?q=AOH-7029)
for the journey of trade-offs that led to it.

## Troubleshooting

Common issues and solutions:

-   **Authentication Errors**: Ensure your GitHub App has the correct permissions and is installed on the target
    repositories
-   **Manifest Not Found**: Verify the path to your manifest file is correct
-   **Build Failures**: Check your Dockerfile and build context are properly configured
-   **Deployment Not Triggered**: Verify the branch conditions match your intended workflow
