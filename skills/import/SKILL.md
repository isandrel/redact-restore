---
name: import
description: "Import redaction rules into Redact Restore from an export file (structured JSON), merging or replacing the saved rules. Use when the user wants to restore a backup, load rules from another computer, or bulk-add many rules from a file instead of adding them one by one."
---

# Import rules

## Ask the user to run

```text
/redact-restore import <file>
```

- Add `--replace` to replace every saved rule with the file's: `/redact-restore import ~/rules.json --replace`. It is refused, and nothing changes, unless every entry in the file is valid.
- Without it, the file is merged: new values are added, and a value already saved takes the file's label or alias.

The output gives counts only, for example `3 added, 1 updated, 0 unchanged, 1 skipped as invalid. 12 saved rule(s) now.`

## Accepted files

Only a file written by `/redact-restore export` (see the `export` skill): JSON in which every rule is a set of fields, `value` and optionally `label` or `alias`. Nothing is parsed from text, so plain text files are refused.

```json
{
  "format": "redact-restore-rules",
  "version": 1,
  "rules": [{ "value": "Acme Corp", "label": "CUSTOMER" }, { "value": "Project Phoenix", "alias": "CODENAME_X" }]
}
```

A rule is skipped when the value is under 3 characters, the label is invalid, or the alias is unusable, already used, or overlaps another rule's value (saved or in the plugin options).

## Help the user without seeing values

- The user should write the file themselves, in their own editor. Do not offer to create it from values they type into chat: names and codenames reach you before the rules exist.
- You may write a template in this format with synthetic examples, such as `{ "value": "Acme Corp", "label": "CUSTOMER" }`, for the user to fill in.
- Imported rules take effect at once in this session. If those values are already in the conversation, the next request is blocked: run `/clear`.
- Ask the user to delete the import file afterwards if it held real values.
