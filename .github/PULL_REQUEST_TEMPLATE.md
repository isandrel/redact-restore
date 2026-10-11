## 📝 Description

<!-- What does this PR change, and why? -->

## 🔗 Related Issue

Closes #

## 🏷️ Type of Change

- [ ] ✨ Feature
- [ ] 🐛 Bug fix
- [ ] 🔎 Detector (new rule, validator, or false-positive fix)
- [ ] 🔒 Security or privacy fix
- [ ] 📝 Documentation
- [ ] ♻️ Refactor (no behavior change)
- [ ] ✅ Tests
- [ ] 🔧 Chore (tooling, dependencies, CI)

## 🔐 Privacy Checklist

- [ ] Only synthetic values appear in code, tests, docs, screenshots and commit messages
- [ ] No new path lets an original value reach the model API, a log, a toast, the status line or the status file
- [ ] New failure paths fail closed (mask without recording, withhold, or refuse)
- [ ] Restoration changes keep model-bound and remote tools on placeholders

## 🧪 Testing

- [ ] `bun run check`
- [ ] `claude plugin test .`
- [ ] `claude plugin validate .claude-plugin/plugin.json`
- [ ] `bun run format:check`
- [ ] Live test in the CLI (`docs/TEST_PLAN.md`)
- [ ] Live test in Desktop Code

## ✅ Checklist

- [ ] Tests added or updated (a regression test for every bug fix)
- [ ] `docs/CONFIGURATION.md`, `docs/DETECTORS.md`, `docs/SECURITY.md`, `docs/COMPATIBILITY.md`, `README.md` and `CHANGELOG.md` updated where behavior changed
- [ ] Conventional Commit messages with a gitmoji prefix (`✨ feat: …`)

## 📋 Additional Notes

<!-- Known limitations, follow-ups, or anything reviewers should look at first. -->
