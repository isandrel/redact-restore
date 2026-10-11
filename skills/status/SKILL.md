---
name: status
description: "Check whether Redact Restore is active and what it has masked in this session, using counts only. Use when the user asks if redaction is working, how many values were hidden, what the status line or status file means, or what Redact Restore is doing right now."
---

# Redact Restore status

## Ask the user to run

`/redact-restore session` opens the pane's **Session** tab: state, counts by kind, source and tool, audits, settings, and every placeholder this session made. Values there are masked until the user presses **Show values**, and the pane is never sent to you.

For a text summary, `/redact-restore status`. Its output (counts and settings, never values) shows:

- the plugin version, and whether it is disabled;
- saved rules (plugin store), rules in the plugin options (keychain), and active detectors;
- this session's counts: distinct values masked by kind, replacements, tool calls restored, kept or denied, audits and blocked requests;
- the restore mode, the outbound audit and the streaming restore settings.

## The status line under the prompt

Set with the `status_line` option: `off`, `count` (for example `4 private values masked`) or `detailed`. The `status_format` option is a template such as `{state} 🔒{masked} +{lastTurn} ⛔{blocked}`.

| Field                        | Meaning                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `masked`, `emails`, `custom` | distinct values hidden this session                                    |
| `occurrences`, `lastTurn`    | replacements, in the session and since the last prompt                 |
| `restored`, `kept`, `denied` | tool calls that got originals, kept placeholders, or were refused      |
| `audits`, `blocked`          | requests checked before sending, and refused                           |
| `state`                      | `ok`, `warn` (a fallback was used or a setting was ignored), `blocked` |

## Status file

With `status_file` on, counts are written to `~/.claude/redact-restore/status/<session_id>.json` for a custom `statusLine` script. You may read that file: it never holds values, placeholders or labels.

## Self-check you can do

Placeholders such as `{{PRIVATE:EMAIL#…}}` in your own context prove the masking works. If the user typed a value they expected to be hidden and you can read it as plain text, it was not covered: use the `troubleshoot` skill.
