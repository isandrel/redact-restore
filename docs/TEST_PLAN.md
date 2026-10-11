# Test plan

Use **synthetic values only**: `Project Phoenix`, `a.b[c]`, `acme.internal`, `alice@example.com`. Never test with real credentials.

## 1. Static and automated (no model calls)

Run from the repository root:

```bash
claude plugin validate .claude-plugin/plugin.json
```

```bash
bun install && bun run check
```

```bash
claude plugin test .
```

- `tsc -p .` extends `.claude-plugin/types/tsconfig.json`, which the engine writes the first time an interactive session loads the folder (`claude --plugin-dir .`). Strict mode and `noUncheckedIndexedAccess` are on.
- `claude plugin test` runs every `*.test.ts` with the `claude-code/testing` kit:

  | Folder               | Kind                                                   | What it covers                                                                                     |
  | -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
  | `tests/unit/`        | Unit (pure functions, no engine)                       | Matcher, email scanner, tokenizer, block masking, audit, config, restore policy, tool-input walker |
  | `tests/integration/` | Integration (hooks through the engine's real dispatch) | Every hook, including `ui.render` on the `terminal` and `desktop` surfaces                         |
  | `tests/e2e/`         | End-to-end (real CLI, real model, synthetic data)      | Zellij driver and the `probe` test-only mod; run by hand (section 3b)                              |
- Kit notes for 2.1.287: register the test's own hooks before the first call on `$`. `$.state` is not on the test engine. A `$`-call event such as `session.messages` or `ui.status` is answered with `{ value }`. `session.append` has no row store underneath.

## 2. CLI headless (`-p`)

Options for a `--plugin-dir` plugin come from `pluginConfigs` in user settings, a `--settings` file, or managed settings. Project settings are not read. Use a scratch settings file outside the repo:

```json
{ "pluginConfigs": { "redact-restore": { "options": {
  "custom_values": ["Project Phoenix", "a.b[c]", "acme.internal"],
  "restore_mode": "all"
} } } }
```

```bash
claude -p --plugin-dir . --settings /path/to/redact-restore-test-settings.json --model haiku "Please quote this sentence back exactly: Contact alice@example.com about Project Phoenix at acme.internal and a.b[c]."
```

`-p` has no UI restoration, so the answer shows exactly what the model received: four `{{PRIVATE:…}}` placeholders.

The Write/Bash round trip (run in an empty scratch folder with `--allowedTools "Write" "Bash(echo:*)" "Bash(cat:*)"`):

1. Write `notes.txt` with the synthetic line: the file on disk must contain originals.
2. `echo` the same line into `bash.txt`: with the default `restore_mode` (`all`) the file must contain originals; with `files` it must contain placeholders.
3. `grep` for a masked value must find the line (the pattern is restored).
4. `cat notes.txt`: the model's reply must show placeholders.
5. Repeat with `restore_mode` set to `none`: Write must be denied ("restoration is off for it").
6. Ask for an `Agent` subagent that repeats a masked value: the subagent must receive placeholders (`tests/e2e/probe` shows `placeholder=true rawEmail=false` for its agent id).

## 3. CLI interactive

```bash
claude --plugin-dir . --settings /path/to/redact-restore-test-settings.json --model haiku "Repeat back verbatim: Ask alice@example.com about Project Phoenix at acme.internal."
```

- The prompt row and the reply show originals; the status row shows `redact-restore: N private values masked`.
- In `~/.claude/projects/<folder>/<session>.jsonl`, user and assistant rows hold placeholders only.
- Hot reload: edit a file under `hooks/`; only this session reloads, and earlier placeholders still restore (the vault lives in `$.state`).

## 3b. CLI interactive, scripted (Zellij)

Run every live CLI test in a **clean environment**. A shell started from inside a Claude Code session (this includes a Desktop session's tool calls) inherits `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_SESSION_ID` and host-auth variables, so the test session would not be an independent CLI.

```bash
zellij attach --create-background redact-restore-live
```

```bash
bun tests/e2e/zclient.ts &
```

`zclient.ts` holds a headless 160×50 client so the pane has a usable size. Then drive the TUI:

```bash
bun tests/e2e/zj.ts send "env -i HOME=\$HOME USER=\$USER LOGNAME=\$USER SHELL=/bin/zsh PATH=\$PATH TERM=xterm-256color LANG=en_US.UTF-8 claude --plugin-dir $PWD --plugin-dir $PWD/tests/e2e/probe --settings /path/to/redact-restore-test-settings.json --model haiku"
```

```bash
bun tests/e2e/zj.ts send "Fake-data privacy test. Quote exactly: Contact alice@example.com about Project Phoenix."
```

```bash
bun tests/e2e/zj.ts wait && bun tests/e2e/zj.ts dump
```

`tests/e2e/probe` is a test-only mod (it recognizes the default placeholder format only). After each model response it logs whether the raw answer held a placeholder or a raw email, and how many of its tokens Redact Restore's vault knows. It never logs text or values. Scenarios covered: Write+Edit+Bash, hot reload (edit a file under `hooks/`), `@secret.md`, Agent tool subagent, `/compact`, `--resume <id>`, `/clear`, and a second concurrent `-p` session given the first session's token.

Clean up:

```bash
zellij kill-session redact-restore-live
```

### Rules pane and commands (no model calls)

In a Zellij-driven session started in a scratch git repository with a synthetic identity (`GIT_CONFIG_GLOBAL` pointing at a file with `Alice Example` / `alice@example.com`, a remote such as `git@git.acme.internal:platform/billing.git`, and a `.env` with a synthetic secret):

| Step                                                                       | Pass when                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/redact-restore scan`                                                     | Reply has counts by label only; pane lists masked candidates (`A•••• (13)`)                  |
| Tab to the first **Add**, Enter                                            | Notice `1 rule(s) added`; candidate moves to "already masked"                                |
| `/redact-restore rules`: value `Acme Corp`, label `CUSTOMER`, **Add rule** | Notice `A•••• (9) added`; rule listed with `CUSTOMER · manual`                               |
| `/redact-restore import import.json` (an export file), `export`, `status`  | Counts only; export path shown as `~/…`                                                      |
| `/redact-restore session`                                                  | State, counts by kind and source, settings, placeholders with masked values                  |
| Press **Remove** on each saved rule                                        | `Saved rules (0)`; delete the export file (`--replace` refuses a file with no valid entries) |

Do not press **Show values** while the screen is captured, and do not add the real computer or account name the scan also lists.

## 4. Desktop Code, Local session

Desktop does not load `--plugin-dir` folders. Install a local-scope copy for one test folder only:

```bash
claude plugin marketplace add /path/to/redact-restore
```

```bash
cd /path/to/redact-restore-desktop-test && claude plugin install redact-restore@redact-restore --scope local
```

Set options in a CLI session in that folder with `/plugin` → **Installed** → **redact-restore** → **Configure options** (the only way to enter several `custom_values`), or one value non-interactively:

```bash
echo '{"custom_values": "Project Phoenix"}' | claude plugin configure redact-restore@redact-restore --values-stdin
```

Then open a **new** Desktop Code Local session on the test folder and send:

```text
Fake-data privacy test. 1) Quote this line back exactly: Contact alice@example.com about Project Phoenix. 2) Use the Write tool to create notes.txt containing exactly that line. 3) Run in Bash: echo 'Contact alice@example.com about Project Phoenix' > bash.txt
```

Check: the chat shows originals; `notes.txt` and `bash.txt` have originals (default `restore_mode: all`); the session transcript has no synthetic plain text in user/assistant rows; its `version` field gives the Desktop engine version. A folder marketplace is read from the folder itself, so `/reload-plugins` picks up source edits.

Then run `/redact-restore rules`, `/redact-restore scan` and `/redact-restore session` in the Desktop session: the pane opens with the Rules, Scan and Session tabs, values masked until **Show values**, and each command's reply holds counts only. Add a synthetic rule in the pane, then press **Remove** to delete it again.

Clean up:

```bash
cd /path/to/redact-restore-desktop-test && claude plugin uninstall redact-restore@redact-restore --scope local
```

```bash
claude plugin marketplace remove redact-restore
```

## Still to exercise live

- Everything on Desktop Code (section 4).
- Pasted images (refused at `prompt.submit`), agent teams, peer messages.
- `ToolUse` rows (tool inputs on screen still show placeholders).
