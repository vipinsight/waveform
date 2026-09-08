# Making Waveform public

This checklist is for the repository owner. Repository files do not change
GitHub settings, publish a release, or change visibility by themselves.

## Before changing visibility

- [x] Add the MIT `LICENSE` and matching package metadata.
- [ ] Confirm you have permission to publish contributed code, icons, and other assets.
- [ ] Review all Git history, branches, tags, issues, pull requests, Actions logs,
  and release assets for credentials and personal information. `.gitignore`
  does not remove previously committed files. Use a dedicated history scanner
  such as Gitleaks in addition to manual review; a pattern scan is not proof
  that a repository is free of secrets.
- [ ] If credentials were committed, revoke/rotate them before publication and
  remove sensitive history. Do not rewrite shared history without coordination.
- [ ] Keep `.env.notarization`, Apple certificates, API keys, recordings, and
  the updater private key outside Git. Back up the updater key securely.
- [ ] Review third-party dependency, runtime, model, and artwork licenses. The
  project license does not relicense these. Preserve required notices when
  distributing binaries; do not bundle model weights without checking their terms.
- [ ] Merge the contributor docs and templates; run CI on GitHub successfully.
- [ ] Review the README installation links and test the downloadable app.

## GitHub settings

1. When the checks above are complete, change visibility yourself under repository
   **Settings → General → Danger Zone**. Public Git history can be copied immediately.
2. Enable Issues, add a description and topics such as `macos`, `speech-to-text`,
   `tauri`, and `local-first`, and choose a social preview if desired.
3. Enable [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
   Confirm the reporting link in `SECURITY.md` works.
4. Enable Dependabot alerts, security updates, and available secret scanning/push
   protection. The committed Dependabot file schedules version-update PRs.
5. Protect `main` with a ruleset: require pull requests and the `macOS checks`
   status after its first successful run; block force pushes and deletion.
   For a solo maintainer, do not require approval from a second person until a
   reviewer is available. Avoid bypassing CI for routine changes.
6. Set default Actions permissions to read-only and require approval for outside
   contributors' workflow runs. Never provide release credentials to PR jobs or
   use a self-hosted signing Mac for untrusted pull requests.
7. Create labels used by release notes: `bug`, `enhancement`, `accessibility`,
   `documentation`, `dependencies`, `duplicate`, `invalid`, and `wontfix`.
8. Review a release draft using [Releasing](releasing.md), then publish it.

## Ongoing maintenance

Triage issues, review dependency updates, and label merged PRs. Prefer squash
merges with descriptive titles. GitHub Releases are the changelog; no duplicate
hand-maintained changelog is required. Use `good first issue` only for scoped,
explained tasks suitable for newcomers.
