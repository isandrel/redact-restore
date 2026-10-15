---
name: redact-restore-extend
description: Guide for changing Redact Restore's behavior - adding a detector, a masking path or hook, a restore-policy rule, or a user option - while keeping the code layout, privacy guarantees and docs consistent. Use when asked to add or change a feature, detector, option, or hook in this repository.
---

# Extend Redact Restore

Goal of the mod: **the model API never receives private values; everything local works with the real ones.** Every change must keep that true and fail safe.

Second rule: **what is private is decided on the user's machine, never by the model.** Scans, detectors and the rule form run locally; command output, tool results and skills give the model counts and labels only. Never add a feature or skill step that sends raw text to the model to classify, asks users to paste values, or lets the model read files to find them.

## Where things go

| Change                                  | File                                         | Notes                                                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New detector                            | `hooks/detectors.ts`                         | One table entry: id, label, groups, default, finder (regex + literal hint + validator). Mask only the secret part (`(?<secret>…)` group). Add HIDE/KEEP cases to `tests/unit/detectors.test.ts`, building key-shaped fixtures at run time |
| Third-party rules                       | `scripts/sync-gitleaks.ts` → `hooks/vendor/` | Never hand-edit `hooks/vendor/gitleaks-rules.ts`; rerun the script with a pinned tag, then run the unit tests (compile count, HIDE/KEEP, speed)                                                                                           |
| Matching (literals, overlap, priority)  | `hooks/matcher.ts`                           | Pure. Linear-time only: no backtracking regex on unbounded input. Return spans on the original text                                                                                                                                       |
| Tokenize, restore, block masking, audit | `hooks/privacy.ts`                           | Pure. Never log or return values in diagnostics                                                                                                                                                                                           |
| Rows restored on screen                 | `hooks/defaults.ts` `DISPLAY_RESTORE_FIELDS` | One entry per `ui.render` component: the props to restore for drawing. `restore_display_rows` picks which are on. Display only: never restore anything stored or sent                                                                     |
| Which tools get originals               | `hooks/policy.ts`                            | Lists in `hooks/defaults.ts` + `toolAction`. Order: `keep_tools`, then `restore_mode`, then `deny_unrestored_tools`                                                                                                                       |
| Option parsing                          | `hooks/config.ts`                            | Defaults must match `default` in `.claude-plugin/plugin.json`                                                                                                                                                                             |
| Hooks and every `$` call                | `hooks/register.ts`                          | Only file that touches `$`. Never pass `$` to an imported helper (the validator refuses it)                                                                                                                                               |
| User options                            | `.claude-plugin/plugin.json` `userConfig`    | `string` + `options` gives a `/config` picker; lists are comma-separated strings; secrets use `sensitive: true`                                                                                                                           |
| Tunable defaults, user-facing text      | `hooks/defaults.ts`                          | Limits, tool lists, scan sources, store keys, messages. No magic values inline elsewhere                                                                                                                                                  |
| Saved rules, import/export              | `hooks/rules.ts`                             | Pure. One store key per rule (`rule.<sha256>`); never put a value in a key or in command output                                                                                                                                           |
| Scan sources                            | `hooks/scan.ts`                              | Pure; `register.ts` gathers inputs (git, hostname, files, `scan PATH` folders). Candidates go only to the pane; the model gets counts and labels. Never add a path that asks the model to read or judge values                            |
| Pane (rules, scan, session tabs)        | `hooks/pane.tsx`                             | Pure drawing from data + handler closures; values masked until **Show values**                                                                                                                                                            |
| User skills shipped with the plugin     | `skills/<name>/SKILL.md`                     | End-user help only; never ask users to type values in chat                                                                                                                                                                                |
| State shape                             | `types/index.d.ts`                           | Declare every `$.state` key under `redact-restore`                                                                                                                                                                                        |

## API lookup

The engine's own declarations are the authority, not memory or online examples: grep `.claude-plugin/types/claude-code/index.d.ts` (written when an interactive `claude --plugin-dir .` session loads the folder) for the event (`'prompt.attachment'`), then read its input and result types and the `@remarks`.

## Checklist for any change

1. **Fail closed.** A gating hook (`prompt.submit`, `tool.call`, `session.append`, `turn.step`, `prompt.*`) needs `.catch(($, e, next) => next.called ? next(e) : <refusal>)`. A failure must mask without recording, withhold, or refuse; never pass plaintext.
2. **Tests.**
   - `tests/unit/`: a HIDE list (must mask), a KEEP list (must not mask), a round trip, and a 1 MB timing case for new regexes.
   - `tests/integration/`: the hook through the engine's dispatch. Register the test's hooks before the first `$` call; answer `$`-call events with `{ value }`.
3. **Synthetic data only**, from `example.com`, `.test`, `.example`, `.internal` domains.
4. **Docs.** Update the coverage table in `docs/SECURITY.md`, `docs/COMPATIBILITY.md` (mark new behavior "Kit only" until live-tested), the option table in `docs/CONFIGURATION.md`, the detector table in `docs/DETECTORS.md`, and `CHANGELOG.md`.
5. **Configurable, not hard-coded.** Tunable values (limits, lists, patterns, messages) go in `hooks/defaults.ts`; anything a user may want to change becomes an option in `.claude-plugin/plugin.json` `userConfig`, parsed in `hooks/config.ts` with the built-in value as the default.
6. **Skills.** If behavior a user sees changes, update the matching `skills/<name>/SKILL.md` (user-facing, shipped publicly: synthetic examples only, no personal names, paths or hosts).
7. **Model note.** If restoration or placeholder handling changes, update `placeholderSection` in `register.ts`, which tells the model what placeholders are.
8. Run the `redact-restore-verify` skill; live-test with `redact-restore-e2e` before calling a path covered.

## Known engine facts (2.1.287)

- `session.append` puts back `tool_use` and thinking blocks; only text and `tool_result` content are rewritable.
- `prompt.attachment` fires inside `turn.step`, after the audit reads messages; `$.session.messages()` can hold raw attachment copies (subagents, after compaction), so the audit skips `<system-reminder>` blocks.
- `$.state` survives hot reload, resets per process (`--resume` starts empty), and is readable by any plugin.
- A hooks module may import only `claude-code` and its own files by relative path: an npm library must be vendored as a file in the plugin (with its license), never imported by name.
- Options for `--plugin-dir` come from user settings, `--settings`, or managed settings only.
