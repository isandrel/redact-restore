---
name: export
description: "Export Redact Restore's saved rules to a file to back them up or move them to another computer. Use when the user wants to back up, copy, migrate, sync or share their redaction rules, or is setting up Redact Restore on a new machine."
---

# Export rules

## Ask the user to run

```text
/redact-restore export
```

This writes `~/.claude/redact-restore/redact-restore-rules.json`. To choose the file, give a path: `/redact-restore export ~/Desktop/rules.json`. A leading `~` means the home folder on macOS, Linux and Windows.

The command output gives only the path and the number of rules. You never see the values.

## Warn the user

- **The file holds the original values in plain text.** Keep it out of git and cloud-synced folders, move it over a trusted channel, and delete it after importing.
- Only the pane rules are exported. Values in the plugin options (keychain) are not; re-enter those on the other machine in `/plugin` → Installed → redact-restore → Configure options.
- Do not open, read or print the exported file. Reading it would put the values in tool output; they would be masked before reaching you, but there is no reason to risk it.

## Format

```json
{
  "format": "redact-restore-rules",
  "version": 1,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "rules": [{ "value": "Acme Corp", "label": "CUSTOMER" }, { "value": "Project Phoenix", "alias": "CODENAME_X" }]
}
```

To restore it, see the `import` skill.
