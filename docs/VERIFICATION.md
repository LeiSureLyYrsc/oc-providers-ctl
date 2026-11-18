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

## Remote CI and native development follow-up

The initial implementation was pushed as `66d1dd6` to `main`. GitHub Actions run `44284569822` completed the Ubuntu core format, Clippy and test job successfully, but all `npm ci` jobs failed because the original lockfile omitted transitive `@emnapi/core` and `@emnapi/runtime` entries required by the clean runner. The failure was identified with `gh run watch --exit-status` and `gh run view --log-failed`; local success was not treated as evidence of clean-install portability.

A separate Windows native smoke launched `npm run tauri dev` with `OC_PROVIDERS_CTL_CONFIG_DIR`, `OC_PROVIDERS_CTL_MANAGED_DIR` and `OC_PROVIDERS_CTL_BACKUP_DIR` pointing into a temporary fixture root. The launch log reached `Running .../target/debug/oc-providers-ctl.exe`; Windows reported a responding `Tauri Window`, a WebView2 child process and a rendered document titled `配置血统台 · OpenCode Providers`. UI Automation found the isolated source path, provider, model and hash, establishing that the native window rendered and its configuration-scan IPC completed, rather than merely showing the browser demo. These checks did not read the real global OpenCode configuration.

The subsequent native edit/save/restore attempt was blocked when the host's C: drive ran out of space; no fixture bytes changed. That round does **not** establish native save/restore E2E. Only this project's generated Rust `target/` cache was moved to `I:\oc-providers-ctl-build\target`, restoring disk headroom without relocating source or user configuration. Future local native checks use a process-local `CARGO_TARGET_DIR` for that cache. The original dense UI was then rejected by the user; its screenshots are historical launch evidence, not acceptance of the redesigned interface.

The clean-install fix was pushed separately as `6fa6b1e`: two missing optional lockfile entries, no new direct dependencies and no disabled lock checks. New Actions run `44286366287` verifies that change independently of the in-progress UI redesign.

Run `44286366287` confirmed clean npm installation and frontend checks, Ubuntu core tests, and Linux desktop compile/unit tests. Windows desktop compilation also passed, but two discovery tests compared raw temporary-path strings: the runner supplied the 8.3 alias `RUNNER~1`, while canonical discovery returned `runneradmin`. Those tests require canonical filesystem-path comparisons; this is not grounds to remove production canonicalization or disable Windows testing.

Commit `160a28b` changes discovery-test comparisons to resolve both paths with `fs::canonicalize`, retaining production behavior. Its focused local discovery suite passed eight tests, including a real Windows short-name alias probe on this host. Actions run `44288600058` checks the fix remotely; a successful local alias probe is not a substitute for that runner result.

## Simplified desktop interface

The replacement interface uses one supplier/model workspace, 16px body text and 44px controls. Configuration details and diagnostics are on demand; saving remains a two-step preview/write operation. Headless Chromium at 1100×760 exercised model editing, a staged context change, preview rendering, disabled demo writes, configuration details and theme switching. An 860×600 check found no document-level horizontal overflow. These checks ran without opening a native window on the user's desktop and do not establish native save/restore E2E.

The redesigned preview response carries its originating path, source hash and draft revision back through the frontend reducer. A reply from an earlier file/revision cannot satisfy a newer pending preview. This supplements the backend's one-shot preview IDs and source-hash verification; neither frontend state nor a successful screenshot is a substitute for those checks.

Final redesigned-frontend checks: `npm ci`, `npm run typecheck`, `npm test` and `npm run build` all exited 0 (76 tests across 10 files, none skipped). A headless Chromium smoke against the emitted `dist/` also exited 0 with no page errors, covering the main/model/edit/save-preview path, disabled demo writes, configuration details, light/dark themes and minimum-width layout. Preview labels come from typed staged edits, not parsing native or demo diff text; raw backend detail remains expandable.

The redesigned interface was pushed as `495e464`. The preceding run `44288600058` passed the Windows path regressions, configuration-editing tests and backup ACL test, then stalled while its mock server wrote an oversized catalog response to a client that had stopped reading. The run was superseded by the next push, not accepted as a success. The test server now bounds socket writes and teardown, stops writing on the first error and rejects incomplete HTTP request headers. A stalled-reader regression checks that subsequent requests still work. The Windows core-test CI step also has a ten-minute limit so a future test hang fails explicitly instead of consuming an unbounded job. Production request caps and assertions remain in place.
