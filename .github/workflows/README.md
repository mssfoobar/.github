# Reusable GitHub Workflows for CI/CD

This repository contains reusable GitHub Actions workflows designed to streamline the process of building, publishing, and deploying containerized applications across your organization.

## Workflows Overview

This repository contains two main reusable workflows:

1.  **Docker Build and Push** (`.github/workflows/docker-build-push.yml`): A consolidated workflow that builds and publishes container images for various application types.
2.  **Update Deployment Manifest** (`.github/workflows/update-deployment.yml`): Updates deployment manifests in a separate repository with new image tags.

## Prerequisites

Before using these workflows, ensure you have:

-   **GitHub Repository**: A source code repository to build from.
-   **Dockerfile**: A properly configured Dockerfile in your repository.

---

For @mssfoobar, we've already configured the following, other organizations will need to set these up as well:

-   **GitHub Container Registry**: Access to ghcr.io or another container registry.
-   **Deployment Repository**: A separate repository containing your deployment manifests.
-   **GitHub App**: A GitHub App with appropriate permissions for updating the deployment repository.
    -   `DEPLOYMENT_APP_ID`: The ID of your GitHub App used for authentication.
    -   `DEPLOYMENT_APP_PRIVATE_KEY`: The private key of your GitHub App used for authentication.

## Setup Instructions

1.  Create a new file in your repository at `.github/workflows/build-deploy.yml`.
2.  Copy an example from the `workflow-templates` directory as a starting point (e.g., `dev-build-service.yml`).
3.  Customize the inputs and triggers as needed.

## Workflow Details

### Docker Build and Push Workflow

**File**: `.github/workflows/docker-build-push.yml`

This workflow builds a Docker image, pushes it to a container registry, and applies appropriate tags based on the Git reference. It supports different build types for language-specific logic.

#### Inputs

| Name            | Description                                                                 | Required | Default        |
| --------------- | --------------------------------------------------------------------------- | -------- | -------------- |
| `build_type`    | Build type for language-specific logic (`java`, `go`, `web`, `web-secure`). | No       | `web`          |
| `image_prefix`  | Container registry prefix (e.g., `ghcr.io`).                                | Yes      | -              |
| `org_name`      | Organization name (e.g., `mssfoobar`).                                      | Yes      | -              |
| `app_name`      | Application name (e.g., `gis/gis-app`).                                     | Yes      | -              |
| `build_context` | Directory containing the Dockerfile (e.g., `app`).                          | Yes      | -              |
| `build_file`    | Path to the Dockerfile.                                                     | No       | `./Dockerfile` |
| `build_args`    | Extra build arguments to pass to the `docker build` command.                | No       | -              |

#### Secrets

| Name              | Description                                        | Required (if `build_type` is `go`) |
| ----------------- | -------------------------------------------------- | ---------------------------------- |
| `APP_ID`          | GitHub App ID for downloading private Go modules.  | Yes                                |
| `APP_PRIVATE_KEY` | GitHub App Private Key for downloading Go modules. | Yes                                |

#### Outputs

| Name        | Description                                  |
| ----------- | -------------------------------------------- |
| `image_tag` | The full image tag that was built and pushed. |

### Update Deployment Manifest Workflow

**File**: `.github/workflows/update-deployment.yml`

This workflow updates a deployment manifest file in a separate repository with a new image tag.

#### Inputs

| Name              | Description                                          | Required | Default |
| ----------------- | ---------------------------------------------------- | -------- | ------- |
| `org_name`        | GitHub organization name (e.g. `mssfoobar`).         | Yes      | -       |
| `manifest_repo`   | Repository containing the deployment manifests.      | Yes      | -       |
| `manifest_branch` | Branch in the manifest repository to update.         | Yes      | -       |
| `manifest_path`   | Path to the manifest file within the repository.     | Yes      | -       |
| `new_image_tag`   | New image tag to be updated in the manifest.         | Yes      | -       |

#### Secrets

| Name                         | Description                           | Required |
| ---------------------------- | ------------------------------------- | -------- |
| `DEPLOYMENT_APP_ID`          | GitHub App ID for deployment.         | Yes      |
| `DEPLOYMENT_APP_PRIVATE_KEY` | GitHub App Private Key for deployment.| Yes      |

## Example Usage

You can find examples in the `workflow-templates` folder.

### Matrix Build Example

Below is an example of how to use a matrix strategy for a repository containing multiple services. This example uses `vars` for repository-level configuration.

```yaml
name: Multi-Service Build and Deploy

on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  matrix-prep:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.set-matrix.outputs.services }}
    steps:
      - id: set-matrix
        run: |
          echo "services=[
            {
              \"id\": \"api\",
              \"name\": \"my-app/api\",
              \"type\": \"java\",
              \"context\": \"./services/java-api\",
              \"manifest_path\": \"deployments/api/deployment.yaml\"
            },
            {
              \"id\": \"frontend\",
              \"name\": \"my-app/frontend\",
              \"type\": \"web\",
              \"context\": \"./services/nodejs-frontend\",
              \"manifest_path\": \"deployments/frontend/deployment.yaml\"
            }
          ]" >> $GITHUB_OUTPUT

  build-images:
    needs: matrix-prep
    strategy:
      matrix:
        service: ${{ fromJSON(needs.matrix-prep.outputs.services) }}
      fail-fast: false
    name: Build ${{ matrix.service.name }}
    uses: ./.github/workflows/docker-build-push.yml
    with:
      image_prefix: ${{ vars.IMAGE_PREFIX }}
      org_name: ${{ vars.ORG_NAME }}
      app_name: ${{ matrix.service.name }}
      build_type: ${{ matrix.service.type }}
      build_context: ${{ matrix.service.context }}
    # Secrets are only passed if needed by the build type (e.g., 'go')
    secrets: inherit

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
      org_name: ${{ vars.ORG_NAME }}
      manifest_repo: ${{ vars.MANIFEST_REPO }}
      manifest_branch: ${{ vars.MANIFEST_BRANCH }}
      manifest_path: ${{ matrix.service.manifest_path }}
      new_image_tag: ${{ needs.build-images.outputs[format('{0}_image_tag', matrix.service.id)] }}
    secrets:
      DEPLOYMENT_APP_ID: ${{ vars.DEPLOYMENT_APP_ID }}
      DEPLOYMENT_APP_PRIVATE_KEY: ${{ secrets.DEPLOYMENT_APP_PRIVATE_KEY }}
```

## Troubleshooting

-   **Authentication Errors**: Ensure your GitHub App has the correct permissions and is installed on the target repositories.
-   **Manifest Not Found**: Verify the path to your manifest file is correct.
-   **Build Failures**: Check your Dockerfile and build context are properly configured.
-   **Deployment Not Triggered**: Verify the branch conditions match your intended workflow.
