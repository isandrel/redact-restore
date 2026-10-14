---
name: redact-restore-verify
description: Run Redact Restore's full local verification (manifest validation, strict type-check, unit and integration tests, personal-data check) and report results. Use before every commit, after any change under hooks/ or tests/, or when asked to "verify", "check", or "run the tests" in this repository.
---

# Verify Redact Restore

Run from the repository root. Report each step as passed or failed, with the shortest decisive output line; never claim a step passed that did not run.

## Steps

1. Manifest and hooks module. `validate .` only checks the marketplace file, so name the manifest:

   ```bash
   claude plugin validate .claude-plugin/plugin.json
   ```

   Expect the `hooks:` line to list every event `hooks/register.ts` registers. The `author` warning is known.

2. Strict type-check against the engine's generated declarations:

   ```bash
   bun install && bun run check
   ```

   If `.claude-plugin/types/` is missing, start one interactive `claude --plugin-dir .` session in a separate terminal so the engine writes it, then exit and retry.

3. Unit and integration tests (`tests/unit`, `tests/integration`):

   ```bash
   claude plugin test .
   ```

4. Personal data. Check the staged diff for real names, emails, home paths (`/Users/<name>/`), host names and tokens before committing; replace any with synthetic values (`alice@example.com`, `Project Phoenix`, `/path/to/...`). A maintainer may keep a local-only scanner in `.local/` (gitignored); run it when present. Everything tracked is published, including `skills/` and `.claude/skills/`: check them the same way.

## Rules

- Synthetic values only in code, tests, docs, commit messages and command lines.
- Never print a value the scan found; refer to it by file and line.
- Do not run end-to-end tests here; that is the `redact-restore-e2e` skill (it calls the model).
