//! Public models.dev catalog cache and local model search.
//!
//! The catalog is intentionally independent from user configuration. It only
//! stores public metadata (provider/model identifiers, display names, limits
//! and a boolean capability suggestion). No credential or configuration values
//! are read or written here.
//!
//! Capability hinting: `ModelCandidate::reasoning` is normalised to the public
//! V2 reasoning shape `{ supported, toggle?, effort?, budget? }`. It is a
//! *suggestion* copied from public metadata, not proof that the model/provider
//! actually supports reasoning at runtime. Only allow-listed types and bounded
//! values are emitted; arbitrary catalog JSON is never forwarded.

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use reqwest::header::{ACCEPT, ETAG, IF_NONE_MATCH};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;
use uuid::Uuid;

/// Stable public endpoint used by `ModelCatalog::new`.
pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";

/// Fixed cache file name inside the caller-provided cache directory.
const CACHE_FILE_NAME: &str = "models-dev-public-catalog.v2.json";
const CACHE_VERSION: u8 = 2;
const CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
const RESPONSE_MAX_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PROVIDERS: usize = 4_096;
const MAX_MODELS: usize = 250_000;
const MAX_SEARCH_RESULTS: usize = 20;
const MIN_FUZZY_SCORE: f64 = 0.68;
const MIN_SHORT_QUERY_SCORE: f64 = 0.82;
const MAX_FUZZY_SCORE: f64 = 0.82;

/// Result of refreshing the public catalog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResult {
    pub model_count: usize,
    pub fetched_at: String,
    pub stale: bool,
    pub warnings: Vec<String>,
}

/// A single local search hit. `id` is always the provider's catalogue ID verbatim;
/// `canonical_id` is reported separately and is never used to rewrite `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    pub provider_id: String,
    pub id: String,
    pub name: String,
    pub canonical_id: Option<String>,
    pub context: Option<u64>,
    pub input: Option<u64>,
    pub output: Option<u64>,
    /// Normalised V2 reasoning suggestion, never raw catalog JSON.
    pub reasoning: Option<Value>,
    pub score: f64,
    pub match_reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Catalog {
    providers: Vec<CatalogProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CatalogProvider {
    id: String,
    #[serde(default)]
    name: Option<String>,
    models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CatalogModel {
    id: String,
    name: String,
    #[serde(default)]
    canonical_id: Option<String>,
    #[serde(default)]
    context: Option<u64>,
    #[serde(default)]
    input: Option<u64>,
    #[serde(default)]
    output: Option<u64>,
    #[serde(default)]
    reasoning: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheEnvelope {
    version: u8,
    #[serde(default)]
    etag: Option<String>,
    fetched_at: String,
    #[serde(default)]
    providers: Vec<CatalogProvider>,
}

/// Cached public catalog plus a small in-memory search index.
///
/// `new` reads only the fixed cache file under `cache_dir`. It never touches
/// OpenCode configuration or credential stores.
pub struct ModelCatalog {
    cache_dir: PathBuf,
    source_url: String,
    catalog: Option<Catalog>,
    etag: Option<String>,
    fetched_at: Option<String>,
}

impl ModelCatalog {
    /// Create a catalog backed by the stable models.dev endpoint and an
    /// application-owned cache directory.
    pub fn new(cache_dir: PathBuf) -> Self {
        Self::with_source(cache_dir, MODELS_DEV_URL)
    }

    /// Create a catalog with an alternate public source URL.
    ///
    /// This exists so tests and embedders can use a local fixture server. The
    /// source still has to satisfy the public-catalog URL policy in
    /// [`ModelCatalog::refresh`].
    pub fn with_source(cache_dir: PathBuf, source_url: impl Into<String>) -> Self {
        let source_url = source_url.into();
        let (catalog, etag, fetched_at) = load_cache(&cache_dir).unwrap_or_default();
        Self {
            cache_dir,
            source_url,
            catalog,
            etag,
            fetched_at,
        }
    }

    /// Refresh the catalog from the network, falling back to the last cached
    /// public metadata when the service is unavailable or returns an unusable
    /// response.
    ///
    /// A `304 Not Modified` response reuses the cached catalog but updates
    /// `fetchedAt`. When no cache exists and the remote fetch fails, a safe
    /// string error is returned. HTTP bodies and headers are never copied into
    /// errors.
    pub async fn refresh(&mut self) -> Result<CatalogResult, String> {
        let source = parse_source_url(&self.source_url)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "Could not initialize the catalog HTTP client.".to_string())?;

        let mut request = client
            .get(source)
            .header(ACCEPT, "application/json")
            .header("User-Agent", "oc-providers-ctl");

        if self.catalog.is_some() {
            if let Some(etag) = self.etag.as_deref().filter(|value| !value.is_empty()) {
                request = request.header(IF_NONE_MATCH, etag);
            }
        }

        let mut response = match request.send().await {
            Ok(response) => response,
            Err(_) => return self.stale_or_error("Catalog service is unreachable."),
        };
        let status = response.status();

        if status == StatusCode::NOT_MODIFIED {
            let Some(catalog) = self.catalog.as_ref() else {
                // Defensive: conditional requests are only sent with a loaded
                // catalog, but a cache can be raced/removed externally.
                return Err("Catalog cache is unavailable; retry the refresh.".to_string());
            };
            let fetched_at = now_string();
            let model_count = catalog.model_count();
            self.persist_cache(catalog, &fetched_at);
            self.fetched_at = Some(fetched_at.clone());
            return Ok(CatalogResult {
                model_count,
                fetched_at,
                stale: false,
                warnings: Vec::new(),
            });
        }

        if status.is_redirection() {
            return self
                .stale_or_error("Catalog service returned a redirect, which was not followed.");
        }
        if !status.is_success() {
            return self.stale_or_error(&format!(
                "Catalog service returned HTTP {}.",
                status.as_u16()
            ));
        }

        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let bytes = match read_capped_body(&mut response, RESPONSE_MAX_BYTES).await {
            Ok(bytes) => bytes,
            Err(reason) => return self.stale_or_error(&reason),
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return self.stale_or_error("Catalog response is not valid JSON."),
        };

        let parsed = match parse_catalog(&value) {
            Ok(parsed) => parsed,
            Err(message) => return self.stale_or_error(&message),
        };

        let fetched_at = now_string();
        let mut warnings = parsed.warnings;
        let model_count = parsed.catalog.model_count();
        self.catalog = Some(parsed.catalog);
        self.etag = etag;
        self.fetched_at = Some(fetched_at.clone());

        if let Some(catalog) = self.catalog.as_ref() {
            if let Err(reason) = self.try_persist_cache(catalog, &fetched_at) {
                warnings.push(reason);
            }
        }

        Ok(CatalogResult {
            model_count,
            fetched_at,
            stale: false,
            warnings,
        })
    }

    /// Search the in-memory catalog. This never performs a network request.
    ///
    /// Ranking tiers are deterministic:
    /// 1. exact `provider/id` reference and exact model ID (case-sensitive);
    /// 2. exact canonical ID (case-sensitive) and exact provider ID;
    /// 3. case-insensitive ID/canonical matches;
    /// 4. bounded fuzzy ID/name matches.
    ///
    /// Fuzzy comparison uses the full identifiers, including separators and
    /// version/date fragments. IDs are never rewritten or normalised before
    /// being compared, and the returned `id` is always the source identifier.
    pub fn search(&self, query: &str, provider_id: Option<&str>) -> Vec<ModelCandidate> {
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        let Some(catalog) = self.catalog.as_ref() else {
            return Vec::new();
        };

        let provider_filter = provider_id.map(str::trim).filter(|value| !value.is_empty());

        let mut cross_provider_note: Option<String> = None;
        let scoped_providers: Vec<&CatalogProvider> = if let Some(filter) = provider_filter {
            let exact: Vec<_> = catalog
                .providers
                .iter()
                .filter(|provider| provider.id == filter)
                .collect();
            if !exact.is_empty() {
                exact
            } else {
                let case_insensitive: Vec<_> = catalog
                    .providers
                    .iter()
                    .filter(|provider| provider.id.eq_ignore_ascii_case(filter))
                    .collect();
                if case_insensitive.is_empty() {
                    // A custom provider need not be present in the public
                    // catalog. Keep the search useful, but label every result
                    // as a cross-provider suggestion instead of silently
                    // returning nothing or pretending the filter matched.
                    cross_provider_note = Some(format!(
                        "Provider '{}' is not in the public catalog; showing cross-provider suggestions.",
                        safe_label(filter)
                    ));
                    catalog.providers.iter().collect()
                } else {
                    case_insensitive
                }
            }
        } else {
            catalog.providers.iter().collect()
        };

        if scoped_providers.is_empty() {
            return Vec::new();
        }

        let query_lower = query.to_lowercase();
        let query_chars = query.chars().count();
        let fuzzy_threshold = if query_chars <= 3 {
            MIN_SHORT_QUERY_SCORE
        } else {
            MIN_FUZZY_SCORE
        };

        let mut candidates = Vec::new();

        for provider in scoped_providers {
            let provider_exact = provider.id == query;
            let provider_ci = provider.id.eq_ignore_ascii_case(query);

            for model in &provider.models {
                let combined_reference = format!("{}/{}", provider.id, model.id);
                let id_lower = model.id.to_lowercase();
                let name_lower = model.name.to_lowercase();
                let canonical_exact = model.canonical_id.as_deref() == Some(query);
                let canonical_ci = model
                    .canonical_id
                    .as_deref()
                    .is_some_and(|canonical| canonical.eq_ignore_ascii_case(query));

                let (score, reason) = if combined_reference == query {
                    (1.0, "Exact provider/model reference match")
                } else if model.id == query {
                    (0.995, "Exact model ID match")
                } else if provider_exact {
                    (0.97, "Provider ID match")
                } else if canonical_exact {
                    (0.95, "Exact canonical model ID match")
                } else if provider_ci {
                    (0.90, "Provider ID matches ignoring case")
                } else if model.id.eq_ignore_ascii_case(query) {
                    (0.88, "Model ID matches ignoring case")
                } else if canonical_ci {
                    (0.84, "Canonical ID matches ignoring case")
                } else {
                    let id_score = strsim::jaro_winkler(&query_lower, &id_lower);
                    let name_score = if model.name.is_empty() || name_lower == id_lower {
                        0.0
                    } else {
                        strsim::jaro_winkler(&query_lower, &name_lower)
                    };

                    let (mut fuzzy_score, mut fuzzy_reason) = if id_score >= name_score {
                        (id_score, "Close model ID match")
                    } else {
                        (name_score, "Close model name match")
                    };

                    if query_chars >= 2 && id_lower.starts_with(&query_lower) {
                        let prefix_score = if query_chars <= 3 { 0.80 } else { 0.81 };
                        if prefix_score > fuzzy_score {
                            fuzzy_score = prefix_score;
                            fuzzy_reason = "Model ID starts with the query";
                        }
                    }

                    fuzzy_score = fuzzy_score.min(MAX_FUZZY_SCORE);
                    if fuzzy_score < fuzzy_threshold {
                        continue;
                    }
                    (fuzzy_score, fuzzy_reason)
                };

                let match_reason = match cross_provider_note.as_deref() {
                    Some(note) => format!("{note} {reason}"),
                    None => reason.to_string(),
                };
                candidates.push(ModelCandidate {
                    provider_id: provider.id.clone(),
                    id: model.id.clone(),
                    name: model.name.clone(),
                    canonical_id: model.canonical_id.clone(),
                    context: model.context,
                    input: model.input,
                    output: model.output,
                    reasoning: model.reasoning.clone(),
                    score: round_score(score),
                    match_reason,
                });
            }
        }

        candidates.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.provider_id.cmp(&right.provider_id))
                .then_with(|| left.id.cmp(&right.id))
        });
        candidates.truncate(MAX_SEARCH_RESULTS);
        candidates
    }

    fn persist_cache(&self, catalog: &Catalog, fetched_at: &str) {
        let _ = self.try_persist_cache(catalog, fetched_at);
    }

    fn try_persist_cache(&self, catalog: &Catalog, fetched_at: &str) -> Result<(), String> {
        let envelope = CacheEnvelope {
            version: CACHE_VERSION,
            etag: self.etag.clone(),
            fetched_at: fetched_at.to_string(),
            providers: catalog.providers.clone(),
        };
        let bytes = serde_json::to_vec(&envelope)
            .map_err(|_| "Catalog cache could not be serialized.".to_string())?;
        if bytes.len() > CACHE_MAX_BYTES {
            return Err("Catalog metadata is too large to cache safely.".to_string());
        }

        fs::create_dir_all(&self.cache_dir)
            .map_err(|_| "Catalog cache directory could not be created.".to_string())?;
        let target = self.cache_dir.join(CACHE_FILE_NAME);
        let temporary = self
            .cache_dir
            .join(format!(".{CACHE_FILE_NAME}.{}.tmp", Uuid::new_v4()));
        fs::write(&temporary, &bytes)
            .map_err(|_| "Catalog cache could not be written.".to_string())?;
        if let Err(error) = fs::rename(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "Catalog cache could not be replaced ({}).",
                error.kind()
            ));
        }
        Ok(())
    }

    /// Return a stale result using the cached catalog, or a safe error if no
    /// cached metadata is available.
    fn stale_or_error(&self, reason: &str) -> Result<CatalogResult, String> {
        if let Some(catalog) = self.catalog.as_ref() {
            let fetched_at = self
                .fetched_at
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            return Ok(CatalogResult {
                model_count: catalog.model_count(),
                fetched_at,
                stale: true,
                warnings: vec![format!(
                    "{reason} Showing the last cached catalog metadata."
                )],
            });
        }
        Err(format!(
            "{reason} No cached catalog is available, so model suggestions are unavailable."
        ))
    }
}

impl Catalog {
    fn model_count(&self) -> usize {
        self.providers
            .iter()
            .map(|provider| provider.models.len())
            .sum()
    }
}

struct ParsedCatalog {
    catalog: Catalog,
    warnings: Vec<String>,
}

fn parse_catalog(value: &Value) -> Result<ParsedCatalog, String> {
    let map = value
        .as_object()
        .ok_or_else(|| "Catalog response is not a JSON object.".to_string())?;

    let mut providers = Vec::new();
    let mut skipped_entries = 0usize;
    let mut model_count = 0usize;
    let mut truncated = false;

    'providers: for (provider_key, provider_value) in map {
        if providers.len() >= MAX_PROVIDERS || model_count >= MAX_MODELS {
            truncated = true;
            break;
        }

        // A provider entry is recognised structurally, not by an assumed
        // list of "meta" keys: it must be an object with a `models` object.
        // This keeps parsing tolerant of future top-level metadata while
        // still refusing arbitrary scalar entries.
        let Some(provider_object) = provider_value.as_object() else {
            skipped_entries += 1;
            continue;
        };
        let Some(models_object) = provider_object.get("models").and_then(Value::as_object) else {
            skipped_entries += 1;
            continue;
        };
        if provider_key.trim().is_empty() {
            skipped_entries += 1;
            continue;
        }

        let name = provider_object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned);

        let mut models = Vec::new();
        for (model_key, model_value) in models_object {
            if model_count >= MAX_MODELS {
                truncated = true;
                break 'providers;
            }
            if model_key.trim().is_empty() {
                continue;
            }
            let Some(model_object) = model_value.as_object() else {
                continue;
            };
            let Some(model) = parse_model(model_key, model_object) else {
                continue;
            };
            model_count += 1;
            models.push(model);
        }

        providers.push(CatalogProvider {
            id: provider_key.clone(),
            name,
            models,
        });
    }

    if providers.is_empty() {
        return Err(
            "Catalog response contained no structurally valid provider entries.".to_string(),
        );
    }

    let model_count = providers
        .iter()
        .map(|provider| provider.models.len())
        .sum::<usize>();
    if model_count == 0 {
        return Err("Catalog response contained no usable model entries.".to_string());
    }

    let mut warnings = Vec::new();
    if skipped_entries > 0 {
        warnings.push(format!(
            "Ignored {skipped_entries} unrecognized catalog entries that did not look like providers."
        ));
    }
    if truncated {
        warnings.push(format!(
            "Catalog metadata exceeded the {MAX_PROVIDERS} provider / {MAX_MODELS} model safety limit and was truncated."
        ));
    }

    Ok(ParsedCatalog {
        catalog: Catalog { providers },
        warnings,
    })
}

fn parse_model(model_key: &str, object: &Map<String, Value>) -> Option<CatalogModel> {
    // The real models.dev field is `canonical_model_id` (for example
    // `openai/gpt-5.4`). Never invent a canonical identity from the model's
    // declared `id`; the map key remains the request ID either way.
    let canonical_id = ["canonical_model_id", "canonicalModelId"]
        .into_iter()
        .find_map(|key| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && *value != model_key)
                .map(ToOwned::to_owned)
        });

    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(model_key)
        .to_string();

    let limits = object.get("limit").and_then(Value::as_object);
    let context = limits
        .and_then(|limits| limits.get("context"))
        .and_then(as_u64);
    let input = limits
        .and_then(|limits| limits.get("input"))
        .and_then(as_u64);
    let output = limits
        .and_then(|limits| limits.get("output"))
        .and_then(as_u64);

    // Normalise to the documented V2 reasoning shape. Unknown option types,
    // out-of-range numbers and arbitrary JSON are dropped.
    let reasoning = normalize_reasoning(object);

    Some(CatalogModel {
        id: model_key.to_string(),
        name,
        canonical_id,
        context,
        input,
        output,
        reasoning,
    })
}

const ALLOWED_REASONING_EFFORT: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "default",
];
const MAX_REASONING_EFFORT_VALUES: usize = 12;
const MAX_REASONING_TOKENS: u64 = 1_000_000_000;

#[derive(Default)]
struct ReasoningInfo {
    supported: Option<bool>,
    toggle: bool,
    effort: Vec<String>,
    budget_min: Option<u64>,
    budget_max: Option<u64>,
}

/// Normalise models.dev reasoning metadata to the documented V2 shape:
/// `{ supported, toggle?, effort?, budget? }`.
///
/// `reasoning_options` is the authoritative source for effort/toggle/budget
/// controls (array or a single object). A model-level `capabilities.reasoning`
/// object is also accepted. Unknown option types, unknown effort labels,
/// non-numeric token values and values above safety limits are dropped.
fn normalize_reasoning(object: &Map<String, Value>) -> Option<Value> {
    let mut info = ReasoningInfo::default();
    let mut saw_reasoning = false;

    if let Some(value) = object.get("reasoning") {
        if reasoning_bool(value).is_some() || value.is_object() {
            apply_reasoning_value(value, &mut info);
            saw_reasoning = true;
        }
    }

    if let Some(capabilities) = object.get("capabilities").and_then(Value::as_object) {
        if let Some(value) = capabilities.get("reasoning") {
            if reasoning_bool(value).is_some() || value.is_object() {
                apply_reasoning_value(value, &mut info);
                saw_reasoning = true;
            }
        }
    }

    if let Some(options) = object.get("reasoning_options") {
        if apply_reasoning_options(options, &mut info) {
            saw_reasoning = true;
        }
    }

    if !saw_reasoning {
        return None;
    }

    let supported = info.supported.unwrap_or(true);
    let mut result = Map::new();
    result.insert("supported".to_string(), Value::Bool(supported));
    if info.toggle {
        result.insert("toggle".to_string(), Value::Bool(true));
    }
    if !info.effort.is_empty() {
        result.insert(
            "effort".to_string(),
            Value::Array(info.effort.into_iter().map(Value::String).collect()),
        );
    }
    if info.budget_min.is_some() || info.budget_max.is_some() {
        let mut budget = Map::new();
        if let Some(min) = info.budget_min {
            budget.insert("min".to_string(), Value::Number(min.into()));
        }
        if let Some(max) = info.budget_max {
            budget.insert("max".to_string(), Value::Number(max.into()));
        }
        result.insert("budget".to_string(), Value::Object(budget));
    }

    Some(Value::Object(result))
}

fn apply_reasoning_value(value: &Value, info: &mut ReasoningInfo) {
    if let Some(supported) = reasoning_bool(value) {
        info.supported = Some(supported);
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };
    if let Some(supported) = object.get("supported").and_then(reasoning_bool) {
        info.supported = Some(supported);
    }
    if let Some(toggle) = object.get("toggle").and_then(reasoning_bool) {
        info.toggle = toggle;
    }
    if let Some(effort) = object.get("effort").and_then(Value::as_array) {
        let values = collect_effort(effort);
        if !values.is_empty() {
            info.effort = values;
        }
    }
    if let Some(budget) = object.get("budget").and_then(Value::as_object) {
        apply_budget(budget, info);
    }
}

fn apply_reasoning_options(value: &Value, info: &mut ReasoningInfo) -> bool {
    match value {
        Value::Array(options) => {
            let mut recognized = false;
            for option in options {
                recognized |= apply_single_reasoning_option(option, info);
            }
            recognized
        }
        Value::Object(_) => apply_single_reasoning_option(value, info),
        _ => false,
    }
}

fn apply_single_reasoning_option(value: &Value, info: &mut ReasoningInfo) -> bool {
    let Some(option) = value.as_object() else {
        return false;
    };
    let Some(kind) = option.get("type").and_then(Value::as_str) else {
        return false;
    };
    match kind {
        "toggle" => {
            info.toggle = true;
            true
        }
        "effort" => {
            let Some(values) = option.get("values").and_then(Value::as_array) else {
                return false;
            };
            let effort = collect_effort(values);
            if effort.is_empty() {
                return false;
            }
            info.effort = effort;
            true
        }
        "budget_tokens" => {
            apply_budget(option, info);
            info.budget_min.is_some() || info.budget_max.is_some()
        }
        _ => false,
    }
}

fn apply_budget(object: &Map<String, Value>, info: &mut ReasoningInfo) {
    let min = object
        .get("min")
        .and_then(as_u64)
        .filter(is_safe_token_count);
    let max = object
        .get("max")
        .and_then(as_u64)
        .filter(is_safe_token_count);
    match (min, max) {
        (Some(min), Some(max)) if min > max => {
            info.budget_min = None;
            info.budget_max = None;
        }
        (min, max) => {
            info.budget_min = min;
            info.budget_max = max;
        }
    }
}

fn collect_effort(values: &[Value]) -> Vec<String> {
    let mut efforts = Vec::new();
    for value in values {
        let Some(value) = value.as_str() else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if !ALLOWED_REASONING_EFFORT
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(value))
        {
            continue;
        }
        let canonical = value.to_ascii_lowercase();
        if !efforts.iter().any(|existing| existing == &canonical) {
            efforts.push(canonical);
        }
        if efforts.len() >= MAX_REASONING_EFFORT_VALUES {
            break;
        }
    }
    efforts
}

fn reasoning_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "supported" => Some(true),
            "false" | "no" | "unsupported" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn is_safe_token_count(value: &u64) -> bool {
    *value <= MAX_REASONING_TOKENS
}

fn as_u64(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() && number >= 0.0 && number <= u64::MAX as f64 {
            return Some(number as u64);
        }
    }
    if let Some(text) = value.as_str() {
        let compact: String = text.chars().filter(|ch| !matches!(ch, ',' | '_')).collect();
        return compact.trim().parse::<u64>().ok();
    }
    None
}

fn parse_source_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Catalog source URL is invalid.".to_string())?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_url(&url) => {}
        "http" => {
            return Err(
                "Catalog source must use HTTPS; plain HTTP is only allowed for loopback tests."
                    .to_string(),
            );
        }
        _ => return Err("Catalog source must use HTTPS.".to_string()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Catalog source URL must not contain credentials.".to_string());
    }
    if url.host_str().is_none() {
        return Err("Catalog source URL must include a host.".to_string());
    }
    Ok(url)
}

fn is_loopback_url(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            domain.eq_ignore_ascii_case("localhost")
                || domain
                    .trim_end_matches('.')
                    .eq_ignore_ascii_case("localhost")
        }
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn load_cache(cache_dir: &Path) -> Option<(Option<Catalog>, Option<String>, Option<String>)> {
    let path = cache_dir.join(CACHE_FILE_NAME);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > CACHE_MAX_BYTES as u64 {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    if bytes.len() > CACHE_MAX_BYTES {
        return None;
    }
    let envelope: CacheEnvelope = serde_json::from_slice(&bytes).ok()?;
    if envelope.version != CACHE_VERSION {
        return None;
    }
    if envelope.providers.len() > MAX_PROVIDERS {
        return None;
    }
    let model_count: usize = envelope.providers.iter().map(|p| p.models.len()).sum();
    if model_count > MAX_MODELS {
        return None;
    }
    if envelope.providers.is_empty() {
        return None;
    }
    let catalog = Catalog {
        providers: envelope.providers,
    };
    if catalog.model_count() == 0 {
        return None;
    }
    let fetched_at = if envelope.fetched_at.trim().is_empty() {
        None
    } else {
        Some(envelope.fetched_at)
    };
    Some((Some(catalog), envelope.etag, fetched_at))
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn round_score(score: f64) -> f64 {
    (score * 10_000.0).round() / 10_000.0
}

fn safe_label(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect()
}

async fn read_capped_body(
    response: &mut reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("Catalog response is too large to parse safely.".to_string());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Catalog response could not be read.".to_string())?
    {
        let new_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "Catalog response is too large to parse safely.".to_string())?;
        if new_len > max_bytes {
            return Err("Catalog response is too large to parse safely.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
