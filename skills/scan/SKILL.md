---
name: scan
description: "Find likely private values on this machine and in this project (git identity and coworkers, remotes, computer and account names, .env values, package author) with Redact Restore's local scan, then add or ignore them as rules. Use when the user asks what personal or company information could leak to the model, wants help deciding what to protect, or mentions /redact-restore scan. Prefer this over reading files or running commands yourself, which would expose the values."
---

# Scan for private values

The scan runs inside Claude Code on the user's machine. You never see what it finds: the command output gives counts by label only, and the values appear only in the Redact Restore pane.

## Steps to give the user

1. Run `/redact-restore scan`. The pane opens on the **Scan** tab.
2. Review each candidate. Values are masked as `A•••• (13)`; **Show values** reveals them on screen only.
   - **Add** saves the value as a rule, with the suggested label (NAME, EMAIL, ORG, HOST, PROJECT, USER, SECRET or ENV).
   - **Ignore** hides it from later scans. Only a SHA-256 fingerprint is kept, never the value.
   - **Add all** saves every candidate shown.
3. After adding rules, run `/clear` if those values already appeared in this conversation (see the `protect` skill).

## What the scan reads

| Source                                 | Example finding                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `git config user.name` / `user.email`  | the user's name and email                                                       |
| `git remote -v`                        | the repository owner; also the host and repository name on a self-hosted server |
| `git log` (last 200 commits)           | coworkers' names and emails (bots skipped)                                      |
| `hostname`                             | the computer name, without `.local`                                             |
| home folder                            | the account name (`root`, `runner` and similar are skipped)                     |
| `.env`, `.env.*` in the working folder | values; secrets are labeled SECRET (`.env.example` and templates are skipped)   |
| `package.json`                         | the author                                                                      |

Values that a rule, the email scanner or a detector already masks are counted as "already masked" and not listed. Values shorter than 3 characters, numbers, booleans and words such as `localhost` are skipped.

## Interpreting the command output

`Scan found 5 new candidate(s) (2 NAME, 1 HOST, 2 ENV); 3 already masked, 1 ignored before.` Explain the counts and point the user to the pane. Do not try to guess the values.
