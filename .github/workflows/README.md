# Reusable GitHub Workflows for CI/CD

This repository contains reusable GitHub Actions workflows designed to streamline the process of building, publishing, and deploying containerized applications across your organization.

## Purpose

These reusable workflows provide:

- **Standardized CI/CD Pipelines**: Consistent build and deployment processes across projects
- **Reduced Configuration Duplication**: Centralize workflow logic to reduce maintenance burden
- **Self-Service Adoption**: Easy implementation for development teams
- **Separation of Concerns**: Decouple build and deployment processes
- **Flexibility**: Configurable to meet various application requirements

## Workflows Overview

This repository contains two main reusable workflows:

1. **Docker Build and Push** (`.github/workflows/docker-build-push.yml`): Handles building and publishing Docker images to a container registry.
2. **Update Deployment Manifest** (`.github/workflows/update-deployment.yml`): Updates deployment manifests in a separate repository with new image tags.

## Prerequisites

Before using these workflows, ensure you have:

- **GitHub Repository**: A source code repository to build from
- **Dockerfile**: A properly configured Dockerfile in your repository
- **GitHub Container Registry**: Access to ghcr.io or another container registry
- **Deployment Repository**: A separate repository containing your deployment manifests
- **GitHub App**: A GitHub App with appropriate permissions for updating the deployment repository

## Required Secrets

### For Docker Build and Push:
- `GITHUB_TOKEN`: Automatically provided by GitHub, used for authentication with GitHub Container Registry

### For Deployment:
- `DEPLOYMENT_APP_ID`: The ID of your GitHub App used for authentication
- `DEPLOYMENT_APP_PRIVATE_KEY`: The private key of your GitHub App used for authentication

## Setup Instructions

### 1. Set up GitHub App for Deployment (if not already done)

1. Create a GitHub App in your organization with the following permissions:
   - Repository contents: Read & write
   - Pull requests: Read & write
2. Generate a private key for the app
3. Install the app on your organization or specific repositories
4. Note the App ID and save the private key for later use

### 2. Configure Secrets

1. Navigate to your repository settings
2. Go to "Secrets and variables" → "Actions"
3. Add the following repository secrets:
   - `DEPLOYMENT_APP_ID`: Your GitHub App ID
   - `DEPLOYMENT_APP_PRIVATE_KEY`: Your GitHub App private key (including BEGIN and END lines)

### 3. Create Your Workflow File

1. Create a new file in your repository at `.github/workflows/build-deploy.yml`
2. Copy the example workflow (`example-build-deploy.yml`) as a starting point
3. Customize the environment variables and triggers as needed

## Workflow Details

### Docker Build and Push Workflow

**File**: `.github/workflows/docker-build-push.yml`

#### Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `image_prefix` | Container registry prefix (e.g., ghcr.io) | Yes | - |
| `org_name` | Organization name | Yes | - |
| `app_name` | Application name | Yes | - |
| `build_context` | Directory containing the Dockerfile | Yes | - |

#### Secrets

| Name | Description | Required |
|------|-------------|----------|
| `GITHUB_TOKEN` | GitHub token for authentication | Yes |

#### Outputs

| Name | Description |
|------|-------------|
| `image_tag` | The full image tag that was built and pushed |

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

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `org_name` | GitHub organization name | Yes | - |
| `manifest_repo` | Repository containing the deployment manifests | Yes | - |
| `manifest_branch` | Branch in the manifest repository to update | Yes | - |
| `manifest_path` | Path to the manifest file within the repository | Yes | - |
| `new_image_tag` | New image tag to be updated in the manifest | Yes | - |

#### Secrets

| Name | Description | Required |
|------|-------------|----------|
| `DEPLOYMENT_APP_ID` | GitHub App ID for deployment | Yes |
| `DEPLOYMENT_APP_PRIVATE_KEY` | GitHub App Private Key for deployment | Yes |

#### Behavior

This workflow:
1. Generates a GitHub App token for authentication
2. Checks out the manifest repository
3. Updates the image tag in the manifest file
4. Commits and pushes the changes back to the manifest repository

## Example Usage

Below is an example of how to implement these reusable workflows in your project:

```yaml
name: Build and Deploy

on:
  push:
    branches: 
      - main
      - dev
  pull_request:
    branches:
      - main
  workflow_dispatch:

env:
  ORG_NAME: your-org-name
  APP_NAME: your-app-name
  IMAGE_PREFIX: ghcr.io
  BUILD_CONTEXT: .
  MANIFEST_REPO: your-org/manifests
  MANIFEST_BRANCH: main
  MANIFEST_PATH: deployments/your-app/deployment.yaml

jobs:
  build-image:
    name: Build and Push Docker Image
    uses: ./.github/workflows/docker-build-push.yml
    with:
      image_prefix: ${{ env.IMAGE_PREFIX }}
      org_name: ${{ env.ORG_NAME }}
      app_name: ${{ env.APP_NAME }}
      build_context: ${{ env.BUILD_CONTEXT }}
    secrets:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  
  update-deployment:
    name: Update Deployment Manifests
    needs: build-image
    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'
    uses: ./.github/workflows/update-deployment.yml
    with:
      org_name: ${{ env.ORG_NAME }}
      manifest_repo: ${{ env.MANIFEST_REPO }}
      manifest_branch: ${{ env.MANIFEST_BRANCH }}
      manifest_path: ${{ env.MANIFEST_PATH }}
      new_image_tag: ${{ needs.build-image.outputs.image_tag }}
    secrets:
      DEPLOYMENT_APP_ID: ${{ secrets.DEPLOYMENT_APP_ID }}
      DEPLOYMENT_APP_PRIVATE_KEY: ${{ secrets.DEPLOYMENT_APP_PRIVATE_KEY }}
```

## Customization Tips

1. **Multiple Environments**: Create separate workflow files for different environments (dev, staging, prod)
2. **Additional Build Steps**: Extend the Docker build workflow with additional steps such as testing or security scanning
3. **Conditional Deployments**: Add conditions to control when deployments occur
4. **Advanced Manifest Updates**: Customize the deployment workflow to update multiple files or apply more complex changes

## Troubleshooting

Common issues and solutions:

- **Authentication Errors**: Ensure your GitHub App has the correct permissions and is installed on the target repositories
- **Manifest Not Found**: Verify the path to your manifest file is correct
- **Build Failures**: Check your Dockerfile and build context are properly configured
- **Deployment Not Triggered**: Verify the branch conditions match your intended workflow

