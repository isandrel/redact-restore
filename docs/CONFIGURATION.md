# Configuration

All options are set in a terminal Claude Code session: `/plugin` → **Installed** → **redact-restore** → **Configure options**. CLI and Desktop Code share the saved values; start a new session after changing them.

## Options

| Option                    | Default                    | Meaning                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                 | `true`                     | Master switch                                                                                                                                                                                                                                                                                                                                                |
| `status_line`             | `count`                    | Line under the prompt: `off`, `count`, `detailed` (counts by kind, tool mode, audit). Counts only                                                                                                                                                                                                                                                            |
| `status_format`           | empty                      | Template replacing the preset, e.g. `{state} 🔒{masked} +{lastTurn} ⛔{blocked}`. Fields listed in [Status fields](#status-fields)                                                                                                                                                                                                                           |
| `status_file`             | `false`                    | Write counts to `~/.claude/redact-restore/status/<session_id>.json` for your own `statusLine` script                                                                                                                                                                                                                                                         |
| `custom_values`           | —                          | Exact private values, one per entry; stored in secure storage (`sensitive`). Entries under 3 characters are ignored. Each entry is one value, matched exactly as typed; labels and aliases are set in the rules pane                                                                                                                                         |
| `custom_patterns`         | —                          | Regular expressions for private values, one per entry, stored like `custom_values`. Each entry is one JavaScript regex source used whole (nothing in it is parsed), matched as a whole word, masked as `CUSTOM`; `custom_case_insensitive` applies. Entries that fail the [pattern checks](#pattern-rules) are skipped and counted in a toast                |
| `custom_case_insensitive` | `false`                    | Match custom values regardless of case                                                                                                                                                                                                                                                                                                                       |
| `redact_emails`           | `true`                     | Detect email addresses                                                                                                                                                                                                                                                                                                                                       |
| `enable_detectors`        | empty                      | Extra detector ids or groups to turn on (`all`, `gitleaks`, `gitleaks.<id>`, …)                                                                                                                                                                                                                                                                              |
| `disable_detectors`       | empty                      | Detector ids or groups to turn off (`ipv4`, `ipv6`, `internal_host`, `mac_address`, `phone`, `us_ssn`, `env_assignment`, `cn_phone`, `secret_assignment`, `cn`, `network`, …); wins over the line above                                                                                                                                                      |
| `placeholder_format`      | `{{PRIVATE:{label}#{id}}}` | Placeholder shape: `{id}` once, `{label}` optional, starts with literal text, no whitespace, a separator between `{label}` and `{id}`. Alternatives: `{{{label}_{id}}}`, or `PRIVATE_{label}_{id}` (identifier style, safe unquoted in YAML and templates)                                                                                                   |
| `placeholder_id_length`   | `12`                       | Random hex characters per placeholder, 8–32                                                                                                                                                                                                                                                                                                                  |
| `restore_display`         | `true`                     | Show originals on screen, in the rows `restore_display_rows` names; stored rows and model input keep placeholders                                                                                                                                                                                                                                            |
| `restore_display_rows`    | all five                   | Comma-separated rows restored on screen: `UserMessage`, `AssistantMessage`, `ToolUse` (a tool call's input and inline result), `ToolResult`, `AskUserQuestion`. Unknown names are ignored                                                                                                                                                                    |
| `restore_streaming`       | `false`                    | Also show originals while a reply is still streaming (otherwise placeholders show until the reply is complete)                                                                                                                                                                                                                                               |
| `restore_mode`            | `all`                      | `all`: every local tool gets originals. `files`: only `Write`/`Edit`/`NotebookEdit`. `none`: tools always get placeholders                                                                                                                                                                                                                                   |
| `keep_tools`              | empty                      | Extra tool names that never get originals, added to the built-in list of model-bound and remote tools (`Agent`, `Task`, `Workflow`, `WebFetch`, `WebSearch`, `SendMessage`, `Skill`, `RemoteTrigger`, `CronCreate`, `ScheduleWakeup`, `SendFeedback`, `PushNotification`, `Artifact*`), which options cannot remove; `*` matches any text (`mcp__remote__*`) |
| `deny_unrestored_tools`   | empty                      | Extra tools refused when they would receive placeholder text without restoration, added to the built-in `Write, Edit, NotebookEdit`                                                                                                                                                                                                                          |
| `allow_media`             | `false`                    | Send images/PDFs Redact Restore cannot scan                                                                                                                                                                                                                                                                                                                  |
| `outbound_audit`          | `true`                     | Refuse a model request that still holds an unmasked value                                                                                                                                                                                                                                                                                                    |
| `scan_skip_dirs`          | empty                      | Folder names `/redact-restore scan PATH` skips, added to the built-in list (`.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `target`, `vendor`, `.next`, `coverage`, `.cache`)                                                                                                                                                      |
| `scan_max_files`          | `2000`                     | Files a path scan looks at, read or skipped (up to 20000), up to 8 folders deep and 5000 folders in all; files over 256 KiB and binary files are skipped, and the reply says how many were skipped and whether a limit stopped the scan                                                                                                                      |
| `rule_labels`             | empty                      | Comma-separated labels offered in the rules pane's Label list (`CUSTOMER, VENDOR, TEAM`). Empty: the built-in list. Labels your rules already use are always added; **Other label…** takes any label                                                                                                                                                         |

## Placeholders

Every rule is a set of fields, never a string to parse. In the rules pane (`/redact-restore rules`):

| Private value     | Replace with                 | The model sees (default format)    |
| ----------------- | ---------------------------- | ---------------------------------- |
| `Project Phoenix` | Placeholder, label `CUSTOM`  | `{{PRIVATE:CUSTOM#3fa1c09e8b2d}}`  |
| `Project Phoenix` | Placeholder, label `PROJECT` | `{{PRIVATE:PROJECT#3fa1c09e8b2d}}` |
| `Project Phoenix` | Fixed alias `CODENAME_X`     | `CODENAME_X`                       |

Values in the plugin options always use the `CUSTOM` label.

A fixed alias is restored wherever it appears as a whole word, so it must look unlike ordinary text: at least 4 characters, no spaces, and an underscore, a digit, or two capitals. An alias must also not overlap any other rule's value (in the options or saved), and two values cannot share one. The pane and imports refuse such a rule; if one is found in the merged rules anyway, its alias is dropped and the value is still masked with the default label; an invalid `placeholder_format` falls back to the default with a toast explaining why. Placeholders minted in an earlier format still restore after you change it.

## Pattern rules

Pick **Pattern** as the rule type in `/redact-restore rules` to mask every match of a regular expression, for example an internal token format. Each pattern is a set of fields:

| Field                 | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Pattern               | A JavaScript regex source, without slashes or flags (`ACME-[A-Z0-9]{16}`)                 |
| Example it must match | A made-up sample, checked when you save and never stored                                  |
| Label                 | The placeholder label, from the same list as exact values                                 |
| Ignore case           | Follow `custom_case_insensitive`, or yes / no for this rule                               |
| Whole word            | On by default: no letter or digit may touch either end of the match                       |
| Mask                  | The whole match, or one capture group (`ticket=(\w+)` with group 1 masks only the ticket) |

Pattern rules rank with exact values, above the built-in detectors. JavaScript cannot time out a regex, so patterns use a safe subset, checked without running anything, and a pattern outside it is refused with the reason:

- it must compile with the `u` flag, be at most 512 characters, and have the capture group it names;
- no backreferences (`\1`, `\k<name>`) and no lookarounds (`(?=…)`, `(?<!…)`); use **Whole word** for boundaries;
- repeat single characters or classes only, never a group: write `[a-z0-9.-]+`, not `([a-z0-9-]+\.)+`;
- at most 2 open-ended repeats (`*`, `+`, `{n,}`); give the others a size such as `{1,40}`;
- a keyword: fixed text of at least 3 characters that every match contains (`ACME-`), outside groups and `|` alternatives;
- it must match its example and mask at least 3 characters of it.

At run time a pattern runs only in a window around each copy of its keyword (256 characters before, 1024 after), so its cost is bounded per keyword copy rather than by the length of the text. A match that reaches the end of a window is matched again from its start without a limit, and one that reaches the start of a window is widened to the whole run of non-space characters, so a long value is masked whole rather than cut.

If two saved spellings of the same exact value disagree on case, the value ignores case (the safe side).

Exact values can ignore case on their own too: the form's **Ignore case** follows `custom_case_insensitive` by default, or says yes or no for that value.

## Saved rules: pane, scan, import and export

Besides the options, rules can live in the plugin store. Both sets are merged when matching; for the same value, the options win.

| Where                                            | Holds                                                              | Changes take effect                                 | Exported |
| ------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------- | -------- |
| Plugin options `custom_values` (system keychain) | Your most sensitive values                                         | Next session                                        | No       |
| Plugin store (`/redact-restore rules`)           | Rules you add, update or remove in the pane, or accept from a scan | At once, and in other sessions at their next prompt | Yes      |

The plugin store is a JSON file of the plugin's own in your Claude Code configuration folder, on macOS, Linux and Windows alike. It holds the values in plain text, one key per rule, named by the value's SHA-256 so concurrent sessions never overwrite each other. Dismissed scan candidates are kept as fingerprints only.

| Command                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/redact-restore rules`                     | Opens the pane. The **Add a rule** form takes the private value, **Replace with** (a placeholder with a label, or a fixed alias), the label (a list, or **Other label…**) and shows what the model will see; the value is saved exactly as typed. **Edit** on a saved rule fills the form; saving the same value again (same case) updates it; `Acme` and `ACME` are separate rules, each masked; with `custom_case_insensitive` on, the first one's label or alias applies to both spellings. Values are masked (`A•••• (13)`) until **Show values** |
| `/redact-restore scan [PATH]`               | Without a path: the git identity, remotes and last 200 commit authors, the computer and account names, `.env` files and the `package.json` author. With a path: every text file under a folder (or one file), for `KEY=value` values and private host names, with counts of what detectors already mask. Runs on this machine; candidates appear only in the pane: **Add**, **Ignore** or **Add all**                                                                                                                                                 |
| `/redact-restore test`                      | Opens the pane's **Test** tab: paste text and see what the model would receive and which values were found (masked until **Show values**). Checked on this machine; nothing is sent, saved or added to the session                                                                                                                                                                                                                                                                                                                                    |
| `/redact-restore session`                   | Opens the pane's **Session** tab: this session's state, counts by kind, source and tool, audits, settings, and every placeholder made (values masked until **Show values**)                                                                                                                                                                                                                                                                                                                                                                           |
| `/redact-restore status`                    | Rule counts, detectors, this session's counts and settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/redact-restore export [file]`             | Writes the saved rules to `~/.claude/redact-restore/redact-restore-rules.json` or the given file. Plain text: keep it out of version control and delete it after importing                                                                                                                                                                                                                                                                                                                                                                            |
| `/redact-restore import <file> [--replace]` | Merges an export file (JSON: `rules` with `value`, `label`, `alias`, `ignoreCase`, and `patterns` with `pattern`, `label`, `ignoreCase`, `wholeWord`, `group`; nothing is parsed from text) into the saved rules and patterns; `--replace` replaces the saved rules, and the saved patterns too when the file has a `patterns` list (an older export without one keeps them); it is refused unless every entry is valid                                                                                                                               |

The command's output reaches the model, so it holds counts, labels and paths only. A value already in the conversation was sent before its rule existed: the pre-send audit then blocks the next request until you `/clear` or `/rewind`. A removed rule keeps masking in the current session (the session remembers what it has masked) until `/clear`.

The plugin also ships skills that guide you through these: `/redact-restore:protect`, `:scan`, `:status`, `:policy`, `:placeholders`, `:troubleshoot`, `:import` and `:export`.

## Status fields

Available in `status_format` and in the status file. Counts and settings only; never values, placeholders, labels or paths.

| Field                                   | Meaning                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `masked`, `emails`, `custom`            | Distinct values in the session vault, by kind                                            |
| `occurrences`, `lastTurn`               | Replacements made in the session, and since your last prompt                             |
| `restored`, `kept`, `denied`            | Tool calls that got originals, kept placeholders (model-bound tools), or were refused    |
| `audits`, `blocked`                     | Requests audited before sending, and refused                                             |
| `media`                                 | Images or documents withheld                                                             |
| `state`                                 | `ok`, `warn` (hook fallback used, or settings ignored), `blocked` (last request refused) |
| `mode`, `audit`, `streaming`, `version` | Active settings and plugin version                                                       |

The status file adds `bySource` (prompt, context, attachment, systemPrompt, conversation), `restoredByTool`, `lastBlock` (kind, message index, block type), `hookErrors`, `model`, `surface`, `startedAt`, `updatedAt`, `lastEvent` and a `config` snapshot. Turn on `status_file` and read it with the `session_id` your `statusLine` command receives:

```bash
jq -r '"\(if .state == "blocked" then "⛔" else "🔒" end) \(.masked)"' "$HOME/.claude/redact-restore/status/$(jq -r .session_id).json" 2>/dev/null
```

Restoration is decided by one pure table in [hooks/policy.ts](../hooks/policy.ts), with the built-in lists in [hooks/defaults.ts](../hooks/defaults.ts): kept tools win, then `restore_mode`, then refused tools. The built-in lists there are the floor; options only add to them. Set options in a terminal session: `/plugin` → **Installed** → **redact-restore** → **Configure options** (CLI and Desktop Code share the saved values).

Enter real values only through `/plugin` → Installed → redact-restore → Configure options on your own machine. That interactive flow is currently the only way to enter several `custom_values`. Never put real values in source files, slash command arguments, or test files. Pasting text into chat is fine for values a rule or detector covers; add names and codenames as rules before you paste them.
