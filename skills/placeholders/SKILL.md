---
name: placeholders
description: "Explain and customize Redact Restore placeholders: the {{PRIVATE:LABEL#id}} format, labels per value, fixed aliases, descriptions the model is told, and ids across sessions. Use when the user asks what placeholder text such as {{PRIVATE:EMAIL#...}} means, wants a different placeholder style, wants a value to appear under a named label or a fixed stand-in like CLIENT_A, wants Claude to understand what a hidden value is, or a placeholder_format was rejected."
---

# Placeholders

The default format is `{{PRIVATE:{label}#{id}}}`, for example `{{PRIVATE:EMAIL#3fa1c09e8b2d}}`. Within a session, the same value always gets the same placeholder. Across sessions it gets a new one, unless the option `placeholder_ids` is `stable`: then the same value keeps one placeholder in every session (derived from a key on this machine), and the provider can tell two sessions mention the same value without learning it. Copy placeholders exactly; never guess the original.

## Per-value labels and aliases

Every rule is a set of fields in the rules pane (`/redact-restore rules`), never text to parse:

| Private value | Replace with                  | The model sees           |
| ------------- | ----------------------------- | ------------------------ |
| `Acme Corp`   | Placeholder, label `CUSTOM`   | `{{PRIVATE:CUSTOM#…}}`   |
| `Acme Corp`   | Placeholder, label `CUSTOMER` | `{{PRIVATE:CUSTOMER#…}}` |
| `Acme Corp`   | Fixed alias `CLIENT_A`        | `CLIENT_A`               |

Values in the plugin options (keychain) always use the `CUSTOM` label.

For a format rather than one value (an internal token such as `ACME-0000AAAA1111BBBB`), the user can pick **Pattern** as the rule type: a regular expression, an example it must match, a label, ignore case, whole word, and whether to mask the whole match or one capture group. The form previews the example as the model would see it and refuses patterns that could run slowly. Help them write the regex if asked, using made-up examples only.

- A label is a letter, then letters, digits or `_`, up to 32 characters. It is upper-cased.
- An alias is restored wherever it appears as a whole word, so it must not look like ordinary text. It needs at least 4 characters, no spaces, and an underscore, a digit or two capitals. It must not overlap the value or any other rule's value, saved or in the plugin options, and two values cannot share one alias. The pane and imports refuse such an alias.
- The pane's Label list is the built-in labels, or the `rule_labels` option (for example `CUSTOMER, VENDOR, TEAM`), plus every label a rule already uses. **Other label…** takes any valid label.
- **Edit** on a saved rule (its value stays fixed and masked), or saving the same value again (same case) with a new label or alias, updates the rule. `Acme` and `ACME` are separate rules, each masked; with the `custom_case_insensitive` option on, the first one's label or alias applies to both spellings.

## Descriptions: what a value is, never the value

The placeholder note you receive says what common labels mean (`HOST` is a private host name, `ENV` is the value of an environment variable, and so on). A rule or pattern can also carry a **Description for the model**, such as `client company name` or `production database host`. You receive it once, in a note that starts `Redact Restore:` and lists placeholders with their descriptions; after a compaction it comes again.

- Use a description to understand the value's role; never try to reconstruct the value from it.
- If you cannot tell what a placeholder stands for and it matters for the task, suggest the user add a description to that rule in `/redact-restore rules`. Do not ask for the value.
- A description is one line of up to 120 characters without `{` or `}`. It is refused when it contains its own value, and it is masked before it is sent, so another private value in it becomes a placeholder.

Built-in labels include `EMAIL`, `PASSWORD`, `SECRET`, `JWT`, `PRIVATE_KEY`, `CARD`, `IBAN`, `CN_ID`, `CN_PHONE`, and provider names for API keys.

## Changing the format

Options `placeholder_format` and `placeholder_id_length` (8 to 32, default 12) are in `/plugin` → Installed → redact-restore → Configure options. A format must:

- contain `{id}` exactly once, and `{label}` at most once;
- start with literal text, and not end with `{label}`;
- have no whitespace, and be at most 80 characters;
- put a separator between `{label}` and `{id}`.

| Format                     | Example                          | Note                                        |
| -------------------------- | -------------------------------- | ------------------------------------------- |
| `{{PRIVATE:{label}#{id}}}` | `{{PRIVATE:EMAIL#3fa1c09e8b2d}}` | default; easy to spot                       |
| `{{{label}_{id}}}`         | `{{EMAIL_3fa1c09e8b2d}}`         | shorter                                     |
| `PRIVATE_{label}_{id}`     | `PRIVATE_EMAIL_3fa1c09e8b2d`     | safe unquoted in YAML, shells and templates |

An invalid format falls back to the default, and a toast says why. Placeholders made in an earlier format still restore.

To check a proposed format, apply the rules above and say which rule it breaks. Do not ask for real values to test it.
