# Publishing a repository to the Context Library

A repository publishes its content to the Context Library. The Library never reads GitHub, so no
GitHub credential is stored anywhere in the deployment.

Only what changed is transferred. Each publication sends a manifest of every file and its hash; the
server replies with the subset it lacks, the repository uploads just those, and a final commit applies
everything at once.

## One-time setup (deployment admin)

1. Open the Context Library UI, choose **New collection**, and pick source **CI push**.
2. Set visibility to **Public** so the collection is global.
3. Write a description saying *when to consult this collection*, not what it contains — an agent
   chooses collections by their description. "How Billing services are deployed, on-call runbooks, and
   payment-provider integration decisions" beats "Billing wiki".
4. Open **Manage ingestion tokens**, create a token, and copy the endpoint URL and token. The token is
   shown once and is valid for one year.

## One-time setup (repository)

Add two repository secrets:

- `CONTEXT_INGEST_URL` — the endpoint URL
- `CONTEXT_INGEST_TOKEN` — the token

Copy `publish-context.mjs` into the repository as `scripts/publish-context.mjs`, adjusting the
`INCLUDE` pattern to match what should become knowledge. Then add
`.github/workflows/publish-context.yml`:

```yaml
name: Publish to Context Library
on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Publish
        env:
          CONTEXT_INGEST_URL: ${{ secrets.CONTEXT_INGEST_URL }}
          CONTEXT_INGEST_TOKEN: ${{ secrets.CONTEXT_INGEST_TOKEN }}
          COMMIT_SHA: ${{ github.sha }}
        run: node scripts/publish-context.mjs
```

There is deliberately no `workflow_dispatch` trigger. A manual run publishes whatever ref it is
pointed at, which would quietly defeat the property that only reviewed content becomes agent
knowledge. To re-publish, re-run the job for a merged commit.

## What to expect

- The job logs how many documents it sent, how many were unchanged, and how many were deleted. A
  typical merge sends one or two files regardless of how large the repository is.
- Re-running for a commit that was already published prints "Already published" and stops.
- Deletions work automatically: a file removed from the repository is absent from the manifest, so
  the commit deletes it.
- A publication matching nothing in the include list is **refused**, both locally and by the server,
  because a manifest with no entries means "delete everything".
- Agents see new content immediately; there is no polling delay.
- A `SKILL.md` file becomes an agent skill and a slash command.

## Give your pages a description

A document's description is what an agent reads to decide whether the page is worth opening, and it
is extracted **only** from YAML frontmatter — prose is never summarised. A page without frontmatter
is published with an empty description and is correspondingly harder for an agent to find.

Start each page with:

```markdown
---
description: When and why to read this page.
---
```

## Limits

| Limit | Value | On exceeding |
|---|---|---|
| Single request | 5 MB | Rejected; the publisher batches below this automatically. |
| Files per publication | 5,000 | The publication is rejected. |
| Single document | 1.4 MB | The document is rejected by name; exclude it or split it. |

## Before you onboard a repository

Everything published becomes readable by **every** agent user in the deployment. Review the repository
for pasted credentials and unpublished drafts first. A leaked ingestion token lets someone replace the
collection's content wholesale, and agents read the result — revoke it in the UI if that is ever a
concern.
