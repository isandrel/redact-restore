---
name: redact-restore-release
description: Prepare a Redact Restore version - bump the version, update CHANGELOG and docs to match tested behavior, verify, scan for personal data, and commit on main. Use when asked to release, bump the version, cut a version, or "wrap up" a set of changes in this repository.
---

# Release Redact Restore

1. **Version.** Bump `version` in `.claude-plugin/plugin.json` (semver: options or behavior change → minor; fixes → patch). Keep the status line in `docs/SECURITY.md` in step, and `README.md`'s Status section accurate.
2. **CHANGELOG.** New top section `## <version> - <YYYY-MM-DD>` (today's date from the system). State behavior changes, removed or renamed options with their replacement, and what was verified (unit, integration, live CLI, Desktop).
3. **Docs match reality.**
   - `docs/COMPATIBILITY.md`: CLI and Desktop columns separately; "Confirmed" only for live-tested rows.
   - `docs/SECURITY.md`: coverage table, findings (fixed / open / accepted), release gates.
   - Never claim protection for an untested path.
4. **Verify.** Run the `redact-restore-verify` skill (validate, tsc, tests, personal-data check). All must pass.
5. **Commit.** Conventional Commits with a gitmoji prefix (`✨ feat: …`, `🐛 fix: …`, `🔖 chore(release): …`), staged files reviewed (`git status`, `git diff --cached`). Messages and docs use synthetic values only.
6. **Branches.** Work on a feature branch; when done, fast-forward `main` and delete the merged branch only if the user asked to keep `main` alone. No push unless the user asks.
7. **Tags and GitHub Releases only on request.** Pushing a `v*` tag publishes a GitHub Release (`.github/workflows/release.yml`). Never create or push a tag, even when "release" is on a task list: prepare everything, run CI on `main`, then give the user the exact command and wait for them to ask:

   ```bash
   git tag -a v<version> -m "Redact Restore v<version>" && git push origin v<version>
   ```
8. **Before publishing anywhere** (a GitHub repository, a marketplace): commit author emails are personal data. Suggest a repository-local `git config user.email` with a no-reply address, and get the user's decision before rewriting any history.
