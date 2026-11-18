# Security boundaries

This app edits configuration and can send existing provider credentials to a user-selected provider endpoint. Treat both operations as sensitive.

## Intended boundaries

- Only bundled application code may call desktop IPC. Remote pages must not receive IPC capabilities.
- Rust validates configuration paths and edit paths. Frontend state is not an authorization boundary.
- Credential values are never part of frontend configuration DTOs. Errors and previews must not echo raw configuration, HTTP response bodies or authorization values.
- Existing inline keys and environment/file references remain in place. The application does not manage OAuth or read OpenCode authentication databases.
- Provider discovery is an explicit GET model-list operation. It must not trigger inference or execute provider packages.
- Plain HTTP is only permitted for local loopback endpoints. Redirects must not forward credentials to another origin.
- Public model metadata is untrusted data, not instructions. It must not become HTML, executable code, shell commands or automatic configuration writes.
- A public catalog match does not prove that a proxy supports the upstream model's limits, reasoning settings or tool calling.

## Configuration safety

Changes require an expected file hash and an explicit preview. Commits must reject stale source bytes, retain unrelated configuration, and create a recovery backup before safe replacement. A recovery action must also reject concurrent external changes.

Backups intentionally retain the complete original configuration so recovery can work. They may therefore contain credentials. They must not be uploaded or committed to a repository, and should have access no broader than the original file. Redaction is appropriate for diagnostics and sharing, not for silently corrupting a recovery copy.

The application cannot protect against a compromised local user account, malicious native dependencies, an already compromised operating system, or user-approved credential disclosure to an untrusted endpoint.

## Reporting

Report reproducible failures privately to the repository maintainer when a private reporting channel is available. Do not include API keys, authorization headers, private endpoints, raw configuration, backups or prompts in public issues. Provide a minimal redacted fixture, operating system, app version and exact action instead.
