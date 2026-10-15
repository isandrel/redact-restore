---
name: policy
description: "Explain and choose Redact Restore's restore policy: which tools receive original values and which keep placeholders. Use when the user asks why a tool got a placeholder, why Write or Edit was refused, whether Bash, subagents or an MCP server see real values, or wants to change restore_mode, keep_tools or deny_unrestored_tools."
---

# Restore policy

Threat model: only the model API must not see private values. Tools that run on this machine get originals back, so builds, scripts and file edits are correct. Tools whose input goes to another model or a remote service keep placeholders.

## How a tool call is decided

1. **Kept tools** always receive placeholders: `Agent`, `Task`, `Workflow`, `WebFetch`, `WebSearch`, `SendMessage`, `Skill`, `RemoteTrigger`, `CronCreate`, `ScheduleWakeup`, `SendFeedback`, `PushNotification`, `Artifact`, `ArtifactData`, `ArtifactComments`, plus anything in `keep_tools`. Options can add to this list but never remove from it.
2. **`restore_mode`** decides the rest:
   - `all` (default): every other tool gets originals.
   - `files`: only `Write`, `Edit` and `NotebookEdit` get originals.
   - `none`: every tool gets placeholders.
3. **Refused tools**: when a tool would receive placeholder text without restoration, `Write`, `Edit`, `NotebookEdit` and anything in `deny_unrestored_tools` are refused. This prevents placeholders being written into files.

A placeholder that the session does not know is never guessed: the call is refused.

## Recommendations

| Situation                                   | Setting                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Normal local development                    | `restore_mode: all` (default)                                           |
| Remote MCP server, such as `mcp__jira__*`   | add it to `keep_tools`                                                  |
| Do not want shell commands to see originals | `restore_mode: files`                                                   |
| Placeholders only, everywhere               | `restore_mode: none` (file edits that contain placeholders are refused) |

`*` matches any text in tool patterns, as in `mcp__remote__*`.

## Changing it

The user changes these in `/plugin` → Installed → redact-restore → Configure options, then starts a new session. Do not edit settings files for them unless they ask.

## On screen

Separate from tools: with `restore_display` (default on), the user sees originals in the rows listed in `restore_display_rows` (default: user and assistant messages, tool calls and their results, and `AskUserQuestion` dialogs). `restore_streaming` (default on) restores replies while they stream. Only what is drawn changes; the stored conversation and everything you receive keep placeholders.

## When you see a refusal

`Redact Restore: Write would receive private placeholder text, and restoration is off for it` means the call held a placeholder and the policy does not restore for that tool. `Write`, `Edit` and `NotebookEdit` are restored under both `all` and `files`, so for them this happens under `restore_mode: none`. Rewrite the call without the placeholder, or ask the user to change the option. Never try to reconstruct the original value.
