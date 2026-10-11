# Agent instructions for this repository

This is **Redact Restore**, a TypeScript-only Claude Code Mod for reversible privacy redaction. Read `README.md` (overview), `docs/CONFIGURATION.md` (options), `docs/DETECTORS.md` (detection) and `docs/SECURITY.md` (threat model, coverage, open issues) before changing anything.

## Non-negotiables

- Keep existing official Claude Code subscription OAuth login and any already-running sessions unaffected. Do not use gateways or modify `ANTHROPIC_BASE_URL`.
- TS only (`hooks/*.ts`); use installed-version generated Mod declarations and `claude plugin validate` to check API accuracy. No JS implementation.
- Do not pass `$` into helpers imported from other files. Keep Claude Code API calls in `register.ts` and local top-level helpers there. Pure detectors live in `matcher.ts`/`privacy.ts`.
- Protect raw custom values. Configure via `userConfig` (`multiple: true`, `sensitive: true`) and use synthetic test fixtures. Never log or commit sensitive values.
- Threat model: only the model API must not see private values. Restore in the local UI and in local tool inputs (policy in `hooks/policy.ts`); never restore for tools that forward input to a model or another session (`keep_tools`).
- Failure should block sensitive file writes rather than silently write placeholders. Document gaps clearly; this is not production DLP.
- Develop with an independent `claude --plugin-dir .` session; do not force a plugin reload in any other session.

## Validation

1. `claude plugin validate .claude-plugin/plugin.json` (`validate .` checks only the marketplace manifest)
2. `bun run check` (strict `tsc` for the mod and for the Bun tooling; run `bun install` once) (needs `.claude-plugin/types/`, written when an interactive `claude --plugin-dir .` session first loads the folder)
3. `claude plugin test .` (`tests/unit` and `tests/integration`, using `claude-code/testing`)
4. Before every commit, check that no personal data (real names, emails, home paths, machine names) entered tracked files; use synthetic values only

Live steps for CLI and Desktop Code are in `docs/TEST_PLAN.md`. If a command cannot run in your environment, record that honestly and continue with the rest. Read `docs/SECURITY.md` before widening any automatic restoration.

## Platform requirement

Feature parity must be validated on Claude Code CLI **and** the local Code tab of Claude Desktop App. Check versions independently; rendering on Desktop Code cannot be inferred from CLI alone. Do not assume `--plugin-dir` in the CLI loads an uninstalled plugin into an unrelated Desktop session. See `docs/COMPATIBILITY.md` and `docs/TEST_PLAN.md`.
