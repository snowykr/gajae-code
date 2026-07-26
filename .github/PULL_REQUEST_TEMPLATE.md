## What

<!-- Brief description of the change -->

## Why

<!-- Motivation, context, or link to issue (fixes #N) -->

## Testing

<!-- How was this tested? -->

## Visual QA owner gate

- Descriptor Actions artifact archive URL (not a direct JSON URL) / immutable descriptor artifact ID / name / digest:
- Sanitized capture Actions artifact URL / immutable artifact ID / name:
- Uploaded artifact SHA-256 / byte length / retention:
- Workflow run ID / attempt / URL:
- Repository / PR number / PR node ID:
- Head repository / immutable ID:
- Base repository / immutable ID:
- Exact PR head SHA:
- Exact PR base SHA:
- Manifest SHA-256 / entry count:
- Descriptor artifact provenance (`descriptor_artifact_provenance`):
- Authenticated review state (`APPROVED`) / API commit binding:
- Coverage (states, profiles, viewports, CJK/terminal semantics):
- Limits / non-claims (raw PTY and whole `.gjc` are not published):

Canonical independent review receipt (immutable review ID; separate from the capture artifact):

- Review URL:
- Immutable review ID:
- Review node ID:
- Authenticated reviewer ID / node ID:
- Authenticated review commit SHA:
- Authenticated review state (`APPROVED`) / CJK inspection / scope:
- Reviewed keys / count:
- Verifier result and evidence URL:

<!-- The descriptor is safe, reviewable metadata published after the immutable sanitized artifact. The
capture artifact MUST NOT contain independent-review.json, a review body, or any review receipt. A separate
GitHub identity must submit one approved review. The verifier fetches that review by immutable ID and
requires its authenticated commit SHA to equal the descriptor and final PR head SHA; self-attestation is
BLOCKED. -->
<!-- Descriptor and capture artifact names include the workflow run ID and attempt and are never replaced.
Use the HTTPS run-scoped artifact URL (not a mutable name/latest lookup), verify the descriptor's immutable
artifact_id and workflow_run_id against the Actions API, and reject substitution, expiration, or replacement. -->
<!-- The descriptor is a separate GitHub Actions artifact archive containing visual-qa-descriptor.json;
its canonical locator is the run-scoped Actions URL plus immutable artifact ID above, not a direct JSON URL.
The repository-bound verifier must reject off-origin locators before any request, then resolve metadata and
download/extract through the repository's authenticated Actions API. -->
Exact verifier invocation (the descriptor argument is a canonical run-scoped Actions artifact URL or
repository-qualified immutable artifact ID; local paths, inline objects, and direct JSON URLs are rejected):

```sh
GITHUB_TOKEN="$READ_ONLY_GITHUB_TOKEN" \
bun packages/coding-agent/scripts/verify-pet-renderer-visual-publication.ts \
  --repository <owner/name> \
  --pr <number> \
  --descriptor <descriptor-actions-artifact-url-or-repository-qualified-id> \
  --review-id <immutable-review-id>
```
## GJC verdict

<!-- Paste one exact-head verdict. Self-approval is BLOCK. If there was no independent architect/critic/human review, write needs-human and stop. -->

```text
gajae.pr-review-verdict.v1 <merge-approved|merge-blocked|needs-human> sha256:<exact-head-or-diff-hash> reviewer:<architect|critic|human> evidence:<ci-run-url-or-local-command>
```

---

- [ ] Target branch is `dev`
- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated (if user-facing)
- [ ] Verdict above matches the exact PR head, not an earlier commit
