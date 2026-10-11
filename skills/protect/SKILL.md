---
name: protect
description: "Set up Redact Restore so private values (names, customers, codenames, internal hosts, keys) are replaced with placeholders before anything reaches the model. Use whenever the user wants to hide, mask, redact, anonymize or keep something away from Claude or the model API, asks how to get started with Redact Restore, or asks what it protects, even if they do not name the plugin."
---

# Protect private values

Redact Restore replaces private values with placeholders such as `{{PRIVATE:NAME#3fa1c09e8b2d}}` before anything is sent to the model API. The user sees the originals on screen, and local tools (Bash, Edit, Write, local MCP) receive the originals.

You only ever see placeholders. Never ask the user to type, paste or confirm a private value in chat: chat text reaches you before a rule for it exists.

## Steps to give the user

1. **Find candidates.** Ask the user to run `/redact-restore scan`. It checks the git identity, remotes and recent authors, the computer and account names, `.env` files and the package author. The command output shows counts only. The values appear only in the Redact Restore pane, where the user picks **Add** or **Ignore**.
2. **Add their own values.** Ask the user to run `/redact-restore rules` and fill in the **Add a rule** form in the pane:
   - **Private value**: for example `Acme Corp`.
   - **Replace with**: a placeholder with a label (pick one such as `CUSTOMER`, or **Other label…**), or a fixed alias such as `CLIENT_A`.
   - The form shows what the model will see; **Add rule** saves it. **Edit** on a saved rule changes its label or alias.
3. **Choose where the most sensitive values live:**
   - Pane rules are kept in the plugin store on this computer (a local JSON file), take effect at once, and can be exported.
   - Values entered in `/plugin` → Installed → redact-restore → Configure options → Exact private values go to the system keychain. They need a new session and are never exported.
4. **Start clean.** A value that is already in the conversation was sent before the rule existed. The next request is then blocked by the pre-send audit. Tell the user to run `/clear` (or `/rewind`) after adding rules mid-conversation.
5. **Check.** Ask the user to run `/redact-restore status`, or to watch the status line under the prompt.

## What is covered

Covered: prompts, CLAUDE.md and the account email, mentioned files and reminders, the system prompt, and every tool result. Built-in detectors also mask emails, more than 200 API key formats, private keys, JWTs, passwords, cards, IBANs and Chinese ID numbers.

Not covered: images and PDFs are withheld unless the user allows them, because they cannot be scanned. Other installed mods can read the session's state.

For the restore policy, see the `policy` skill. For the placeholder format, see the `placeholders` skill.
