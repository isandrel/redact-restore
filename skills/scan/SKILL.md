---
name: scan
description: "Find likely private values on this machine, in this project or in any folder or file (git identity and coworkers, remotes, computer and account names, KEY=value settings such as .env files, private host names, package author) with Redact Restore's local scan, then add or ignore them as rules. Use when the user asks what personal or company information could leak to the model, wants to check a folder or file for sensitive data, wants help deciding what to protect, or mentions /redact-restore scan. Always use the local scan instead of reading files, running commands or judging values yourself."
---

# Scan for private values

Deciding whether something is personal or sensitive happens **on the user's machine only**, never in this conversation. If you read a file or run a command to look for private values, everything not yet covered by a rule reaches the model in the clear, which is exactly what Redact Restore exists to prevent. So:

- Do not read `.env` files, git config, `package.json`, logs or any other file to find or judge private values, and do not run `git config`, `hostname`, `env` or similar for that purpose.
- Do not list, guess or reconstruct values, and do not ask the user to paste them so you can judge them.
- You cannot run slash commands. Ask the user to run the scan; never say it is running.

## Steps to give the user

1. Ask the user to run one of these at the prompt:
   - `/redact-restore scan`: this machine and project (sources below).
   - `/redact-restore scan PATH`: a folder or a file, for example `/redact-restore scan ./config` or `/redact-restore scan ~/notes/clients.md`.
2. The Redact Restore pane opens on the **Scan** tab. Values are masked as `A•••• (13)`; **Show values** reveals them on that screen only.
   - **Add** saves the value as a rule with the suggested label (NAME, EMAIL, ORG, HOST, PROJECT, USER, SECRET or ENV).
   - **Ignore** hides it from later scans. Only a SHA-256 fingerprint is kept, never the value.
   - **Add all** saves every candidate shown. **Scan again** repeats the last scan.
3. After adding rules, ask the user to run `/clear` if those values already appeared in this conversation.

## What the scan reads

| Scan                   | Source                                                                 | Example finding                                                                                          |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/redact-restore scan` | `git config user.name` / `user.email`                                  | the user's name and email                                                                                |
|                        | `git remote -v`                                                        | the owner; the host and repository name on a self-hosted server                                          |
|                        | `git log` (last 200 commits)                                           | coworkers' names and emails (bots skipped)                                                               |
|                        | `hostname`, home folder                                                | the computer and account names                                                                           |
|                        | `.env`, `.env.*` in the working folder, `package.json`                 | settings values (templates skipped); the package author                                                  |
| `… scan PATH`          | every text file under the path (dependencies and build output skipped) | `KEY=value` values, host names such as `build.acme.internal`, plus counts of what detectors already mask |

Values that a rule, a detector or the `KEY=value` detector already masks are counted as "already masked" and not listed. Folders skipped and the file limit are options (`scan_skip_dirs`, `scan_max_files`).

## Reading the command output

The output carries counts and labels only, for example: `Scan of ~/proj (42 file(s) read) found 2 new candidate(s) (1 ENV, 1 HOST); 5 already masked, 0 ignored before. Already masked in these files: 3 EMAIL, 2 ENV.` Explain the counts and point the user to the pane.

## If the user insists that you look

Explain once, plainly: anything you read that is not already a rule reaches the model unmasked; `KEY=value` settings are masked, but names, codenames and most other text are not. Offer the local scan and the pane's **Show values** instead. Then stop and wait: read the file only after the user answers with a clear yes, in a later message, never in the same reply as the warning.
