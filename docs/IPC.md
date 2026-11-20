# Desktop boundary contract

All IPC names below are snake_case; DTO fields use camelCase. The bundled UI is the only permitted caller. Network and filesystem access live in Rust. No authentication database access or OpenCode service startup is required.

## Commands

- `scan_configs({ projectPath: string | null }) -> WorkspaceSnapshot`
- `pick_config_path() -> string | null` (native dialog registers the selected canonical configuration path; cancel returns null)
- `load_config({ path: string }) -> SourceDocument` (only previously scanned or native-picker-authorized OpenCode JSON/JSONC paths)
- `preview_changes({ path: string, expectedHash: string, edits: Edit[] }) -> ChangePreview`
- `apply_changes({ previewId: string }) -> SourceDocument`
- `restore_backup({ path: string, expectedHash: string }) -> SourceDocument` (restore the last backup created by this process; reject external changes)
- `fetch_catalog() -> CatalogResult`
- `match_models({ query: string, providerId: string | null }) -> ModelCandidate[]` (local catalog search; no remote query)
- `fetch_provider_models({ path: string, providerId: string }) -> ProviderInventory` (explicit action; uses existing references in Rust memory only)

Errors are safe user-facing strings, never raw file contents, HTTP bodies, authorization headers or credentials. The frontend must handle ordinary browser preview mode with an explicit demo banner and must never pretend demo mutations were saved to disk.

## DTOs (TypeScript notation)

```ts
type Dialect = 'v1' | 'v2' | 'ambiguous' | 'mixed' | 'invalid';
type WorkspaceSnapshot = { sources: SourceDocument[]; warnings: string[]; projectPath: string | null };
type SourceDocument = {
  path: string; hash: string; dialect: Dialect; writable: boolean;
  warnings: string[]; providers: ProviderEntry[];
  defaultModel: string | null;
};
type ProviderEntry = {
  id: string; name: string | null; dialect: Dialect;
  baseUrl: string | null; credentialStatus: 'reference' | 'inline' | 'none';
  models: ModelEntry[];
};
type ModelEntry = {
  id: string; requestId: string | null; name: string | null;
  context: number | null; input: number | null; output: number | null;
  reasoning: unknown | null; variants: unknown | null;
};
type Edit = { op: 'set' | 'remove'; path: string[]; value?: unknown };
type ChangePreview = { previewId: string; path: string; diff: string; warnings: string[]; editCount: number };
type CatalogResult = { modelCount: number; fetchedAt: string; stale: boolean; warnings: string[] };
type ModelCandidate = {
  providerId: string; id: string; name: string; canonicalId: string | null;
  context: number | null; input: number | null; output: number | null;
  reasoning: unknown | null; score: number; matchReason: string;
};
type ProviderInventory = { providerId: string; modelIds: string[]; fetchedAt: string; warnings: string[] };
```

## Rust core API consumed by the desktop shell

Crate `oc_providers_core` exports the DTOs above using serde camelCase and these functions:

```rust
pub fn read_document(path: &std::path::Path) -> Result<SourceDocument, String>;
pub fn discover_configs(project: Option<&std::path::Path>) -> WorkspaceSnapshot;
pub fn prepare_changes(path: &std::path::Path, expected_hash: &str, edits: &[Edit]) -> Result<PreparedChange, String>;
pub fn commit_changes(change: &PreparedChange) -> Result<SourceDocument, String>;
pub fn restore_last_backup(path: &std::path::Path, expected_hash: &str) -> Result<SourceDocument, String>;
pub struct PreparedChange { pub preview: ChangePreview, /* private source bytes and replacement */ }
pub struct ModelCatalog { /* cache, no secrets */ }
impl ModelCatalog {
  pub fn new(cache_dir: std::path::PathBuf) -> Self;
  pub async fn refresh(&mut self) -> Result<CatalogResult, String>;
  pub fn search(&self, query: &str, provider_id: Option<&str>) -> Vec<ModelCandidate>;
}
pub async fn fetch_inventory(path: &std::path::Path, provider_id: &str) -> Result<ProviderInventory, String>;
```

`restore_last_backup` must only restore backups made by this app, with external-change checks; the shell also restricts restoration to files successfully committed in this process. Catalog methods are isolated from user configuration. The shell owns preview IDs and restricts writes/network credentials to sources explicitly discovered or loaded by the app. All core blocking filesystem work is dispatched away from the UI thread.

## Editing rules

V1 top-level `provider`, provider `npm`/`api`/`options`, model `id` and variants object. V2 `providers`, provider `package`/`settings.baseURL`, model `modelID`, `capabilities.reasoning` and variants array. **Both versions store `models` as an object keyed by selectable catalog ID, not an array.** The DTO `ModelEntry.id` is that key; `requestId` is the optional V1 `id` / V2 `modelID` override sent upstream. V2 reasoning suggestions are normalized objects (`supported`, optional `toggle`, `effort` string array and `budget` bounds), not bare booleans. Preserve the original nested entry dialect; do not migrate it. Valid top-level coexistence is not itself malformed. Ambiguous/new documents require an explicit format choice via creating the corresponding provider map. Invalid or unsafe nested mixtures are read-only.

Reasoning metadata describes model capabilities, not default request settings. V2 controls expose support, whether reasoning can be turned off, available effort labels, and optional minimum/maximum thinking-token budgets. OpenCode ignores the budget when effort labels are set; existing combined metadata must not be silently discarded. V1 retains its boolean support flag and is not automatically migrated or given generated variants. Token limits and budgets are non-negative integers, and budget minimum must not exceed maximum.

Catalog lookup uses the existing models.dev download/cache and local search. Candidate values remain unverified suggestions: only explicitly selected fields may be adopted, existing non-empty values require explicit replacement, and missing candidate values must not clear configuration. A support flag must not invent effort labels. Adoption never changes selectable/request model IDs or creates variants; all configuration changes still require staging and an explicit preview/write.

Only provider/model/default-model paths can be edited. Existing credentials and unrelated configuration must remain byte-for-byte unchanged outside edited ranges. Credential fields are not editable in this version. Whole existing provider replacement is forbidden; creation and explicit deletion are allowed. Secret-bearing arrays/objects cannot be blindly replaced with redacted DTO values. Preview diffs must mask secrets (including removed blocks); a redacted semantic change summary is preferable to exposing raw surrounding lines. JSONC comments, trailing commas, indentation, BOM and line endings are preserved when possible; reject a change that cannot be represented safely. Safe write includes a hash check, restrictive backup, temporary sibling and platform-safe replacement. A batch targets one file with at most 64 edits. Frontend preview state must be bound to the target path, source hash and draft revision; late results must not authorize a different or newer draft.

Provider inventory supports known OpenAI-compatible **and Anthropic** model-list routes, with no guessing for unsupported protocols. Package names are matched exactly against a fixed whitelist; the authoritative list, including which `.../chat` and `.../responses` variants exist and which do not, is the table in [config-editing.md](config-editing.md) rather than a restatement here - not every family has every variant. An entry that declares no package falls back to the exact built-in ids `openai`, `openrouter`, `xai` and `anthropic`; any other name is rejected rather than guessed. A compatible-gateway entry without a baseURL is rejected *before* the request is constructed, regardless of whether that gateway implements `/models`. Resolve only existing explicit apiKey/env/file references after user invokes the command. No OAuth database reads. Provider endpoints may use HTTP or HTTPS, including remote HTTP; HTTP requests can transmit credentials in plaintext and must carry a user-visible warning. Reject redirects, URL credentials, credential-like query parameters, fragments and non-HTTP(S) schemes. Retain request timeouts and response-size limits. Only the first page of a model list is fetched; truncation signals are surfaced as warnings and never paginated through. The public catalog's separate HTTPS policy is unchanged. No inference calls.
