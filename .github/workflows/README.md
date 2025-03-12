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

## Troubleshooting

Common issues and solutions:

-   **Authentication Errors**: Ensure your GitHub App has the correct permissions and is installed on the target
    repositories
-   **Manifest Not Found**: Verify the path to your manifest file is correct
-   **Build Failures**: Check your Dockerfile and build context are properly configured
-   **Deployment Not Triggered**: Verify the branch conditions match your intended workflow
