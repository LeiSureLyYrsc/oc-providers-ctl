//! Explicit, read-only OpenAI-compatible provider model inventory.
//!
//! This module reads the single configuration file supplied by the shell and
//! only inspects the selected provider entry. Credentials referenced by that
//! entry (inline values, `{env:...}` / `{file:...}` references, or configured
//! headers) are resolved into backend memory for this one request. They are
//! never written to results, warnings or errors.
//!
//! The request is always a GET to the provider's model-list endpoint. The
//! module never starts provider packages or makes inference calls, and it does
//! not read OpenCode OAuth/auth databases.
//!
//! Any well-formed `http` or `https` endpoint is accepted. Redirects are never
//! followed, and successful plain-HTTP responses carry an explicit warning
//! that the exchange was unencrypted.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

const CONFIG_MAX_BYTES: u64 = 16 * 1024 * 1024;
const SECRET_FILE_MAX_BYTES: u64 = 1024 * 1024;
const RESPONSE_MAX_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MODELS: usize = 10_000;

const OPENAI_DEFAULT_BASE: &str = "https://api.openai.com/v1";
const OPENROUTER_DEFAULT_BASE: &str = "https://openrouter.ai/api/v1";
const XAI_DEFAULT_BASE: &str = "https://api.x.ai/v1";
const ANTHROPIC_DEFAULT_BASE: &str = "https://api.anthropic.com/v1";

/// Model identifiers reported by a provider's public model-list endpoint.
///
/// IDs are returned exactly as the provider reports them. Configuration aliases
/// (`modelID`/request IDs) are not applied or rewritten here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInventory {
    pub provider_id: String,
    pub model_ids: Vec<String>,
    pub fetched_at: String,
    pub warnings: Vec<String>,
}

/// Explicit invocation entry point.
///
/// `path` must be the configuration document the user loaded. Only the exact
/// provider key `provider_id` is inspected. The file is never modified.
pub async fn fetch_inventory(path: &Path, provider_id: &str) -> Result<ProviderInventory, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider ID is required.".to_string());
    }

    let config = read_configuration(path)?;
    let provider_entry = select_provider(&config, provider_id)?;
    let settings = extract_provider_settings(provider_entry, provider_id)?;
    let (endpoint, protocol) = resolve_models_endpoint(&settings)?;

    let config_dir = path.parent().unwrap_or_else(|| Path::new("."));

    // Skip the key resolution when the request already carries a credential of
    // its own. Without this a broken `apiKey` reference (an unset environment
    // variable, a missing file) aborts a request whose explicit `x-api-key` is
    // perfectly usable -- the key is never sent, but its resolution still fails.
    //
    // Limited to the Anthropic protocols: for other providers the resolved key
    // also feeds the existing "sent without authentication" warning, and
    // changing that is a separate decision.
    let explicit_credential =
        protocol.is_anthropic() && has_explicit_credential_header(&settings.headers);
    let api_key = if explicit_credential {
        None
    } else {
        resolve_api_key(&settings, config_dir)?
    };
    let configured_headers = with_protocol_default_headers(protocol, settings.headers.clone());
    let headers = prepare_headers(&configured_headers, api_key.as_deref(), config_dir)?;

    // Plain HTTP is allowed for any host, but a successful fetch reports the
    // lack of transport encryption. Compute it before the URL is consumed.
    let plaintext_transport = plaintext_transport_warning(&endpoint);

    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent("oc-providers-ctl")
        .build()
        .map_err(|_| "Could not initialize the provider HTTP client.".to_string())?;

    // `send()` resolves once response headers arrive, so a failure here is a
    // transport-layer error with no HTTP status to report.
    let mut response = client
        .get(endpoint)
        .headers(headers)
        .send()
        .await
        .map_err(|_| "Provider model listing request failed (network or TLS error).".to_string())?;
    let status = response.status();

    if status.is_redirection() {
        return Err(
            "Provider returned an HTTP redirect; redirects are not followed for credential safety."
                .to_string(),
        );
    }
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("error");
        return Err(format!(
            "Provider returned HTTP {} {}.",
            status.as_u16(),
            reason
        ));
    }

    let bytes = read_capped_body(&mut response, RESPONSE_MAX_BYTES).await?;

    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Provider returned an unexpected model listing format.".to_string())?;
    let listing = extract_model_ids(&value)?;

    let mut model_ids = listing.model_ids;
    let mut truncated_by_limit = false;
    if model_ids.len() > MAX_MODELS {
        model_ids.truncate(MAX_MODELS);
        truncated_by_limit = true;
    }

    let mut warnings = Vec::new();
    if let Some(warning) = plaintext_transport {
        warnings.push(warning);
    }
    warnings.push(
        "This response only reports model identifiers; it does not verify model capabilities or runtime compatibility."
            .to_string(),
    );
    if listing.skipped_entries > 0 {
        warnings.push(format!(
            "Ignored {} provider entries that did not contain a usable model ID.",
            listing.skipped_entries
        ));
    }
    if listing.has_more {
        warnings.push(
            "Provider indicated that more models may be available; the inventory may be truncated."
                .to_string(),
        );
    }
    if truncated_by_limit {
        warnings.push(format!(
            "Provider returned more than {MAX_MODELS} model IDs; the inventory was truncated."
        ));
    }
    if model_ids.is_empty() {
        warnings.push("Provider returned no model IDs.".to_string());
    }
    if !settings.env_names.is_empty() && api_key.is_none() && !explicit_credential {
        warnings.push(
            "No configured environment credential was available; the request was sent without authentication."
                .to_string(),
        );
    }

    Ok(ProviderInventory {
        provider_id: provider_id.to_string(),
        model_ids,
        fetched_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        warnings,
    })
}

#[derive(Debug)]
struct ProviderSettings {
    provider_id: String,
    package: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    headers: Vec<(String, String)>,
    env_names: Vec<String>,
}

fn read_configuration(path: &Path) -> Result<Value, String> {
    if is_authentication_store(path) {
        return Err(
            "OpenCode authentication stores are not valid configuration sources.".to_string(),
        );
    }
    if let Ok(canonical) = fs::canonicalize(path) {
        if is_authentication_store(&canonical) {
            return Err(
                "OpenCode authentication stores are not valid configuration sources.".to_string(),
            );
        }
    }
    let metadata =
        fs::metadata(path).map_err(|_| "Could not read the configuration file.".to_string())?;
    if !metadata.is_file() {
        return Err("Configuration path is not a file.".to_string());
    }
    if metadata.len() > CONFIG_MAX_BYTES {
        return Err("Configuration file is too large to inspect safely.".to_string());
    }
    let bytes = fs::read(path).map_err(|_| "Could not read the configuration file.".to_string())?;
    if bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err("Configuration file is too large to inspect safely.".to_string());
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| "Configuration file is not valid UTF-8.".to_string())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let value: Value =
        jsonc_parser::parse_to_serde_value(text, &jsonc_parser::ParseOptions::default())
            .map_err(|_| "Configuration file is not valid JSON/JSONC.".to_string())?;
    Ok(value)
}

fn select_provider<'a>(
    config: &'a Value,
    provider_id: &str,
) -> Result<&'a Map<String, Value>, String> {
    let root = config
        .as_object()
        .ok_or_else(|| "Configuration root is not a JSON object.".to_string())?;
    let provider_label = safe_label(provider_id);

    let v1 = root.get("provider").and_then(Value::as_object);
    let v2 = root.get("providers").and_then(Value::as_object);
    let in_v1 = v1.and_then(|providers| providers.get(provider_id));
    let in_v2 = v2.and_then(|providers| providers.get(provider_id));

    let entry = match (in_v1, in_v2) {
        (Some(_), Some(_)) => {
            return Err(format!(
                "Provider '{provider_label}' is defined in both `provider` and `providers`; refusing an ambiguous inventory request."
            ));
        }
        (Some(entry), None) | (None, Some(entry)) => entry,
        (None, None) => {
            return Err(format!(
                "Provider '{provider_label}' was not found in this configuration file."
            ));
        }
    };

    entry.as_object().ok_or_else(|| {
        format!("Provider '{provider_label}' is not an object in this configuration file.")
    })
}

fn extract_provider_settings(
    entry: &Map<String, Value>,
    provider_id: &str,
) -> Result<ProviderSettings, String> {
    let settings = entry.get("settings").and_then(Value::as_object);
    let options = entry.get("options").and_then(Value::as_object);

    let package = first_field_string(&[entry.get("package"), entry.get("npm")])?;
    let base_url = first_field_string(&[
        settings.and_then(|map| map.get("baseURL")),
        options.and_then(|map| map.get("baseURL")),
        entry.get("api"),
    ])?;
    let api_key = first_field_string(&[
        settings.and_then(|map| map.get("apiKey")),
        options.and_then(|map| map.get("apiKey")),
        entry.get("apiKey"),
    ])?;

    let env_names = match entry.get("env") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => {
            let mut names = Vec::new();
            for value in values {
                if let Some(name) = value.as_str() {
                    let name = name.trim();
                    if !name.is_empty() {
                        names.push(name.to_string());
                    }
                }
            }
            names
        }
        Some(_) => {
            return Err(format!(
                "Provider '{}' has an unsupported `env` credential list.",
                safe_label(provider_id)
            ));
        }
    };

    let mut header_map: BTreeMap<String, (String, String)> = BTreeMap::new();
    for headers in [
        options.and_then(|map| map.get("headers")),
        settings.and_then(|map| map.get("headers")),
        entry.get("headers"),
    ]
    .into_iter()
    .flatten()
    {
        let Some(headers) = headers.as_object() else {
            return Err(format!(
                "Provider '{}' has an unsupported HTTP headers value.",
                safe_label(provider_id)
            ));
        };
        for (name, value) in headers {
            let Some(value) = value.as_str() else {
                return Err("Configured HTTP headers must have string values.".to_string());
            };
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            header_map.insert(
                name.to_ascii_lowercase(),
                (name.to_string(), value.to_string()),
            );
        }
    }

    Ok(ProviderSettings {
        provider_id: provider_id.to_string(),
        package: package.map(|value| value.trim().to_string()),
        base_url: base_url.map(|value| value.trim().to_string()),
        api_key: api_key.map(|value| value.trim().to_string()),
        headers: header_map.into_values().collect(),
        env_names,
    })
}

fn first_field_string(values: &[Option<&Value>]) -> Result<Option<String>, String> {
    for value in values.iter().flatten() {
        match value {
            Value::Null => {}
            Value::String(value) => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Ok(Some(trimmed.to_string()));
                }
            }
            _ => {
                return Err(
                    "Provider configuration contains an unsupported credential or endpoint value."
                        .to_string(),
                );
            }
        }
    }
    Ok(None)
}

#[derive(Debug, Clone, Copy)]
enum OpenAiProtocol {
    OpenAi,
    OpenAiCompatible,
    OpenRouter,
    XAi,
    /// Anthropic's native Messages API (`/v1/models`).
    ///
    /// The response container (`data[]`) and the ID key (`id`) are identical to
    /// the OpenAI-shaped listings, so the parser needs no Anthropic-specific
    /// branch. What differs is the endpoint, the required version header, and
    /// the pagination contract (`has_more` + `last_id` -> `after_id`).
    Anthropic,
    /// A third-party service that speaks the Anthropic protocol.
    ///
    /// Deliberately has **no default base URL**: this package points at a
    /// gateway the user configured, so falling back to the official Anthropic
    /// domain would send a gateway credential to `api.anthropic.com`.
    AnthropicCompatible,
}

impl OpenAiProtocol {
    /// `false` only for the two Anthropic variants, which need the
    /// `anthropic-version` request header.
    fn is_anthropic(self) -> bool {
        matches!(
            self,
            OpenAiProtocol::Anthropic | OpenAiProtocol::AnthropicCompatible
        )
    }
}

/// Exact allow-list of official package paths whose model-list protocol is
/// known. Substring matching is deliberately avoided so an arbitrary/unknown
/// package cannot opt itself into a credentialed request by having a suggestive
/// name such as `malicious-acme-openai`.
fn protocol_for_package(package: &str) -> Option<OpenAiProtocol> {
    match package.trim() {
        "@ai-sdk/openai"
        | "aisdk:@ai-sdk/openai"
        | "@opencode/ai/providers/openai"
        | "@opencode/ai/providers/openai/chat"
        | "@opencode/ai/providers/openai/responses" => Some(OpenAiProtocol::OpenAi),
        "@ai-sdk/openai-compatible"
        | "aisdk:@ai-sdk/openai-compatible"
        | "@opencode/ai/providers/openai-compatible"
        | "@opencode/ai/providers/openai-compatible/responses" => {
            Some(OpenAiProtocol::OpenAiCompatible)
        }
        "@openrouter/ai-sdk-provider"
        | "aisdk:@openrouter/ai-sdk-provider"
        | "@opencode/ai/providers/openrouter" => Some(OpenAiProtocol::OpenRouter),
        "@ai-sdk/xai" | "aisdk:@ai-sdk/xai" | "@opencode/ai/providers/xai" => {
            Some(OpenAiProtocol::XAi)
        }
        // Anthropic's native Messages API. The package list is verified against
        // https://opencode.ai/docs/providers/ ("Native package options").
        "@opencode/ai/providers/anthropic" => Some(OpenAiProtocol::Anthropic),
        "@opencode/ai/providers/anthropic-compatible" => Some(OpenAiProtocol::AnthropicCompatible),
        _ => None,
    }
}

fn resolve_models_endpoint(settings: &ProviderSettings) -> Result<(Url, OpenAiProtocol), String> {
    let configured_base = match settings.base_url.as_deref() {
        Some(base) => Some(parse_provider_url(base)?),
        None => None,
    };

    let protocol = if let Some(package) = settings.package.as_deref() {
        protocol_for_package(package).ok_or_else(|| {
            format!(
                "Provider '{}' uses the unsupported package '{}'. Only official OpenAI and Anthropic provider packages are supported; no model-list request was made.",
                safe_label(&settings.provider_id),
                safe_package(package),
            )
        })?
    } else {
        // Built-in providers whose protocol and default endpoint are known.
        // An explicitly declared package always wins over this guess: a
        // provider keyed `anthropic` that points at a compatible gateway must
        // be described by its package, not inferred from its name.
        match settings.provider_id.as_str() {
            "openai" => OpenAiProtocol::OpenAi,
            "openrouter" => OpenAiProtocol::OpenRouter,
            "xai" => OpenAiProtocol::XAi,
            // An `anthropic` entry that omits `package` is the common shape in
            // OpenCode configuration. It addresses the official API, which is
            // the default endpoint this protocol resolves to.
            "anthropic" => OpenAiProtocol::Anthropic,
            _ => {
                return Err(format!(
                    "Provider '{}' does not declare a supported package, so its model-list protocol is unknown. Add an official OpenAI or Anthropic `package`/`npm` setting or list models manually; no model-list request was made.",
                    safe_label(&settings.provider_id)
                ));
            }
        }
    };

    let base = match protocol {
        OpenAiProtocol::OpenAiCompatible => configured_base.ok_or_else(|| {
            format!(
                "Provider '{}' uses an OpenAI-compatible package but does not define a base URL. Add `settings.baseURL` or `options.baseURL`.",
                safe_label(&settings.provider_id)
            )
        })?,
        OpenAiProtocol::OpenAi => {
            configured_base.unwrap_or(parse_provider_url(OPENAI_DEFAULT_BASE)?)
        }
        OpenAiProtocol::OpenRouter => {
            configured_base.unwrap_or(parse_provider_url(OPENROUTER_DEFAULT_BASE)?)
        }
        OpenAiProtocol::XAi => {
            configured_base.unwrap_or(parse_provider_url(XAI_DEFAULT_BASE)?)
        }
        OpenAiProtocol::Anthropic => {
            configured_base.unwrap_or(parse_provider_url(ANTHROPIC_DEFAULT_BASE)?)
        }
        OpenAiProtocol::AnthropicCompatible => configured_base.ok_or_else(|| {
            format!(
                "Provider '{}' uses an Anthropic-compatible package but does not define a base URL. Add `settings.baseURL` or `options.baseURL`; no model-list request was made.",
                safe_label(&settings.provider_id)
            )
        })?,
    };

    let endpoint = models_endpoint(base);

    // An explicit `models` endpoint already in the base URL is honoured above;
    // everything else takes the `/models` suffix.
    Ok((endpoint, protocol))
}

/// The Anthropic API requires this header, but the vendor's own documentation
/// disagrees on whether it is mandatory (`/api/overview` says "Yes", while the
/// `/api/models-list` reference marks it "optional"). The cost of the two
/// failure modes is asymmetric: sending it when optional costs nothing, while
/// omitting it when required breaks every Anthropic request. So it is always
/// supplied unless the user configured their own value.
///
/// Note: a missing version does **not** produce a version-specific error —
/// Anthropic evaluates authentication first, so an anonymous probe with no
/// version header still returns an auth 401. That is why this default exists
/// rather than relying on a diagnosable failure.
const ANTHROPIC_DEFAULT_VERSION: &str = "2026-10-21";
const ANTHROPIC_VERSION_HEADER: &str = "anthropic-version";

/// Add defaults that depend on the resolved protocol, without changing the
/// signature of [`prepare_headers`] (which several tests exercise directly).
///
/// `configured` is the user's header list; the returned list keeps every user
/// header and only appends what is missing.
fn with_protocol_default_headers(
    protocol: OpenAiProtocol,
    mut configured: Vec<(String, String)>,
) -> Vec<(String, String)> {
    if !protocol.is_anthropic() {
        return configured;
    }
    let has_version = configured
        .iter()
        .any(|(name, _)| name.trim().eq_ignore_ascii_case(ANTHROPIC_VERSION_HEADER));
    if !has_version {
        configured.push((
            ANTHROPIC_VERSION_HEADER.to_string(),
            ANTHROPIC_DEFAULT_VERSION.to_string(),
        ));
    }
    configured
}

fn parse_provider_url(raw: &str) -> Result<Url, String> {
    let url =
        Url::parse(raw.trim()).map_err(|_| "Provider endpoint is not a valid URL.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(
            "Provider endpoint URL contains embedded credentials, which are not allowed."
                .to_string(),
        );
    }
    if url.host_str().is_none() {
        return Err("Provider endpoint URL must include a host.".to_string());
    }
    if url.fragment().is_some() {
        return Err("Provider endpoint URL must not contain a fragment.".to_string());
    }

    match url.scheme() {
        "http" | "https" => {}
        _ => {
            return Err("Provider endpoint must use HTTP or HTTPS.".to_string());
        }
    }

    if has_credential_query(&url) {
        return Err(
            "Provider endpoint URL contains credential-like query parameters, which are not allowed."
                .to_string(),
        );
    }
    Ok(url)
}

fn has_credential_query(url: &Url) -> bool {
    const SENSITIVE: &[&str] = &[
        "api_key",
        "apikey",
        "key",
        "token",
        "access_token",
        "secret",
        "client_secret",
        "password",
        "auth",
        "signature",
        "sig",
    ];
    url.query_pairs().any(|(name, _)| {
        let lower = name.to_ascii_lowercase();
        SENSITIVE.iter().any(|sensitive| {
            lower == *sensitive || lower.ends_with("_token") || lower.ends_with("_key")
        })
    })
}

/// Plain HTTP is accepted for any host, but a successful response is flagged
/// so the shell can surface that credentials and model data travelled without
/// transport encryption. The message is intentionally static: it must never
/// echo the endpoint, its query, or any credential material.
fn plaintext_transport_warning(endpoint: &Url) -> Option<String> {
    (endpoint.scheme() == "http").then(|| {
        "This request used plain HTTP. The provider response and any credentials were sent without transport encryption and could be observed or modified on the network. Prefer an HTTPS base URL.".to_string()
    })
}

fn models_endpoint(mut base: Url) -> Url {
    let trimmed = base.path().trim_end_matches('/');
    let new_path = if trimmed.is_empty() {
        "/models".to_string()
    } else if trimmed.ends_with("/models") || trimmed == "models" {
        trimmed.to_string()
    } else {
        format!("{trimmed}/models")
    };
    base.set_path(&new_path);
    base.set_query(None);
    base.set_fragment(None);
    base
}

fn resolve_api_key(
    settings: &ProviderSettings,
    config_dir: &Path,
) -> Result<Option<String>, String> {
    if let Some(reference) = settings.api_key.as_deref() {
        let value = resolve_secret_references(reference, config_dir)?;
        let value = value.trim();
        if value.is_empty() {
            return Err(
                "The configured credential reference resolved to an empty value.".to_string(),
            );
        }
        return Ok(Some(value.to_string()));
    }

    for name in &settings.env_names {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if !value.is_empty() {
                return Ok(Some(value.to_string()));
            }
        }
    }
    Ok(None)
}

/// Header names that carry a credential in their own right. Supplying a
/// provider key as `Authorization: Bearer` **in addition** to one of these
/// makes the request carry two credentials at once.
const ALTERNATIVE_CREDENTIAL_HEADERS: &[&str] = &["x-api-key", "api-key"];

/// Whether the caller already supplies a credential header, either as
/// `Authorization` or as one of the alternative credential headers. When true,
/// no generated `Authorization: Bearer` is added and the provider key does not
/// need to be resolved at all.
fn has_explicit_credential_header(configured: &[(String, String)]) -> bool {
    configured.iter().any(|(name, _)| {
        let name = name.trim();
        name.eq_ignore_ascii_case("authorization")
            || ALTERNATIVE_CREDENTIAL_HEADERS
                .iter()
                .any(|alternative| name.eq_ignore_ascii_case(alternative))
    })
}

fn prepare_headers(
    configured: &[(String, String)],
    api_key: Option<&str>,
    config_dir: &Path,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for (name, raw_value) in configured {
        let header_name = HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| "Configured HTTP header name is invalid.".to_string())?;
        if is_forbidden_header(&header_name) {
            return Err(format!(
                "Configured HTTP header '{}' is not allowed for provider inventory.",
                header_name.as_str()
            ));
        }
        let value = resolve_secret_references(raw_value, config_dir)?;
        let value = value.trim();
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| "Configured HTTP header value is invalid.".to_string())?;
        headers.insert(header_name, header_value);
    }

    // Add the provider key as `Authorization: Bearer` only when the request
    // does not already carry a credential. Checking `AUTHORIZATION` alone was
    // not enough: a user-supplied `x-api-key` (Anthropic) or `api-key` (Azure)
    // would then be accompanied by a generated Bearer, and providers reject a
    // request that carries two credentials. Anthropic answers
    // `This request carries more than one credential...`; others may silently
    // ignore one of them, which is worse because it looks like a bad key.
    let already_authenticated = headers.contains_key(AUTHORIZATION)
        || ALTERNATIVE_CREDENTIAL_HEADERS
            .iter()
            .any(|name| headers.contains_key(*name));

    if !already_authenticated {
        if let Some(key) = api_key {
            let value = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| {
                "The configured API key cannot be used as an HTTP header.".to_string()
            })?;
            headers.insert(AUTHORIZATION, value);
        }
    }
    Ok(headers)
}

fn is_forbidden_header(name: &HeaderName) -> bool {
    const FORBIDDEN: &[&str] = &[
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "proxy-authenticate",
        "te",
        "trailer",
    ];
    FORBIDDEN
        .iter()
        .any(|forbidden| name.as_str().eq_ignore_ascii_case(forbidden))
}

fn resolve_secret_references(raw: &str, config_dir: &Path) -> Result<String, String> {
    let mut output = String::with_capacity(raw.len());
    let mut remainder = raw;

    loop {
        let env_position = remainder.find("{env:");
        let file_position = remainder.find("{file:");
        let Some(start) = min_position(env_position, file_position) else {
            output.push_str(remainder);
            break;
        };

        output.push_str(&remainder[..start]);
        let reference = &remainder[start..];
        let Some(end) = reference.find('}') else {
            return Err("The configured credential reference is malformed.".to_string());
        };
        let token = &reference[1..end];
        let resolved = if let Some(name) = token.strip_prefix("env:") {
            resolve_environment_reference(name)?
        } else if let Some(path) = token.strip_prefix("file:") {
            resolve_file_reference(path, config_dir)?
        } else {
            // Not one of our references; preserve it verbatim.
            output.push_str(&reference[..=end]);
            remainder = &reference[end + 1..];
            continue;
        };

        output.push_str(&resolved);
        remainder = &reference[end + 1..];
    }

    Ok(output)
}

fn min_position(left: Option<usize>, right: Option<usize>) -> Option<usize> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(position), None) | (None, Some(position)) => Some(position),
        (None, None) => None,
    }
}

fn resolve_environment_reference(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err(
            "The configured credential reference has an invalid environment variable name."
                .to_string(),
        );
    }
    std::env::var(name)
        .map_err(|_| "The configured environment credential reference is not set.".to_string())
}

fn resolve_file_reference(raw_path: &str, config_dir: &Path) -> Result<String, String> {
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Err("The configured credential file reference is empty.".to_string());
    }

    let expanded = if let Some(rest) = raw_path.strip_prefix("~/") {
        let home = dirs::home_dir()
            .ok_or_else(|| "The home directory could not be resolved.".to_string())?;
        home.join(rest)
    } else if let Some(rest) = raw_path.strip_prefix("~\\") {
        let home = dirs::home_dir()
            .ok_or_else(|| "The home directory could not be resolved.".to_string())?;
        home.join(rest)
    } else {
        PathBuf::from(raw_path)
    };

    let resolved = if expanded.is_absolute() {
        expanded
    } else {
        config_dir.join(expanded)
    };

    if is_authentication_store(&resolved) {
        return Err(
            "Credential file references to OpenCode authentication stores are not allowed."
                .to_string(),
        );
    }

    let metadata = fs::metadata(&resolved)
        .map_err(|_| "The configured credential file reference could not be read.".to_string())?;
    if !metadata.is_file() || metadata.len() > SECRET_FILE_MAX_BYTES {
        return Err("The configured credential file is not a small regular file.".to_string());
    }
    if let Ok(canonical) = fs::canonicalize(&resolved) {
        if is_authentication_store(&canonical) {
            return Err(
                "Credential file references to OpenCode authentication stores are not allowed."
                    .to_string(),
            );
        }
    }

    let bytes = fs::read(&resolved)
        .map_err(|_| "The configured credential file reference could not be read.".to_string())?;
    if bytes.len() as u64 > SECRET_FILE_MAX_BYTES {
        return Err("The configured credential file is too large to use safely.".to_string());
    }
    let value = String::from_utf8(bytes)
        .map_err(|_| "The configured credential file is not valid UTF-8.".to_string())?;
    let value = value.trim();
    if value.is_empty() {
        return Err("The configured credential file is empty.".to_string());
    }
    Ok(value.to_string())
}

fn is_authentication_store(path: &Path) -> bool {
    let Some(name) = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase())
    else {
        return false;
    };

    if name == "auth.json" {
        return true;
    }

    // SQLite sidecars keep credential data reachable even when the main file
    // name differs. Treat `opencode.db`, `auth.db` and any `.db`/`.sqlite*`
    // file plus its `-wal`, `-shm` and `-journal` companions as authentication
    // stores. Canonical paths are checked by callers as well.
    let base = name
        .strip_suffix("-wal")
        .or_else(|| name.strip_suffix("-shm"))
        .or_else(|| name.strip_suffix("-journal"))
        .unwrap_or(&name);
    base == "auth.db"
        || base == "opencode.db"
        || base.ends_with(".db")
        || base.ends_with(".sqlite")
        || base.ends_with(".sqlite3")
}

struct ExtractedListing {
    model_ids: Vec<String>,
    skipped_entries: usize,
    has_more: bool,
}

fn extract_model_ids(value: &Value) -> Result<ExtractedListing, String> {
    let mut skipped_entries = 0usize;
    let mut model_ids = Vec::new();
    let mut has_more = false;

    if let Some(root) = value.as_object() {
        has_more = object_has_more(root);

        if let Some(data) = root.get("data").and_then(Value::as_array) {
            collect_array_ids(data, &mut model_ids, &mut skipped_entries);
        } else if let Some(models) = root.get("models").and_then(Value::as_array) {
            collect_array_ids(models, &mut model_ids, &mut skipped_entries);
        } else if let Some(items) = root.get("items").and_then(Value::as_array) {
            collect_array_ids(items, &mut model_ids, &mut skipped_entries);
        } else if let Some(models) = root.get("models").and_then(Value::as_object) {
            for key in models.keys() {
                if !key.trim().is_empty() {
                    model_ids.push(key.clone());
                }
            }
        } else {
            return Err("Provider returned an unexpected model listing format.".to_string());
        }
    } else if let Some(items) = value.as_array() {
        collect_array_ids(items, &mut model_ids, &mut skipped_entries);
    } else {
        return Err("Provider returned an unexpected model listing format.".to_string());
    }

    model_ids.retain(|id| !id.trim().is_empty());
    model_ids.sort();
    model_ids.dedup();

    Ok(ExtractedListing {
        model_ids,
        skipped_entries,
        has_more,
    })
}

fn collect_array_ids(items: &[Value], ids: &mut Vec<String>, skipped: &mut usize) {
    for item in items {
        if let Some(id) = item.as_str() {
            if !id.trim().is_empty() {
                // Keep the provider-reported ID bytes intact. Request IDs in
                // existing configuration must not be silently rewritten.
                ids.push(id.to_string());
                continue;
            }
        }
        let Some(object) = item.as_object() else {
            *skipped += 1;
            continue;
        };
        let mut found = None;
        for key in ["id", "model", "model_id", "modelId"] {
            if let Some(id) = object.get(key).and_then(Value::as_str) {
                if !id.trim().is_empty() {
                    found = Some(id.to_string());
                    break;
                }
            }
        }
        match found {
            Some(id) => ids.push(id),
            None => *skipped += 1,
        }
    }
}

fn object_has_more(root: &Map<String, Value>) -> bool {
    if root.get("has_more").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if let Some(pagination) = root.get("pagination").and_then(Value::as_object) {
        if pagination.get("has_more").and_then(Value::as_bool) == Some(true) {
            return true;
        }
    }
    for key in ["next", "next_page", "nextPage"] {
        if matches!(root.get(key), Some(value) if !value.is_null()) {
            return true;
        }
    }
    false
}

fn safe_label(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect()
}

fn safe_package(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
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
        return Err("Provider response is too large to inspect safely.".to_string());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Provider response could not be read.".to_string())?
    {
        let new_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "Provider response is too large to inspect safely.".to_string())?;
        if new_len > max_bytes {
            return Err("Provider response is too large to inspect safely.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::{models_endpoint, parse_provider_url, plaintext_transport_warning};

    #[test]
    fn parse_accepts_https_and_remote_plain_http() {
        // HTTPS remains accepted for public hosts.
        let https = parse_provider_url("https://api.example.com/v1").expect("https endpoint");
        assert_eq!(https.scheme(), "https");
        assert_eq!(https.host_str(), Some("api.example.com"));

        // Plain HTTP is no longer restricted to loopback: any legal host is
        // accepted by the parser. No network access happens here.
        let remote = parse_provider_url("http://api.example.com/v1").expect("remote http endpoint");
        assert_eq!(remote.scheme(), "http");
        assert_eq!(remote.host_str(), Some("api.example.com"));

        let loopback = parse_provider_url("http://127.0.0.1:8080/v1").expect("loopback http");
        assert_eq!(loopback.host_str(), Some("127.0.0.1"));

        let ipv6 = parse_provider_url("http://[::1]:8080/v1").expect("ipv6 loopback http");
        assert_eq!(ipv6.scheme(), "http");

        // Surrounding whitespace and a path-less host are still accepted.
        let spaced = parse_provider_url("  http://models.example.com  ").expect("trimmed url");
        assert_eq!(
            models_endpoint(spaced).as_str(),
            "http://models.example.com/models"
        );
    }

    #[test]
    fn parse_rejects_illegal_schemes() {
        for raw in ["ftp://api.example.com/v1", "ws://api.example.com/v1"] {
            let error = parse_provider_url(raw).expect_err(raw);
            assert!(error.contains("HTTP or HTTPS"), "{raw}: {error}");
        }

        // Schemes without an authority host are still refused, just by the
        // host check that runs first.
        for raw in ["file:///etc/passwd", "javascript:alert(1)"] {
            let error = parse_provider_url(raw).expect_err(raw);
            assert!(error.contains("host"), "{raw}: {error}");
        }

        // A scheme-less value is not a URL at all.
        let error = parse_provider_url("api.example.com/v1").expect_err("relative url");
        assert!(
            error.contains("not a valid URL"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn parse_rejects_embedded_credentials_and_secret_queries() {
        for raw in [
            "http://user:url-secret@api.example.com/v1",
            "https://user:url-secret@api.example.com/v1",
            "https://url-secret@api.example.com/v1",
        ] {
            let error = parse_provider_url(raw).expect_err(raw);
            assert!(error.contains("embedded credentials"), "{raw}: {error}");
            assert!(!error.contains("url-secret"), "{raw}: {error}");
        }

        for raw in [
            "http://api.example.com/v1?api_key=query-secret",
            "https://api.example.com/v1?token=query-secret",
            "https://api.example.com/v1?access_token=query-secret",
            "https://api.example.com/v1?my_key=query-secret",
        ] {
            let error = parse_provider_url(raw).expect_err(raw);
            assert!(error.contains("credential-like query"), "{raw}: {error}");
            assert!(!error.contains("query-secret"), "{raw}: {error}");
        }

        // A non-credential query is tolerated by the parser; it is dropped
        // when the model-list path is built.
        let benign =
            parse_provider_url("https://api.example.com/v1?page=2&limit=10").expect("benign query");
        let endpoint = models_endpoint(benign);
        assert_eq!(endpoint.path(), "/v1/models");
        assert!(endpoint.query().is_none());
        assert!(endpoint.fragment().is_none());
    }

    #[test]
    fn parse_rejects_fragments() {
        let error = parse_provider_url("https://api.example.com/v1#section").expect_err("fragment");
        assert!(error.contains("fragment"), "unexpected error: {error}");
    }

    #[test]
    fn plaintext_warning_is_only_emitted_for_http_and_static() {
        let http = parse_provider_url("http://api.example.com/v1").expect("http");
        let warning = plaintext_transport_warning(&http).expect("http warning");
        assert!(warning.contains("plain HTTP"), "warning: {warning}");
        assert!(warning.contains("without transport"), "warning: {warning}");
        // The warning must not echo endpoint details or any secret material.
        assert!(!warning.contains("api.example.com"), "warning: {warning}");
        assert!(!warning.contains("://"), "warning: {warning}");

        let https = parse_provider_url("https://api.example.com/v1").expect("https");
        assert!(plaintext_transport_warning(&https).is_none());

        // Query secrets are refused before reaching this point, so a parser
        // rejection can never surface them through the warning.
        assert!(parse_provider_url("http://api.example.com/v1?token=leak").is_err());
    }
}
