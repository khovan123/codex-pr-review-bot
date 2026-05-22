# Codex PR Review Bot

BYOK GitHub Action that posts Codex-style pull request reviews. Each GitHub user or organization supplies their own `OPENAI_API_KEY`; this action does not use the publisher's key.

## Usage

Add a repository or organization secret named `OPENAI_API_KEY`.

Create `.github/workflows/codex-review.yml` in the repository that wants reviews:

```yaml
name: Codex PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - uses: khovan123/codex-pr-review-bot@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ github.token }}
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `openai_api_key` | Yes |  | User-owned OpenAI API key, usually `${{ secrets.OPENAI_API_KEY }}`. |
| `github_token` | Yes |  | Token used to read PR files and post the review, usually `${{ github.token }}`. |
| `model` | No | `gpt-5` | OpenAI model used for the review. |
| `max_files` | No | `40` | Maximum changed files sent to the model. |
| `max_patch_chars` | No | `60000` | Maximum patch characters sent to the model. |

## Security Model

- The action requires the repository user to provide `OPENAI_API_KEY`.
- The publisher does not receive or store user keys.
- Pull request patch text is sent to OpenAI from the user's GitHub Actions run.
- Use GitHub organization secrets if many repositories should share the same key.

## Publishing

1. Create a public GitHub repository, for example `khovan123/codex-pr-review-bot`.
2. Push this project to the repository.
3. Create a release tag such as `v1`.
4. Users can then reference the action with `uses: khovan123/codex-pr-review-bot@v1`.

The action is public once the GitHub repository is public. GitHub Marketplace listing is optional and can be added from the repository's Actions publishing settings.
