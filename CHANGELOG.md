# Changelog

## Unreleased

- Paste as usual: text with tokens and secrets pasted into chat is masked before it reaches the model and restored on screen. The `KEY=value` detector also covers inline assignments (`FOO=bar`, a one-line paste), and secret assignments match keys with a suffix (`aws_access_key_id =`, `client_secret_value:`). Skills and docs no longer tell users to avoid pasting values.
- Sensitive values are found and judged on your machine only. `/redact-restore scan PATH` checks any folder or file for `KEY=value` values and private host names, and counts what detectors already mask; the model receives counts and labels only. Skipped folders and the file limit are options (`scan_skip_dirs`, `scan_max_files`).
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
