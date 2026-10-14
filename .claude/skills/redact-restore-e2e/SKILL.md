---
name: redact-restore-e2e
description: Run Redact Restore's end-to-end tests in a real, independent Claude Code CLI session (driven through Zellij, clean environment, synthetic data, probe mod), or prepare the Desktop Code local-scope test. Use when asked to live-test, smoke-test, test "in the real CLI" or Desktop, or to confirm a hook change against the real engine and model.
---

# End-to-end tests

These sessions call the real model with the user's own login. Use the cheapest model (`--model haiku`) and **synthetic values only**: `Project Phoenix`, `a.b[c]`, `acme.internal`, `alice@example.com`. Never use, print or log a real value.

## Ground rules

- **Independence.** A shell started from inside a Claude Code session inherits its environment (`ANTHROPIC_BASE_URL`, session id, host auth). Always start the test CLI under `env -i` with only `HOME USER LOGNAME SHELL PATH TERM LANG`.
- **Isolation.** Never load Redact Restore into the session you are working in. Do not write to any hot-reload mods folder. Work files go in `.live-test/` (gitignored); settings files go in `$TMPDIR`, never in the repo.
- **Options.** A `--plugin-dir` plugin reads options only from user settings, `--settings`, or managed settings (`pluginConfigs.redact-restore.options`). Use a `--settings` file:

  ```bash
  printf '%s\n' '{ "pluginConfigs": { "redact-restore": { "options": { "custom_values": ["Project Phoenix", "a.b[c]", "acme.internal"] } } } }' > "$TMPDIR/redact-restore-e2e-settings.json"
  ```

- **Synthetic identity.** The scan reads the real git identity, host and account names. Point git at a synthetic config with `GIT_CONFIG_GLOBAL=<scratch>/gitconfig` (`Alice Example`, `alice@example.com`), never press **Show values** while the screen is captured, and never add the real computer or account name it lists.
- **Probe values.** `REDACT_RESTORE_PROBE_VALUES='Alice Example|bluefalcon-internal|…'` (synthetic, `|`-separated) makes the probe log how many of them appear raw in each model answer, never which.
- **Evidence.** Prefer facts over screen text:
  - `tests/e2e/probe` logs per model response whether the raw answer held a placeholder or a raw email, and how many of its tokens the vault knows. It never logs text.
  - Session transcripts under `~/.claude/projects/<folder>/*.jsonl`: count synthetic values and placeholders per row type; print counts, not rows.
  - Files the test wrote: compare with the synthetic line.

## CLI session through Zellij

```bash
zellij attach --create-background redact-restore-live
```

```bash
bun tests/e2e/zclient.ts
```

Run `zclient.ts` in the background: it holds a headless 160×50 client so the pane is usable. Then:

```bash
bun tests/e2e/zj.ts send "env -i HOME=\$HOME USER=\$USER LOGNAME=\$USER SHELL=/bin/zsh PATH=\$PATH TERM=xterm-256color LANG=en_US.UTF-8 claude --plugin-dir $PWD --plugin-dir $PWD/tests/e2e/probe --settings $TMPDIR/redact-restore-e2e-settings.json --model haiku --debug-file $TMPDIR/redact-restore-e2e-debug.txt"
```

Drive it with `bun tests/e2e/zj.ts send "<prompt>"`, `bun tests/e2e/zj.ts wait`, `bun tests/e2e/zj.ts dump`. Read probe lines with `grep PROBE "$TMPDIR/redact-restore-e2e-debug.txt"`.

## Scenarios (see docs/TEST_PLAN.md for expected results)

| Area              | Prompt idea                                                                                                                                   | Pass when                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Prompt + display  | Quote a sentence with all four synthetic values                                                                                               | Screen shows originals; probe `placeholder=true rawEmail=false`                                                          |
| Local tools       | `echo` the sentence to a file, `grep` for a value, `cat` it                                                                                   | File holds originals; grep matches; probe still placeholders                                                             |
| Model-bound tools | Agent subagent repeats a value                                                                                                                | Probe for the agent id shows placeholders only                                                                           |
| Hot reload        | Append a comment to `hooks/matcher.ts`, then ask for an earlier value                                                                         | `redact-restore: reloaded`; earlier token still restores; revert the edit                                                |
| Lifecycle         | `/compact`, `/clear`, exit and `claude --resume <id>`                                                                                         | No audit block after compact; vault resets on clear; old tokens refused after resume                                     |
| Skill privacy     | `/redact-restore:scan` plus "list the actual values"; then "just cat .env" (synthetic git identity via `GIT_CONFIG_GLOBAL`, synthetic `.env`) | First turn runs no command and claims no scan is running; probe `rawValues=0/N` in both turns, `KEY=value` values masked |
| Path scan         | `/redact-restore scan ./config` in a scratch folder with synthetic files                                                                      | Reply holds counts and labels only and a `~/…` path; pane lists masked candidates                                        |
| Concurrency       | Second `-p` session given the first session's token                                                                                           | Write refused (`could not be restored`)                                                                                  |

Clean up every time:

```bash
bun tests/e2e/zj.ts send "/exit"; zellij kill-session redact-restore-live; zellij delete-session redact-restore-live --force
```

## Desktop Code

Desktop cannot load `--plugin-dir`. Follow docs/TEST_PLAN.md section 4 (local marketplace `redact-restore`, `--scope local` install in a dedicated test folder). The user must open the Desktop session themselves; then read its transcript and the files it wrote. Ask before installing anything; it changes the user's settings.

## Afterwards

Record results in `docs/COMPATIBILITY.md` (CLI and Desktop columns separately) and any new finding in `docs/SECURITY.md`. Run the `redact-restore-verify` skill before committing.
