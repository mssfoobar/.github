# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is the `.github` repository for the AGIL Ops Hub organization. It contains reusable GitHub Actions workflows that standardize CI/CD processes across all AGIL Ops Hub repositories.

AGIL Ops Hub is a comprehensive development platform for command and control systems built on a microservice architecture. This repository provides the infrastructure automation that supports building, testing, and deploying those microservices.

## Repository Structure

```
.github/
└── workflows/           # Reusable workflow definitions
    ├── java-docker-build-push.yml
    ├── web-docker-build-push.yml
    ├── golang-docker-build-push.yml
    ├── npm-build-publish.yml
    ├── modlet-build-publish.yml
    ├── update-deployment.yml
    ├── sonarqube-scan.yml
    ├── golang-sonarqube-scan.yml
    ├── claude.yml
    ├── claude-code-review.yml
    └── pr-claude-review.yml

workflow-templates/      # Template workflows for new repositories
    ├── dev-build-service.yml
    ├── dev-build-web.yml
    └── sonarqube-scan-web.yml

profile/
└── README.md           # Organization profile page
```

## Architecture Overview

### Workflow Categories

**Build & Publish Workflows**: Container image building workflows for different technology stacks
- `java-docker-build-push.yml`: Java/Maven microservices
- `web-docker-build-push.yml`: Web frontend applications (Node.js)
- `golang-docker-build-push.yml`: Go microservices
- `npm-build-publish.yml`: NPM packages
- `modlet-build-publish.yml`: AGIL Ops Hub modlets (pluggable UI components)

**Deployment Workflows**:
- `update-deployment.yml`: Updates Kubernetes manifests or Helm values in the deployment repository

**Quality Assurance Workflows**:
- `sonarqube-scan.yml`: Generic SonarQube static analysis
- `golang-sonarqube-scan.yml`: Go-specific SonarQube scan with coverage generation (default Go version: 1.25.3)

**AI-Assisted Development Workflows**:
- `claude.yml`: Allows mentioning @claude in PR comments, issues, and reviews to invoke Claude Code for assistance
- `claude-code-review.yml`: Reusable agentic PR review (find → verify → post one comment). Advisory only — never a required check, never a formal review
- `pr-claude-review.yml`: This repo's own caller for `claude-code-review.yml`

### Image Tagging Strategy

All Docker build workflows follow a consistent tagging strategy:

**For releases** (when triggered by git tag or release event):
- Primary tag: `{release-tag}` (e.g., `v1.2.3`)
- Additional tag: `latest`

**For development** (when triggered by branch push):
- Primary tag: `{branch-name}-{short-git-hash}` (e.g., `develop-abc1234`)
- Additional tag: `latest-dev`

### Authentication Requirements

**Go workflows** require GitHub App credentials to access private Go modules:
- `APP_ID`: GitHub App ID
- `APP_PRIVATE_KEY`: GitHub App private key

**Deployment workflows** require GitHub App credentials to update deployment repositories:
- `DEPLOYMENT_APP_ID`: GitHub App ID for deployment operations
- `DEPLOYMENT_APP_PRIVATE_KEY`: GitHub App private key for deployment operations

**SonarQube workflows** require:
- `SONAR_SECRET`: SonarQube authentication token
- `SONAR_HOST_URL`: SonarQube server URL

### Deployment Manifest Updates

The `update-deployment.yml` workflow supports two deployment strategies:

**Direct push**: When no `team_slug_for_pr` is provided, changes are committed directly to the manifest branch.

**Pull request**: When `team_slug_for_pr` is provided, creates a PR requesting team review before deployment.

**Two manifest formats**:
1. Traditional Kubernetes manifests: Updates `image:` lines directly
2. Helm values: Updates structured fields like `{service}.image.repository` and `{service}.image.tag`

## Workflow Template Usage

When creating a new repository in the AGIL Ops Hub organization:

1. Copy appropriate template from `workflow-templates/` to `.github/workflows/` in the new repository
2. Replace placeholder values:
   - `<REPLACE_WITH_COMPONENT_NAME>`: Component name for release filtering
   - `mod/mod-app`: Actual application name
   - `mod-app`: Actual component identifier
   - `app`: Actual build context directory
3. Update paths in `on.push.paths` to match the repository structure
4. Configure required secrets and variables in repository settings

## Pull Request Conventions

When submitting PRs to this repository, reference Linear issues using the format:
- `AOH-<Issue-Number>` (automatically linked via configured autolinks)

## Key Workflows Reference

### java-docker-build-push.yml
Builds Java Maven projects, extracts version from POM, builds Docker image with `APP_VERSION` and `REVISION` build args.

### web-docker-build-push.yml
Builds web applications, passes `PUBLIC_STATIC_BUILD_VERSION`, `GITHUB_TOKEN`, and `REVISION` build args.

### golang-docker-build-push.yml
Builds Go applications, requires GitHub App token for private module access, passes `GITHUB_USERNAME`, `GITHUB_TOKEN`, and `REVISION` build args.

### update-deployment.yml
Updates deployment manifests in a separate repository. Supports both traditional K8s manifests and Helm values format. Can either push directly or create PR for team review.

### modlet-build-publish.yml
Specialized workflow for AGIL Ops Hub modlets - uses custom CLI tool to pack and publish modular UI components as NPM packages.

### claude.yml
Interactive Claude Code workflow that responds to @claude mentions in:
- Issue comments
- Pull request review comments
- Pull request reviews
- Issue titles and bodies

Requires `CLAUDE_CODE_OAUTH_TOKEN` secret to be configured in repository settings.

### claude-code-review.yml
**Reusable** (`on: workflow_call`) agentic PR review, consumed by other repos via
`uses: mssfoobar/.github/.github/workflows/claude-code-review.yml@<ref>`, passing
exactly `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` under `secrets:` — never
`secrets: inherit`, which hands it every secret the caller holds. This repo
consumes it through the thin `pr-claude-review.yml` caller.

The prompt asks Claude to find issues and then **adversarially verify each one
against the code before posting**, dropping anything it cannot confirm. That step
is the point: a single-pass reviewer posts its false positives too, and each one
costs a human the time to disprove it.

Reviews are posted as a single PR comment via `gh pr comment`. A failed or
timed-out review is reported by the `report-failure` job with the marker
`<!-- claude-code-review:failed -->` (a stable contract callers may count).
Inputs: `runner`, `model`, `max_turns` (80), `timeout_minutes` (40),
`review_instructions`, `allow_oauth_fallback`, `allowed_bots`, `report_failure`.

Two constraints that must not be quietly relaxed:
- It posts a **comment**, never a formal review, and must never be a required
  status check — so it can neither block a merge nor satisfy a required-approval
  rule. Green CI stays the merge bar.
- Callers should trigger on `opened` / `ready_for_review`, **not** plain
  `synchronize` — every run posts a NEW comment (`use_sticky_comment` is inert
  in agent mode), so a review per push produces near-duplicates. A
  `synchronize` gated to "review only if no review exists yet" is fine, and is
  how a caller covers a PR opened in conflict (which fires no `opened`).

Auth resolves `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → skip with a
warning. Anthropic blocks the OAuth path for **this** repo specifically, so
self-review here stays skipped until `ANTHROPIC_API_KEY` is provisioned at the
org level; consumer repos work today on the OAuth token.

### pr-claude-review.yml
This repo's own caller for `claude-code-review.yml`. Exists because converting
that workflow to `workflow_call` removed its ability to trigger on this repo's
own pull requests.
