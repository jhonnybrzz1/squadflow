# Security Policy

## Supported versions

Security fixes are applied to the latest commit on the default branch. Older
commits, local snapshots and generated handoff artifacts are not supported.

## Reporting a vulnerability

Use GitHub private vulnerability reporting from the repository's **Security**
tab. Do not disclose a vulnerability, credential or exploit in a public issue,
pull request, discussion or log.

If private reporting is unavailable, open a public issue containing only a
request for a private contact channel. Do not include technical details or any
secret value.

For a credential exposure, report only:

- the provider or credential type;
- the affected file and commit, when known;
- whether the credential appears active;
- at most the last four characters needed for identification.

Never include the complete credential. Revocation or rotation at the provider
is required even after the value is removed from Git.

## Contributor secret checks

The versioned pre-commit hook runs Gitleaks against staged changes. `npm ci`
configures Git to use `.githooks/` through the package `prepare` script.

Install Gitleaks 8.30.1 or newer before committing, then verify it locally:

```bash
gitleaks version
gitleaks git --pre-commit --staged --redact --no-banner .
```

The hook fails closed when Gitleaks is missing or detects a candidate secret.
Do not bypass it with `--no-verify`. False positives must be reviewed and, when
necessary, suppressed with the narrowest possible fingerprint or inline
justification rather than a broad directory allowlist.
