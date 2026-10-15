---
name: data
description: "Explain where Redact Restore keeps data on this machine, how long, and how the user can delete it: saved rules, the keychain options, session placeholder maps for /resume, the status file and export files. Use when the user asks where their private values or placeholders are stored, whether anything leaves their machine, how /resume restores placeholders, how to change retention, or how to wipe Redact Restore's data."
---

# Where Redact Restore keeps data

Nothing below is sent to the model or any service. Explain it from this table; never read these files yourself, because they hold original values.

| What                                   | Where                                                                                       | Holds                                                                                               | Kept                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Saved rules and patterns               | The plugin store: a JSON file under `~/.claude/plugins/store/` (owner-only)                 | Values in plain text, labels, aliases, descriptions; dismissed scan fingerprints; the stable-id key | Until removed in `/redact-restore rules`            |
| Plugin options                         | Claude Code settings; `custom_values` and `custom_patterns` in the system keychain          | Option values                                                                                       | Until changed                                       |
| Placeholder map of the running session | Memory of the Claude Code process                                                           | Placeholder to value, descriptions                                                                  | Until `/clear` or exit                              |
| Session placeholder maps for `/resume` | `~/.claude/redact-restore/sessions/<session_id>.json` (folder 700, file 600 where possible) | Placeholder to value in plain text, descriptions                                                    | `session_map_days` (default 30; `0` keeps them all) |
| Status file (`status_file`, off)       | `~/.claude/redact-restore/status/<session_id>.json`                                         | Counts and settings only                                                                            | Overwritten per session                             |
| Export files                           | The path the user gave `/redact-restore export`                                             | Saved rules with values in plain text                                                               | Until the user deletes them                         |
| Transcripts                            | Claude Code's own `~/.claude/projects/…`                                                    | What the model saw (placeholders); Claude Code's local tool metadata may hold originals             | Claude Code's own retention                         |

## Settings the user can change

In `/plugin` → Installed → redact-restore → Configure options:

- `persist_session_map`: off stops writing session maps. A resumed session then cannot restore placeholders from before the resume: they show as placeholders and tool calls that use them are refused.
- `session_map_days`: how many days an untouched map is kept; files are deleted when a session starts. `0` keeps them all.
- `placeholder_ids`: `random` (default) gives each session new placeholders; `stable` keeps one placeholder per value across sessions (the provider can then link sessions that mention the same value, without learning it).

## Deleting data

Tell the user to do it themselves; do not run delete commands for them unless they ask:

- Session maps: delete files in `~/.claude/redact-restore/sessions/`.
- Saved rules: **Remove** in `/redact-restore rules`, or `/redact-restore import <file> --replace` with an export that holds only what they want to keep.
- Export files: delete them after importing.
