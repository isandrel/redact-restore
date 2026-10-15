# Changelog

## 0.2.0 - 2026-10-14

Verified: 294 unit and integration tests (`claude-code/testing`, CLI 2.1.292), `bun run bench`, and a live CLI 2.1.292 session with synthetic data (display restore of Bash rows, descriptions before and after `/compact`, `/resume` in a new process, prompt-cache hits; the model received 0 raw values). Desktop Code: not live-tested for these changes.

- Faster in large sessions: 1 MB of tool output masks in about 60 ms instead of 160 ms (gitleaks keywords found in one pass, a quadratic overlap check in the `KEY=value` detector removed), and a vault of 10,000 values no longer recompiles for every new value (masking 300 rows went from 23 s to 0.2 s). `bun run bench` measures it.
- `/resume` keeps working: each session's placeholder map is kept in a local file (`persist_session_map`, on by default; folder 700, file 600 where the system allows) and loaded again after a resume, so earlier placeholders still show and restore. Files untouched for `session_map_days` (30; `0` keeps them all) are deleted.
- `restore_streaming` is on by default: replies show original values while they stream, not only once complete.
- Descriptions: tell the model what a value is without the value. The placeholder note explains common labels (static, so the prompt cache keeps hitting), and saved values and patterns can carry a description (`client company name`), sent once per placeholder as hidden prompt context, or at the end of the tool result where the value first appears, and again after a compaction. Descriptions are checked and masked locally; scans suggest one from where they found the value; export and import carry them.
- `placeholder_ids` option: `random` (default) gives a value a new placeholder in each session; `stable` gives the same value the same placeholder in every session, from a local key in the plugin store (HMAC-SHA-256). The docs list where Redact Restore keeps data.
- Tool rows, tool results and `AskUserQuestion` dialogs show original values on screen, like messages. Rows to restore are listed in one table in `hooks/defaults.ts` and chosen with the new `restore_display_rows` option.
- Pattern rules: mask every match of your own regular expression, from the rules form (pattern, example it must match, label, ignore case, whole word, mask the whole match or one group) or the `custom_patterns` option. JavaScript cannot time out a regex, so patterns use a safe subset checked without running them (no backreferences, lookarounds or repeated groups, at most 2 open-ended repeats, a required keyword) and run only near their keyword. They are exported and imported as fields; `import --replace` replaces saved patterns only when the file has a `patterns` list.
- Exact values can ignore case on their own, overriding `custom_case_insensitive` either way.
- New default-on detectors: `internal_host` (`*.internal`, `*.corp`, `*.lan`, `*.local`, …, told apart from code such as `self.local`), `ipv6` and `mac_address`. Turn any of them off with `disable_detectors`.
- The model note now spells out how to use placeholders: copy them exactly, never split or invent one, keep them where the value belongs instead of a mock or `localhost`, and do the task as usual.
- Test tab: `/redact-restore test` opens a tab in the pane where you paste text and see what the model would receive, and which values were found, before you send it. It runs on your machine and records nothing.
- Paste as usual: text with tokens and secrets pasted into chat is masked before it reaches the model and restored on screen. The `KEY=value` detector also covers inline assignments (`FOO=bar`, a one-line paste), and secret assignments match keys with a suffix (`aws_access_key_id =`, `client_secret_value:`). Skills and docs no longer tell users to avoid pasting values.
- Sensitive values are found and judged on your machine only. `/redact-restore scan PATH` checks any folder or file for `KEY=value` values and private host names, and counts what detectors already mask; the model receives counts and labels only. Skipped folders and the file limit are options (`scan_skip_dirs`, `scan_max_files`); the reply says how many files were skipped and whether a limit stopped the scan.
- New default-on detector `env_assignment`: the value of a `KEY=value` line (as in `.env` files) is masked in everything sent to the model, so a settings file read by a tool no longer leaks names or hosts it holds.
- Skills no longer let the model read files, run commands or ask for pasted values to judge what is private, and no longer claim a scan is running; they ask the user to run the local scan.
- README: install command and a two-minute fake-email test at the top, a free-to-use note, and a short summary of what Redact Restore does not do.

## 0.1.0 - 2026-10-11

First public release.

- Reversible redaction for Claude Code without an API gateway: private values become placeholders before the model API sees prompts, first-message context, injected attachments, the system prompt or stored conversation rows, and are restored on screen and in local tool inputs.
- Detection: your exact values (each with an optional label or fixed alias, set as fields in the rules pane), email, 29 built-in detectors (provider keys, JWT, private keys, passwords, cards, IBAN, Chinese ID, mobile and USCC, and more) and 212 rules vendored from gitleaks v8.30.1.
- Restoration policy: `restore_mode` (`all`, `files`, `none`); model-bound and remote tools always keep placeholders; unknown placeholders are refused at tool calls.
- Safety nets: a pre-send audit of every model request, media withheld by default, fail-closed fallbacks on every gating hook, prompts held when saved rules cannot be read, and bad labels or aliases dropped without unmasking their values.
- Placeholders look like `{{PRIVATE:EMAIL#3fa1c09e8b2d}}` by default (12-character random id); the format is configurable (`placeholder_format`, `placeholder_id_length`), e.g. the identifier style `PRIVATE_{label}_{id}`. Optional streaming restoration, status line with templates, and a status file for custom `statusLine` scripts.
- Rules pane and command: `/redact-restore rules` (add, update, remove, values masked until shown), `/redact-restore scan` (git identity, remotes and authors, computer and account names, `.env` values, package author; results only in the local pane), `/redact-restore status`, and `/redact-restore export` / `import` (structured JSON; nothing is parsed from text). Rules are kept in the plugin store, one key per rule, merged with the keychain-backed `custom_values`.
- Eight bundled skills for users: `protect`, `scan`, `status`, `policy`, `placeholders`, `troubleshoot`, `import`, `export`.
- Tunable defaults (limits, tool lists, scan sources, messages) live in one file, `hooks/defaults.ts`.
- Tested with `claude-code/testing` unit and integration suites and live in an interactive Claude Code CLI 2.1.287; Desktop Code is not live-tested yet.
