# Verification evidence path

The goal is a usable first desktop version, not a claim that all OpenCode versions or Linux distributions have been certified. Test fixtures must be isolated from the user's real configuration and credentials.

| Claim | Owner | Minimum evidence |
| --- | --- | --- |
| V1/V2 entries retain their format; unsupported nested mixing is rejected | Rust config core | Fixture tests for both shapes, valid top-level coexistence, invalid nested mixing and ambiguous inputs |
| Editing does not damage unrelated configuration | Rust config core | Byte-preservation tests for comments, trailing commas, unknown keys, CRLF/BOM, insertion/removal and duplicate keys |
| Saving and restoration do not clobber external edits | Rust config core | Temporary-directory tests for source hash conflicts, successful backup/restore, stale restore and failure paths |
| Sanitized DTOs and previews do not leak credentials | Rust core + shell | Inline/env/file/header fixtures and checks that frontend results/errors contain no secret markers |
| Metadata matches are suggestions rather than ID rewrites | Catalog + frontend | Exact/canonical/fuzzy ranking tests with separator and version collisions; stage only explicit user choices |
| Inventory never generates inference or leaks redirect credentials | Network core | Local mock HTTP tests for GET-only inventory, auth errors, redirect policy, response limits and unsafe URLs |
| The UI stages changes, shows the target and only saves a valid preview | Frontend | Deterministic edit/IPC tests; build/typecheck; browser demo never invokes disk save |
| Native commands are restricted to authorized sources | Tauri shell | Compile check plus path/command scope inspection; invalid path/preview rejection tests where available |
| Release assets are installable on supported systems | Release validation | Windows 11 and Ubuntu 22.04/24.04 install/start/scan-a-fixture smoke tests; checksums and artifact list |

## Check layers

1. Focused tests run by each implementation lane in its own scope.
2. After reconciling all writers, run frontend typecheck/tests/build, Rust format/core tests/Clippy and desktop compilation once against the final tree.
3. Inspect all failure excerpts before making repairs. Rerun only checks invalidated by those repairs, plus mandatory release checks.
4. Record exact commands, exit statuses and limitations in the delivery summary. A build or a mocked UI test is not evidence that a native installation was exercised.

## Manual release smoke scenario

Use a throwaway home/config root or an explicit fixture, never the user's only configuration copy:

1. Launch the installed application and verify its native window and empty state.
2. Load V1 and V2 fixtures containing comments and an environment credential reference.
3. Change one context limit; inspect the target path and preview; save and compare unrelated bytes.
4. Edit the file externally after preparing a preview; confirm saving is rejected.
5. Restore a backup and confirm the original content returns; verify that a stale restore is rejected.
6. Search a synthetic proxy model ID, inspect candidates, and confirm metadata adoption does not rename the request ID.
7. List models from an isolated local HTTP fixture. Confirm no chat/completion endpoint was contacted and no key appears in UI/errors.
8. Disconnect the network and confirm cached catalog behavior is explicit.

Do not mark this scenario passed unless it was actually run on the named OS and installed artifact.

## Initial Windows development validation

The development tree was checked on Windows x64 with Rust 1.100.0 and Node.js 24.11.1. These are development checks, not an installed-artifact certification.

- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`: exit 0; 62 frontend tests across 8 files.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: exit 0.
- Final `cargo fmt --all -- --check` and `cargo test -p oc-providers-core --locked`: exit 0; 62 core tests reported passed, one optional live-network test ignored. One reported-passed symlink test explicitly skips its commit-time swap branch on this Windows host, as noted below.
- `cargo test -p oc-providers-ctl --lib --locked`: exit 0; 8 authorization/preview lifecycle tests, no native window needed.
- Configuration fixtures exercised discovery, V1/V2 keyed model edits, BOM/CRLF/comments, stale saves/restores, URL secret redaction and Windows backup ACLs. Windows symlink creation was unavailable (error 1314); that test's commit-time swap branch was explicitly skipped rather than claimed as exercised.
- Headless Chromium exercised all five views, V1/V2 draft preview, disabled demo disk writes, source-switch preview invalidation and an 1100px desktop viewport. No page errors were observed. This browser run does not exercise real Tauri IPC or a native installation.
- The public models.dev smoke check succeeded separately; deterministic tests use local HTTP fixtures, not paid provider endpoints.

An initial combined core run exposed an intermittent local mock-HTTP connection failure. The mock server was corrected to retain queued responses for incomplete/aborted connections and to handle accepted socket modes explicitly. Production inventory requests did not receive retries or weaker assertions to hide the failure. The focused network tests and four subsequent full-core runs passed during diagnosis; final reconciled-tree results are reported with the delivery.

No real OpenCode configuration was modified. Linux checks and installation smoke tests remain for CI/release validation. Full source precedence and runtime model availability are not proven by this initial version.
