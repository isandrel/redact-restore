# Security Policy

Redact Restore is a privacy tool: a value it claims to hide that still reaches the model API is a security vulnerability, as is anything that makes it restore a value where it should not.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

1. **Do NOT create a public GitHub issue** for security vulnerabilities.
2. Create a [private security advisory](https://github.com/isandrel/redact-restore/security/advisories/new).
3. Use synthetic values only. Never include a real secret, even one you have rotated.

### What to Include

- Claude Code version and surface (CLI or Desktop Code)
- Your non-secret options (`restore_mode`, detectors, placeholder format, ...)
- Steps to reproduce with synthetic values
- Where the value leaked (model request, tool input, file, status output, ...)
- Suggested fix, if any

### What to Expect

- **Acknowledgment**: within 7 days
- **Assessment and fix**: as fast as severity requires; a leak on a covered path is treated as critical
- **Credit** in the advisory, unless you prefer anonymity

## Scope

- The mod's hooks and their documented coverage ([docs/SECURITY.md](docs/SECURITY.md))
- The restoration policy (which tools receive original values)
- The status line, status file, logs and toasts (they must never contain values)

Out of scope, documented as known limitations in [docs/SECURITY.md](docs/SECURITY.md): what other installed mods can read, local transcript records the engine stores as made, and tools that run locally with original values by design.

## Security Measures

- CodeQL analysis and dependency review in CI
- Dependabot updates for GitHub Actions
- Fail-closed fallbacks on every gating hook, and a pre-send audit of model requests
- Unit, integration and regression tests for every reported leak

Thank you for helping keep Redact Restore and its users safe! 🛡️
