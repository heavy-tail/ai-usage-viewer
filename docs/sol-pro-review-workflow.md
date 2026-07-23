# Sol Pro Review Workflow

Use this process when a project needs a second, high-depth review in the
ChatGPT website:

1. Push the work to a draft pull request and record its full 40-character commit
   SHA.
2. In a separate Sol Pro chat with the GitHub connector enabled, first ask it to
   open one harmless file at that exact SHA. If it cannot, wait for repository
   indexing rather than reviewing pasted or stale code.
3. Ask for a security/correctness review of the exact SHA and draft PR. Let the
   model finish its GitHub tool calls before treating its prose as the result.
4. Treat findings as hypotheses. Codex verifies each one against the source,
   reproduces it where practical, and rejects findings that do not match the
   code.
5. Fix the substantiated blockers together, add regression tests, run the full
   local verification suite, and push one intentional follow-up commit.
6. Wait for required GitHub checks, then request one bounded re-review of the new
   exact SHA focused on the prior blockers and regressions.
7. Merge only when required CI is green and the remaining review findings are
   either fixed or explicitly documented and accepted.

The website review and a whole-project review may run in parallel in separate
chats. Keep their scopes distinct, always name the exact commit, and avoid an
unbounded “review, fix, repeat” loop. CI remains the deterministic gate; Sol Pro
adds adversarial judgment.
