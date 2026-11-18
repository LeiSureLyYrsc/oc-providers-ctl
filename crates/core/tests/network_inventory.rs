mod network_support;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use oc_providers_core::inventory::{fetch_inventory, ProviderInventory};
use tempfile::TempDir;

use network_support::{MockServer, ResponseSpec};

const RESPONSE_TEST_CAP: usize = 16 * 1024 * 1024;

fn write_config(directory: &TempDir, name: &str, contents: &str) -> PathBuf {
    let path = directory.path().join(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("config parent");
    }
    fs::write(&path, contents).expect("write config");
    path
}

fn config_with(
    directory: &TempDir,
    name: &str,
    provider_map: &str,
    provider_id: &str,
    provider_body: &str,
) -> PathBuf {
    let contents =
        format!("{{\n  \"{provider_map}\": {{\n    \"{provider_id}\": {provider_body}\n  }}\n}}\n");
    write_config(directory, name, &contents)
}

fn assert_no_secret(value: &ProviderInventory, secret: &str) {
    let json = serde_json::to_string(value).expect("inventory json");
    assert!(!json.contains(secret), "inventory leak: {json}");
    assert!(
        value
            .warnings
            .iter()
            .all(|warning| !warning.contains(secret)),
        "warning leak: {:?}",
        value.warnings
    );
}

#[tokio::test]
async fn v1_openai_compatible_inventory_is_get_only_and_never_modifies_config() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(
        r#"{
            "object": "list",
            "data": [
                {"id": "z-model", "object": "model"},
                {"id": "a-model"},
                {"id": "a-model"},
                "string-model",
                {"name": "display only"}
            ]
        }"#,
    )]);

    let config_path = write_config(
        &directory,
        "v1.jsonc",
        &format!(
            r#"{{
  // JSONC comments and trailing commas are accepted by the config reader.
  "provider": {{
    "acme": {{
      "npm": "@ai-sdk/openai-compatible",
      "name": "Acme",
      "options": {{
        "baseURL": "{}/v1",
        "apiKey": "sk-inline-secret",
      }},
      "models": {{ "alias": {{ "modelID": "upstream-model" }} }},
    }},
  }},
}}"#,
            server.base_url
        ),
    );
    let original = fs::read(&config_path).expect("read original");
    let inventory = fetch_inventory(&config_path, "acme")
        .await
        .expect("inventory");

    assert_eq!(
        inventory.model_ids,
        vec!["a-model", "string-model", "z-model"]
    );
    assert!(!inventory.fetched_at.is_empty());
    assert!(inventory
        .warnings
        .iter()
        .any(|warning| warning.contains("does not verify")));
    assert_no_secret(&inventory, "sk-inline-secret");

    let unchanged = fs::read(&config_path).expect("read after");
    assert_eq!(original, unchanged, "inventory must not modify config");

    assert!(server.wait_for_requests(1, Duration::from_secs(2)));
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/v1/models");
    assert_eq!(
        requests[0].header("authorization"),
        Some("Bearer sk-inline-secret")
    );
    assert!(!requests[0].path.contains("chat"));
    assert!(!requests[0].path.contains("completion"));
    assert!(!requests[0].path.contains("inference"));
}

#[tokio::test]
async fn v2_inventory_supports_custom_headers_and_reports_unresolved_env() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(
        r#"{"data":[{"id":"local-model"}]}"#,
    )]);
    let config_path = write_config(
        &directory,
        "v2.jsonc",
        &format!(
            r#"{{
  "providers": {{
    "acme": {{
      "name": "Acme",
      // This variable is intentionally unlikely to exist.
      "env": ["OC_PROVIDERS_CTL_TEST_UNSET_CREDENTIAL_XYZ"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {{ "baseURL": "{}/v1" }},
      "headers": {{
        "X-Custom-Credential": "header-secret",
        "Authorization": "Bearer header-auth-secret",
      }},
      "models": {{ "local": {{}} }},
    }},
  }},
}}"#,
            server.base_url
        ),
    );

    let inventory = fetch_inventory(&config_path, "acme")
        .await
        .expect("inventory");
    assert_eq!(inventory.model_ids, vec!["local-model"]);
    assert!(inventory
        .warnings
        .iter()
        .any(|warning| warning.contains("without authentication")));
    assert_no_secret(&inventory, "header-secret");
    assert_no_secret(&inventory, "header-auth-secret");

    assert!(server.wait_for_requests(1, Duration::from_secs(2)));
    let request = &server.requests()[0];
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/v1/models");
    assert_eq!(request.header("x-custom-credential"), Some("header-secret"));
    assert_eq!(
        request.header("authorization"),
        Some("Bearer header-auth-secret")
    );
}

#[tokio::test]
async fn file_credentials_are_resolved_in_memory_and_auth_stores_are_refused() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(r#"{"data":[{"id":"m"}]}"#)]);
    fs::write(directory.path().join("secret.txt"), "file-secret\n").expect("secret file");
    let config_path = write_config(
        &directory,
        "file-config.json",
        &format!(
            r#"{{
  "provider": {{
    "acme": {{
      "npm": "@ai-sdk/openai-compatible",
      "options": {{
        "baseURL": "{}/v1",
        "apiKey": "{{file:secret.txt}}"
      }}
    }}
  }}
}}"#,
            server.base_url
        ),
    );

    let inventory = fetch_inventory(&config_path, "acme")
        .await
        .expect("file credential inventory");
    assert_no_secret(&inventory, "file-secret");
    assert!(server.wait_for_requests(1, Duration::from_secs(2)));
    assert_eq!(
        server.requests()[0].header("authorization"),
        Some("Bearer file-secret")
    );

    // An unset explicit environment reference must fail before any request.
    let unset_path = write_config(
        &directory,
        "unset-env.json",
        &format!(
            r#"{{
  "provider": {{
    "unset": {{
      "npm": "@ai-sdk/openai-compatible",
      "options": {{
        "baseURL": "{}/v1",
        "apiKey": "{{env:OC_PROVIDERS_CTL_TEST_UNSET_CREDENTIAL_XYZ}}"
      }}
    }}
  }}
}}"#,
            server.base_url
        ),
    );
    let error = fetch_inventory(&unset_path, "unset")
        .await
        .expect_err("unset env reference");
    assert!(
        error.contains("environment credential reference is not set"),
        "unexpected error: {error}"
    );
    assert!(!error.contains("OC_PROVIDERS_CTL_TEST_UNSET_CREDENTIAL_XYZ"));

    fs::write(directory.path().join("auth.json"), "auth-json-secret").expect("auth fixture");
    let auth_ref = write_config(
        &directory,
        "auth-ref.json",
        &format!(
            r#"{{
  "provider": {{
    "authref": {{
      "npm": "@ai-sdk/openai-compatible",
      "options": {{
        "baseURL": "{}/v1",
        "apiKey": "{{file:auth.json}}"
      }}
    }}
  }}
}}"#,
            server.base_url
        ),
    );
    let error = fetch_inventory(&auth_ref, "authref")
        .await
        .expect_err("auth store reference");
    assert!(
        error.contains("authentication stores"),
        "unexpected error: {error}"
    );
    assert!(!error.contains("auth-json-secret"));

    fs::write(
        directory.path().join("opencode.db-wal"),
        "sqlite-wal-secret",
    )
    .expect("db fixture");
    let db_ref = write_config(
        &directory,
        "db-ref.json",
        &format!(
            r#"{{
  "provider": {{
    "dbref": {{
      "npm": "@ai-sdk/openai-compatible",
      "options": {{
        "baseURL": "{}/v1",
        "apiKey": "{{file:opencode.db-wal}}"
      }}
    }}
  }}
}}"#,
            server.base_url
        ),
    );
    let error = fetch_inventory(&db_ref, "dbref")
        .await
        .expect_err("sqlite sidecar reference");
    assert!(
        error.contains("authentication stores"),
        "unexpected error: {error}"
    );
    assert!(!error.contains("sqlite-wal-secret"));

    // A configuration document named like a SQLite sidecar is rejected too.
    let db_as_config = write_config(
        &directory,
        "opencode.db-shm",
        r#"{"provider":{"ignored":{"package":"@ai-sdk/openai-compatible"}}}"#,
    );
    let error = fetch_inventory(&db_as_config, "ignored")
        .await
        .expect_err("auth store as config");
    assert!(
        error.contains("authentication stores"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn unsafe_urls_are_refused_before_any_credentialed_request() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(r#"{"data":[]}"#)]);
    let server_port = server.addr().port();

    let remote_http = config_with(
        &directory,
        "remote-http.json",
        "provider",
        "remote",
        r#"{ "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://example.com/v1" } }"#,
    );
    let error = fetch_inventory(&remote_http, "remote")
        .await
        .expect_err("remote http");
    assert!(error.contains("HTTPS"), "unexpected error: {error}");
    assert_eq!(server.request_count(), 0);

    let embedded = config_with(
        &directory,
        "embedded.json",
        "providers",
        "embedded",
        &format!(
            r#"{{ "package": "@opencode/ai/providers/openai-compatible", "settings": {{ "baseURL": "http://user:url-secret@127.0.0.1:{server_port}/v1", "apiKey": "sk-must-not-appear" }} }}"#
        ),
    );
    let error = fetch_inventory(&embedded, "embedded")
        .await
        .expect_err("embedded URL credentials");
    assert!(
        error.contains("embedded credentials"),
        "unexpected error: {error}"
    );
    assert!(!error.contains("url-secret"));
    assert!(!error.contains("sk-must-not-appear"));
    assert_eq!(server.request_count(), 0);

    let query_secret = config_with(
        &directory,
        "query-secret.json",
        "providers",
        "query",
        &format!(
            r#"{{ "package": "@opencode/ai/providers/openai-compatible", "settings": {{ "baseURL": "http://127.0.0.1:{server_port}/v1?api_key=query-secret" }} }}"#
        ),
    );
    let error = fetch_inventory(&query_secret, "query")
        .await
        .expect_err("credential query");
    assert!(
        error.contains("credential-like query"),
        "unexpected error: {error}"
    );
    assert!(!error.contains("query-secret"));
    assert_eq!(server.request_count(), 0);
}

#[tokio::test]
async fn redirects_are_not_followed_and_do_not_forward_credentials() {
    let directory = tempfile::tempdir().expect("tempdir");
    let redirect_target = MockServer::start(vec![ResponseSpec::json(r#"{"data":[]}"#)]);
    let redirector = MockServer::start(vec![ResponseSpec::empty(302).with_header(
        "Location",
        format!("http://127.0.0.1:{}/leak", redirect_target.addr().port()),
    )]);
    let config_path = config_with(
        &directory,
        "redirect.json",
        "provider",
        "redirect",
        &format!(
            r#"{{ "npm": "@ai-sdk/openai-compatible", "options": {{ "baseURL": "{}/v1", "apiKey": "redirect-inline-secret" }} }}"#,
            redirector.base_url
        ),
    );

    let error = fetch_inventory(&config_path, "redirect")
        .await
        .expect_err("redirect refused");
    assert!(error.contains("redirect"), "unexpected error: {error}");
    assert!(!error.contains("redirect-inline-secret"));
    assert!(redirector.wait_for_requests(1, Duration::from_secs(2)));
    assert_eq!(redirector.request_count(), 1);
    assert_eq!(redirect_target.request_count(), 0);
}

#[tokio::test]
async fn mock_server_bounds_writes_to_a_client_that_stops_reading() {
    // A client that sends a request then never reads must not block the mock
    // server thread (and therefore `Drop`) indefinitely. Response writes are
    // bounded by a socket write timeout and an accepted-socket lifetime cap.
    use std::io::{Read, Write};

    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![
        // Larger than any plausible socket buffer, so the server-side write
        // cannot complete while the client is not reading.
        ResponseSpec::empty(200).with_body("x".repeat(64 * 1024 * 1024)),
        ResponseSpec::json(r#"{"data":[{"id":"after"}]}"#),
    ]);
    let config_path = config_with(
        &directory,
        "stall.json",
        "provider",
        "stall",
        &format!(
            r#"{{ "npm": "@ai-sdk/openai-compatible", "options": {{ "baseURL": "{}/v1" }} }}"#,
            server.base_url
        ),
    );

    // Raw client: request the huge response, read one tiny chunk, then stop
    // reading while staying connected. The server-side write must time out.
    let mut stalled_client =
        std::net::TcpStream::connect(("127.0.0.1", server.addr().port())).expect("connect");
    stalled_client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .ok();
    stalled_client
        .write_all(b"GET /v1/models HTTP/1.1\r\nHost: mock\r\n\r\n")
        .expect("write request");
    let mut tiny = [0u8; 64];
    assert!(
        stalled_client.read(&mut tiny).unwrap_or(0) > 0,
        "mock never started answering"
    );

    // A second client meanwhile must still reach the server once the first
    // write attempt gives up, within a bounded time.
    let started = std::time::Instant::now();
    let following = fetch_inventory(&config_path, "stall").await;
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "second request took {:?}",
        started.elapsed()
    );
    let following = following.expect("server still serves after a stalled client");
    assert_eq!(following.model_ids, vec!["after"]);
    drop(stalled_client);

    let started = std::time::Instant::now();
    drop(server);
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "mock server teardown took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn mock_server_serves_two_sequential_statuses_in_order() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![
        ResponseSpec::empty(401).with_body(r#"{"error":"first-body"}"#),
        ResponseSpec::json(r#"{"data":[{"id":"ok"}]}"#),
    ]);
    let config_path = config_with(
        &directory,
        "ordered.json",
        "provider",
        "probe",
        &format!(
            r#"{{ "npm": "@ai-sdk/openai-compatible", "options": {{ "baseURL": "{}/v1" }} }}"#,
            server.base_url
        ),
    );

    let first = fetch_inventory(&config_path, "probe")
        .await
        .expect_err("first response is 401");
    assert!(first.contains("HTTP 401"), "unexpected error: {first}");
    assert!(!first.contains("first-body"));

    let second = fetch_inventory(&config_path, "probe")
        .await
        .expect("second response is 200");
    assert_eq!(second.model_ids, vec!["ok"]);
    assert_eq!(server.request_count(), 2);
}

#[tokio::test]
async fn http_errors_and_bad_payloads_are_status_only_and_safe() {
    let directory = tempfile::tempdir().expect("tempdir");
    let chunked_chunks = vec![vec![b'x'; RESPONSE_TEST_CAP + 1024 * 1024]];
    let server = MockServer::start(vec![
        ResponseSpec::empty(401).with_body(r#"{"error":"http-body-secret"}"#),
        ResponseSpec::json("{ not json").with_body("malformed-body-secret"),
        ResponseSpec::json(r#"{"object":"list"}"#),
        ResponseSpec::json("{}").with_header("Content-Length", "999999999"),
        ResponseSpec::empty(200).with_chunks(chunked_chunks),
    ]);
    let config_path = config_with(
        &directory,
        "safe-errors.json",
        "provider",
        "safe",
        &format!(
            r#"{{ "npm": "@ai-sdk/openai-compatible", "options": {{ "baseURL": "{}/v1", "apiKey": "error-inline-secret" }} }}"#,
            server.base_url
        ),
    );

    let unauthorized = fetch_inventory(&config_path, "safe")
        .await
        .expect_err("401");
    assert!(
        unauthorized.contains("HTTP 401"),
        "unexpected error: {unauthorized}"
    );
    assert!(!unauthorized.contains("http-body-secret"));
    assert!(!unauthorized.contains("error-inline-secret"));

    let malformed = fetch_inventory(&config_path, "safe")
        .await
        .expect_err("malformed");
    assert!(
        malformed.contains("unexpected model listing format"),
        "unexpected error: {malformed}"
    );
    assert!(!malformed.contains("malformed-body-secret"));

    let wrong_shape = fetch_inventory(&config_path, "safe")
        .await
        .expect_err("wrong shape");
    assert!(
        wrong_shape.contains("unexpected model listing format"),
        "unexpected error: {wrong_shape}"
    );

    let oversized = fetch_inventory(&config_path, "safe")
        .await
        .expect_err("declared oversized");
    assert!(
        oversized.contains("too large"),
        "unexpected error: {oversized}"
    );

    let chunked = fetch_inventory(&config_path, "safe")
        .await
        .expect_err("chunked oversized");
    assert!(chunked.contains("too large"), "unexpected error: {chunked}");

    assert!(server.wait_for_requests(5, Duration::from_secs(5)));
    let requests = server.requests();
    assert_eq!(requests.len(), 5);
    assert!(requests.iter().all(|request| request.method == "GET"));
    assert!(requests.iter().all(|request| request.path == "/v1/models"));
}

#[tokio::test]
async fn unknown_or_malicious_packages_are_refused_without_a_request() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(r#"{"data":[]}"#)]);

    let malicious = config_with(
        &directory,
        "malicious-package.json",
        "providers",
        "malicious",
        &format!(
            r#"{{ "package": "malicious-acme-openai", "settings": {{ "baseURL": "{}/v1", "apiKey": "package-secret" }} }}"#,
            server.base_url
        ),
    );
    let error = fetch_inventory(&malicious, "malicious")
        .await
        .expect_err("unknown package");
    assert!(
        error.contains("unsupported package"),
        "unexpected error: {error}"
    );
    assert!(!error.contains("package-secret"));

    let native_anthropic = config_with(
        &directory,
        "anthropic.json",
        "provider",
        "anthropic-custom",
        &format!(
            r#"{{ "npm": "@ai-sdk/anthropic", "options": {{ "baseURL": "{}/v1" }} }}"#,
            server.base_url
        ),
    );
    let error = fetch_inventory(&native_anthropic, "anthropic-custom")
        .await
        .expect_err("unsupported native protocol");
    assert!(
        error.contains("unsupported package"),
        "unexpected error: {error}"
    );
    assert!(
        error.contains("no model-list request"),
        "unexpected error: {error}"
    );

    let missing_base = config_with(
        &directory,
        "missing-base.json",
        "providers",
        "missing-base",
        r#"{"package": "@opencode/ai/providers/openai-compatible"}"#,
    );
    let error = fetch_inventory(&missing_base, "missing-base")
        .await
        .expect_err("missing base URL");
    assert!(
        error.contains("does not define a base URL"),
        "unexpected error: {error}"
    );

    let missing = config_with(
        &directory,
        "missing.json",
        "providers",
        "present",
        r#"{"package": "@opencode/ai/providers/openai-compatible", "settings": {"baseURL": "http://127.0.0.1:9/v1"}}"#,
    );
    let error = fetch_inventory(&missing, "not-present")
        .await
        .expect_err("provider not found");
    assert!(
        error.contains("was not found in this configuration file"),
        "unexpected error: {error}"
    );

    assert_eq!(server.request_count(), 0);
}

#[tokio::test]
async fn pagination_and_empty_listings_add_explicit_warnings() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![
        ResponseSpec::json(r#"{"data":[{"id":"a"}],"has_more":true}"#),
        ResponseSpec::json(r#"{"data":[]}"#),
    ]);
    let config_path = config_with(
        &directory,
        "pagination.json",
        "provider",
        "paged",
        &format!(
            r#"{{ "npm": "@ai-sdk/openai-compatible", "options": {{ "baseURL": "{}/v1" }} }}"#,
            server.base_url
        ),
    );

    let first = fetch_inventory(&config_path, "paged")
        .await
        .expect("pagination warning");
    assert_eq!(first.model_ids, vec!["a"]);
    assert!(first
        .warnings
        .iter()
        .any(|warning| warning.contains("more models may be available")));

    let second = fetch_inventory(&config_path, "paged")
        .await
        .expect("empty listing");
    assert!(second.model_ids.is_empty());
    assert!(second
        .warnings
        .iter()
        .any(|warning| warning.contains("no model IDs")));
}

#[tokio::test]
async fn v1_api_base_field_and_known_openai_provider_are_supported() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(
        r#"{"object":"list","data":[{"id":"gpt-test"}]}"#,
    )]);
    let config_path = config_with(
        &directory,
        "builtin-openai.json",
        "provider",
        "openai",
        &format!(
            r#"{{ "api": "{}/v1", "models": {{ "gpt-test": {{}} }} }}"#,
            server.base_url
        ),
    );

    let inventory = fetch_inventory(&config_path, "openai")
        .await
        .expect("builtin openai inventory");
    assert_eq!(inventory.model_ids, vec!["gpt-test"]);
    assert!(server.wait_for_requests(1, Duration::from_secs(2)));
    assert_eq!(server.requests()[0].path, "/v1/models");
    assert_eq!(server.requests()[0].header("authorization"), None);
}

#[tokio::test]
async fn aisdk_prefixed_package_is_recognized() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(
        r#"{"data":[{"id":"aisdk-model"}]}"#,
    )]);
    let config_path = config_with(
        &directory,
        "aisdk.json",
        "providers",
        "aisdk",
        &format!(
            r#"{{ "package": "aisdk:@ai-sdk/openai-compatible", "settings": {{ "baseURL": "{}/v1", "apiKey": "aisdk-secret" }} }}"#,
            server.base_url
        ),
    );

    let inventory = fetch_inventory(&config_path, "aisdk")
        .await
        .expect("aisdk package inventory");
    assert_eq!(inventory.model_ids, vec!["aisdk-model"]);
    assert_no_secret(&inventory, "aisdk-secret");
}

#[tokio::test]
async fn provider_model_ids_are_preserved_verbatim() {
    let directory = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start(vec![ResponseSpec::json(
        r#"{"data":["z-last","a first","CaseSensitive-ID","z-last"]}"#,
    )]);
    let config_path = config_with(
        &directory,
        "preserve-ids.json",
        "providers",
        "preserve",
        &format!(
            r#"{{ "package": "@opencode/ai/providers/openai-compatible", "settings": {{ "baseURL": "{}/v1" }}, "models": {{ "alias": {{ "modelID": "upstream" }} }} }}"#,
            server.base_url
        ),
    );

    let inventory = fetch_inventory(&config_path, "preserve")
        .await
        .expect("inventory");
    let mut expected = vec![
        "a first".to_string(),
        "CaseSensitive-ID".to_string(),
        "z-last".to_string(),
    ];
    expected.sort();
    assert_eq!(inventory.model_ids, expected);
    assert!(!inventory.model_ids.iter().any(|id| id == "alias"));
    assert!(!inventory.model_ids.iter().any(|id| id == "upstream"));
}

#[test]
fn provider_inventory_dto_uses_camel_case() {
    let inventory = ProviderInventory {
        provider_id: "acme".to_string(),
        model_ids: vec!["m".to_string()],
        fetched_at: "2026-01-01T00:00:00Z".to_string(),
        warnings: vec!["warning".to_string()],
    };
    let json = serde_json::to_value(inventory).expect("serialize");
    assert!(json.get("providerId").is_some());
    assert!(json.get("modelIds").is_some());
    assert!(json.get("fetchedAt").is_some());
}
