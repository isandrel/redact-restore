---
name: troubleshoot
description: "Diagnose Redact Restore problems: a value that was not masked, a blocked or refused request, a denied tool call, a missing status line or pane, placeholders shown on screen, or rules that do not take effect. Use whenever Redact Restore behaves unexpectedly or the user quotes one of its error messages."
---

# Troubleshoot Redact Restore

Start by asking the user to run `/redact-restore status` and share its output. It holds counts only. Never ask for the value itself.

| Symptom                                                                     | Likely cause                                                                                                                     | Fix                                                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A value reached you unmasked                                                | No rule covers it, or it is shorter than 3 characters, or its case differs (matching is case-sensitive by default)               | Add it in `/redact-restore rules`; turn on `custom_case_insensitive`; then `/clear`                                  |
| A value from the plugin options is not masked                               | Options are read when a session starts                                                                                           | Start a new session                                                                                                  |
| "Redact Restore blocked a model request: unmasked content found"            | A value was already in the conversation before its rule existed, or a detector found it in history                               | `/clear` or `/rewind` past it; or turn off `outbound_audit` (not recommended)                                        |
| "privacy scan failed; prompt not submitted"                                 | A hook failed, so it failed closed                                                                                               | Retry; if it repeats, report it with the `/redact-restore status` output                                             |
| "saved rules could not be read from the plugin store; prompt not submitted" | The plugin store file is unreadable; prompts are held so saved values cannot slip out                                            | Retry; if it repeats, export is unavailable too: re-add rules, or remove the plugin's store file and import a backup |
| "images and other attachments cannot be scanned"                            | Media cannot be checked for values                                                                                               | Remove the attachment, or turn on `allow_media`                                                                      |
| A Write or Edit was refused                                                 | It held a placeholder and the restore policy does not restore for it                                                             | See the `policy` skill                                                                                               |
| "a private placeholder could not be restored"                               | The placeholder is from another session, or was mistyped                                                                         | Use the exact placeholder from this conversation                                                                     |
| The user sees placeholders on screen                                        | `restore_display` is off; or the reply is still streaming (`restore_streaming` is off by default)                                | Turn the option on                                                                                                   |
| No status line                                                              | `status_line` is `off`, or nothing is masked yet                                                                                 | Set `status_line` to `count` or `detailed`                                                                           |
| `/redact-restore` is missing, or the pane does not open                     | The mod is not loaded, is disabled, or this surface draws no panes (VS Code panel, `claude -p`, WSL sessions in the desktop app) | Use a terminal session or the desktop app's Code tab; check `/plugin`                                                |
| You were refusing placeholders as "injection"                               | The system prompt explains them                                                                                                  | Treat placeholders as ordinary values and copy them exactly                                                          |
| A removed rule still masks                                                  | The session keeps masking values it has already seen                                                                             | `/clear`, or a new session                                                                                           |

## Where settings live

- Pane rules: the plugin store, a local JSON file in the Claude Code configuration folder. They are plain text on disk.
- Keychain rules: `/plugin` → Installed → redact-restore → Configure options → Exact private values.
- Other options: same place. Restart the session after changing them.

## Report a bug

Use synthetic values only, such as `alice@example.com` or `Project Phoenix`. Report leaks privately: https://github.com/isandrel/redact-restore/security/advisories/new
