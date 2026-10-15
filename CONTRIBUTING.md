# 🤝 Contributing to Redact Restore

Thank you for considering a contribution. Redact Restore protects private values, so every change is held to one rule first: **the model API must never receive a value the mod claims to hide**, and failures must fail safe.

## 📋 Table of Contents

- [Code of Conduct](#-code-of-conduct)
- [Never Use Real Secrets](#-never-use-real-secrets)
- [How Can I Contribute?](#-how-can-i-contribute)
- [Development Setup](#-development-setup)
- [Project Layout](#-project-layout)
- [Testing](#-testing)
- [Pull Request Process](#-pull-request-process)
- [Releases](#-releases)

## 📜 Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behavior to the maintainer privately.

## 🔐 Never Use Real Secrets

- Use synthetic values only, in code, tests, issues, screenshots, logs and commit messages: `alice@example.com`, `Project Phoenix`, `acme.internal`, `/path/to/...`.
- Build key-shaped test values at run time from fragments (see `tests/unit/detectors.test.ts`), so the repository holds no secret-looking literal.
- Report vulnerabilities privately, never in a public issue: see [SECURITY.md](SECURITY.md).

## 🎯 How Can I Contribute?

### 🐛 Reporting Bugs

Use the [bug report form](.github/ISSUE_TEMPLATE/01-bug-report.yml). Include the Claude Code version (`claude --version`, or `/status` in Desktop Code), the surface (CLI or Desktop Code), your non-secret options, and steps with synthetic values.

### 🔎 Detection Gaps and False Positives

- A provider key or personal-data format that is not masked: use the [detector request form](.github/ISSUE_TEMPLATE/03-detector-request.yml).
- Ordinary text that is masked by mistake: use the [false positive form](.github/ISSUE_TEMPLATE/04-false-positive.yml).

### ✨ Suggesting Features

Use the [feature request form](.github/ISSUE_TEMPLATE/02-feature-request.yml). Describe the problem first, then the proposed behavior and its privacy impact.

## 💻 Development Setup

### Prerequisites

- [Claude Code](https://code.claude.com) 2.1.287 or newer (Mods support)
- [Bun](https://bun.sh) 1.4 or newer (dev tooling only; the mod itself has no dependencies)

### Installation

```bash
git clone https://github.com/isandrel/redact-restore.git
```

```bash
cd redact-restore && bun install
```

Load the mod into a **new** session so your other sessions are unaffected:

```bash
claude --plugin-dir .
```

That first interactive session also writes the engine's type declarations to `.claude-plugin/types/` (gitignored), which the mod's type-check needs.

### Commands

| Command                                             | What it does                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                                     | Strict `tsc` for the mod (engine declarations) and the Bun tooling (`@types/bun`)                                                                  |
| `claude plugin test .`                              | Unit and integration tests with `claude-code/testing`                                                                                              |
| `bun run bench`                                     | Timing of the masking paths on synthetic data (1 MB tool output, 10,000-value vault, per-detector cost); run before and after a change to matching |
| `claude plugin validate .claude-plugin/plugin.json` | Manifest and hooks module, as the engine reads them                                                                                                |
| `bun run format` / `bun run format:check`           | Biome (TypeScript, JSON) and dprint (Markdown)                                                                                                     |
| `bun run sync-gitleaks [tag]`                       | Regenerate the vendored gitleaks rules                                                                                                             |

## 🗂️ Project Layout

```text
redact-restore/
├── .claude-plugin/
│   ├── plugin.json        # manifest, userConfig, state contract
│   └── marketplace.json   # local marketplace (redact-restore) for installed testing
├── hooks/
│   ├── hooks.json
│   ├── register.ts        # every hook and every $ call
│   ├── defaults.ts        # every tunable default: limits, tool lists, scan sources, messages
│   ├── config.ts          # option parsing (pure)
│   ├── rules.ts           # saved rules, import and export (pure)
│   ├── scan.ts            # scan candidates from git, host, .env, package.json (pure)
│   ├── pane.tsx           # the rules and scan pane, drawn from data (pure)
│   ├── policy.ts          # which tools get originals (pure, data-driven)
│   ├── matcher.ts         # literals, email, overlap and priority (pure)
│   ├── detectors.ts       # built-in detector table + gitleaks adapter (pure)
│   ├── placeholder.ts     # placeholder formats, labels, aliases (pure)
│   ├── privacy.ts         # tokenize, restore, block masking, audit, streaming (pure)
│   ├── status.ts          # status line and status file text (pure)
│   ├── metrics.ts         # session counters (pure)
│   └── vendor/            # generated gitleaks rules + their MIT license
├── skills/                # skills shipped to users (protect, scan, status, policy, ...)
├── types/index.d.ts       # PluginState contract (vault, counters, rules, scan, pane)
├── scripts/sync-gitleaks.ts  # regenerates hooks/vendor/gitleaks-rules.ts
├── package.json, tsconfig.tools.json  # dev tooling only (Bun types); the mod has no dependencies
├── tests/
│   ├── unit/              # pure functions (claude-code/testing)
│   ├── integration/       # hooks through the engine's dispatch (claude-code/testing)
│   └── e2e/               # real CLI + model: Zellij driver, probe/ test-only mod
└── docs/                  # SECURITY, COMPATIBILITY, TEST_PLAN
```

- `hooks/register.ts` is the only file that touches the engine's `$`; every other module under `hooks/` is pure.
- New detector: one entry in `hooks/detectors.ts` (id, label, groups, default, finder), with HIDE and KEEP cases in `tests/unit/detectors.test.ts`.
- Which tools get original values: the lists in `hooks/defaults.ts`, applied by `hooks/policy.ts`.
- Tunable values (limits, lists, messages) go in `hooks/defaults.ts`, not inline.
- `skills/` is user documentation shipped with the plugin; development skills stay in `.claude/skills/`.
- Never hand-edit `hooks/vendor/`; regenerate it with `scripts/sync-gitleaks.ts`.
- `.claude/skills/` holds agent skills for this repository (verify, extend, e2e, release).

## 🧪 Testing

- Every behavior change needs a unit or integration test; every bug fix needs a regression test.
- New regexes must stay linear-time: add a timing case on large adversarial input.
- Live tests in a real CLI session are described in [docs/TEST_PLAN.md](docs/TEST_PLAN.md). Run them in a clean environment (`env -i`) with synthetic data only.
- Mark a path as covered in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) only after a live test on that surface.

## 🔀 Pull Request Process

1. Branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Use [Conventional Commits](https://www.conventionalcommits.org/) with a [gitmoji](https://gitmoji.dev/) prefix for commit messages and pull request titles: `✨ feat(scan): …`, `🐛 fix(rules): …`, `📝 docs: …`, `🧪 test: …`, `♻️ refactor: …`, `🔧 chore: …`, `🔒 fix(security): …`.
3. Run `bun run check`, `claude plugin test .`, `claude plugin validate .claude-plugin/plugin.json` and `bun run format:check`.
4. Update `docs/CONFIGURATION.md` (options), `docs/DETECTORS.md` (detection), `docs/SECURITY.md` (coverage, findings), `README.md` (overview) and `CHANGELOG.md` when behavior changes.
5. Fill in the pull request template, including the privacy checklist.

## 🚀 Releases

1. Bump `version` in `.claude-plugin/plugin.json` and add a `CHANGELOG.md` section with the same version.
2. Merge to `main`, then push a tag `v<version>`. The release workflow checks that the tag matches the manifest and publishes a GitHub Release from the changelog section.
3. Users who installed from this repository get the new version with `/plugin` → Installed → redact-restore → Update now, or `claude plugin update redact-restore@redact-restore`.
