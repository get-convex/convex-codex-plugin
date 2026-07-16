---
name: "quickstart-improve"
description: "Backward-compatible alias for improve-convex-plugin. Send THIS Codex session's transcript to the Convex quickstart backend for an AI post-mortem that improves the whole system. TRIGGER when the user runs $quickstart-improve (the former name of $improve-convex-plugin)."
license: "Apache-2.0"
---

# Send session for review ($quickstart-improve → $improve-convex-plugin)

`$quickstart-improve` was renamed to `$improve-convex-plugin`; this alias keeps the
old name working for existing users. The behavior is identical: ship the current
Codex session transcript to anteater's `/review` endpoint for an AI post-mortem that
returns concrete findings to improve the runbook / bootstrap / skills. Prefer
`$improve-convex-plugin` going forward.

Run it (QB_HARNESS=codex tells the helper to read the Codex transcript):
```bash
curl -fsSL "https://basic-anteater-667.convex.site/send-transcript" \
  | QB_HARNESS=codex bash -s -- --idea "<the user's note, or the app idea>"
```

Read the output exactly as in `improve-convex-plugin`:
- `REVIEW_DONE status=done` → summarize for the user: overall `outcome` + `summary`, then the top findings by `severity` (each: `title` → `target` → `suggestedFix`), then the `wins`. Keep it about the *system*, never paste back secrets (the helper already redacts).
- `REVIEW_PENDING` → submitted; the review is still running (the printed `/review/<id>` can be re-checked).
- `REVIEW_NO_TRANSCRIPT` / `REVIEW_TRANSCRIPT_TOO_SMALL` → no Codex transcript found; tell the user.
- `REVIEW_UPLOAD_FAILED` → the endpoint was unreachable (network/sandbox); report it.
