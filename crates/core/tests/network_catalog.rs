mod network_support;

use std::fs;
use std::time::Duration;

use oc_providers_core::catalog::{CatalogResult, ModelCandidate, ModelCatalog};
use serde_json::Value;
use tempfile::TempDir;

use network_support::{MockServer, ResponseSpec};

const CATALOG_FIXTURE: &str = r#"
{
  "meta": "generated metadata",
  "not-a-provider": { "id": "not-a-provider" },
  "openai": {
    "id": "openai",
    "name": "OpenAI",
    "models": {
      "gpt-4": {
        "id": "gpt-4",
        "name": "GPT-4",
        "reasoning": false,
        "limit": { "context": 8192, "output": 4096 }
      },
      "gpt-4o": {
        "id": "gpt-4o",
        "name": "GPT-4o",
        "canonical_model_id": "openai/gpt-4o",
        "reasoning": true,
        "reasoning_options": [
          { "type": "effort", "values": ["low", "medium", "high"] },
          { "type": "toggle" }
        ],
        "limit": { "context": 128000, "output": 16384 }
      },
      "gpt4o": {
        "id": "gpt4o",
        "name": "GPT4o no separators",
        "reasoning": false,
        "limit": { "context": 128000, "output": 16384 }
      },
      "gpt-4o-2024-05-13": {
        "id": "gpt-4o-2024-05-13",
        "name": "GPT-4o May 2024",
        "reasoning": true,
        "reasoning_options": [ { "type": "toggle" } ],
        "limit": { "context": "128000", "output": 16384 }
      },
      "gpt-4o-2024-08-06": {
        "id": "gpt-4o-2024-08-06",
        "name": "GPT-4o August 2024",
        "reasoning": true,
        "limit": { "context": 128000, "output": 16384 }
      },
      "coder": {
        "id": "coder",
        "name": "Coder",
        "canonical_model_id": "qwen3-coder",
        "limit": { "context": 32768, "output": 8192 }
      },
      "legacy-alias": {
        "id": "different-declared-id",
        "name": "Legacy alias"
      },
      "budget-reasoner": {
        "id": "budget-reasoner",
        "name": "Budget reasoner",
        "reasoning": true,
        "reasoning_options": [
          { "type": "budget_tokens", "min": 1024, "max": 8192 }
        ]
      },
      "weird-reasoning": {
        "id": "weird-reasoning",
        "name": "Weird reasoning",
        "reasoning": true,
        "reasoning_options": [
          { "type": "unsupported-control", "secretShape": { "nested": true } },
          { "type": "effort", "values": ["extreme", "high"] },
          { "type": "budget_tokens", "min": 1, "max": 99999999999 }
        ]
      },
      "capability-reasoner": {
        "id": "capability-reasoner",
        "name": "Capability reasoner",
        "capabilities": {
          "reasoning": {
            "supported": true,
            "effort": ["low", "high"],
            "budget": { "min": 256, "max": 4096 }
          }
        }
      },
      "direct-reasoning": {
        "id": "direct-reasoning",
        "name": "Direct reasoning",
        "reasoning": {
          "supported": true,
          "toggle": true,
          "budget": { "max": 4096, "arbitrary": "dropped" }
        }
      }
    }
  },
  "proxy": {
    "id": "proxy",
    "name": "Proxy",
    "models": {
      "gpt-4o": {
        "id": "gpt-4o",
        "name": "Proxy GPT-4o",
        "canonical_model_id": "openai/gpt-4o",
        "reasoning": true,
        "reasoning_options": [ { "type": "toggle" } ],
        "limit": { "context": 200000, "output": 24000 }
      }
    }
  },
  "ai-router": {
    "id": "ai-router",
    "name": "AI-ROUTER",
    "models": {
      "gpt-5.4": {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "reasoning": true,
        "reasoning_options": [
          { "type": "effort", "values": ["none", "low", "medium", "high", "xhigh"] }
        ],
        "canonical_model_id": "openai/gpt-5.4",
        "limit": { "context": 1050000, "input": 922000, "output": 128000 }
      }
    }
  },
  "bulk": {
    "id": "bulk",
    "name": "Bulk",
    "models": {
      "bulk-00": {}, "bulk-01": {}, "bulk-02": {}, "bulk-03": {}, "bulk-04": {},
      "bulk-05": {}, "bulk-06": {}, "bulk-07": {}, "bulk-08": {}, "bulk-09": {},
      "bulk-10": {}, "bulk-11": {}, "bulk-12": {}, "bulk-13": {}, "bulk-14": {},
      "bulk-15": {}, "bulk-16": {}, "bulk-17": {}, "bulk-18": {}, "bulk-19": {},
      "bulk-20": {}, "bulk-21": {}, "bulk-22": {}, "bulk-23": {}, "bulk-24": {}
    }
  }
}"#;

const EXPECTED_MODELS: usize = 38;
// Kept in the test rather than exported from the production module.
const RESPONSE_TEST_CAP: usize = 16 * 1024 * 1024;

fn temp_cache() -> TempDir {
    tempfile::tempdir().expect("temporary cache directory")
}

fn catalog_from_server(cache_dir: &TempDir, server: &MockServer) -> ModelCatalog {
    ModelCatalog::with_source(
        cache_dir.path().to_path_buf(),
        format!("{}/api.json", server.base_url),
    )
}

fn find<'a>(candidates: &'a [ModelCandidate], provider: &str, id: &str) -> &'a ModelCandidate {
    candidates
        .iter()
        .find(|candidate| candidate.provider_id == provider && candidate.id == id)
        .unwrap_or_else(|| panic!("candidate {provider}/{id} missing from results"))
}

fn candidate_json(candidate: &ModelCandidate) -> Value {
    serde_json::to_value(candidate).expect("candidate serializes")
}

#[tokio::test]
async fn catalog_refresh_caches_public_metadata_and_searches_locally() {
    let cache_dir = temp_cache();
    // The second response is never spent by this test's own traffic. It exists
    // so that a request the test did not plan for can still be accepted and
    // answered: a server that stops after its planned responses leaves such a
    // request in the kernel backlog, invisible to both the recorded list and
    // `observed_count()`.
    let server = MockServer::start(vec![
        ResponseSpec::json(CATALOG_FIXTURE).with_header("ETag", "\"catalog-v1\""),
        ResponseSpec::empty(500),
    ]);
    let mut catalog = catalog_from_server(&cache_dir, &server);

    let result = catalog.refresh().await.expect("catalog refresh");
    assert_eq!(result.model_count, EXPECTED_MODELS);
    assert!(!result.stale);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("unrecognized")));

    let exact = catalog.search("gpt-4o", None);
    assert_eq!(exact[0].id, "gpt-4o");
    assert_eq!(exact[0].provider_id, "openai");
    assert_eq!(exact[0].score, 0.995);
    assert_eq!(exact[0].canonical_id.as_deref(), Some("openai/gpt-4o"));
    assert!(exact
        .iter()
        .any(|candidate| candidate.provider_id == "proxy"));

    let filtered = catalog.search("gpt-4o", Some("proxy"));
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].provider_id, "proxy");

    let no_remote_query = catalog.search("gpt-4o", Some("openai"));
    // Lower bound: the server records a request only after it has written the
    // response, so a caller that just received one may still see a count that is
    // one short (`network_support/mod.rs`, `wait_for_requests`). Wait for the
    // recorded count instead of reading it immediately.
    assert!(
        server.wait_for_requests(1, Duration::from_secs(2)),
        "the catalog refresh request was never recorded, saw {}",
        server.request_count()
    );
    // Count synchronous requests that wait for a response. The fixture counts
    // them before writing the response, so this assertion can run immediately
    // after search returns. A background request would need separate synchronization.
    assert_eq!(
        server.observed_count(),
        1,
        "search must not perform network requests"
    );
    assert!(!no_remote_query.is_empty());

    // A new instance reads the same fixed public cache without contacting the
    // source.
    let loaded = ModelCatalog::with_source(
        cache_dir.path().to_path_buf(),
        "http://127.0.0.1:1/api.json",
    );
    let cached_results = loaded.search("gpt-4o", None);
    assert!(cached_results
        .iter()
        .any(|candidate| candidate.provider_id == "openai" && candidate.id == "gpt-4o"));
    assert!(cached_results
        .iter()
        .any(|candidate| candidate.provider_id == "proxy" && candidate.id == "gpt-4o"));
}

#[tokio::test]
async fn catalog_uses_etag_conditional_refresh() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![
        ResponseSpec::json(CATALOG_FIXTURE).with_header("ETag", "\"catalog-v1\""),
        ResponseSpec::empty(304),
    ]);
    let mut catalog = catalog_from_server(&cache_dir, &server);

    let first = catalog.refresh().await.expect("first refresh");
    assert_eq!(first.model_count, EXPECTED_MODELS);
    assert!(!first.stale);

    let second = catalog.refresh().await.expect("304 refresh");
    assert_eq!(second.model_count, EXPECTED_MODELS);
    assert!(!second.stale);
    assert!(second.warnings.is_empty());

    assert!(server.wait_for_requests(2, Duration::from_secs(2)));
    let requests = server.requests();
    assert_eq!(requests[1].header("if-none-match"), Some("\"catalog-v1\""));
}

#[tokio::test]
async fn catalog_send_failure_uses_stale_cache() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![ResponseSpec::json(CATALOG_FIXTURE)]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    catalog.refresh().await.expect("prime cache");

    // Reserve a loopback port, then release it so the next connect is refused.
    let closed = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
    let closed_port = closed.local_addr().expect("closed port").port();
    drop(closed);

    let mut offline = ModelCatalog::with_source(
        cache_dir.path().to_path_buf(),
        format!("http://127.0.0.1:{closed_port}/api.json"),
    );
    let result = offline
        .refresh()
        .await
        .expect("stale fallback on send failure");
    assert!(result.stale);
    assert_eq!(result.model_count, EXPECTED_MODELS);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("unreachable")));
}

#[tokio::test]
async fn catalog_falls_back_to_stale_cache_when_offline_or_malformed() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![
        ResponseSpec::json(CATALOG_FIXTURE).with_header("ETag", "\"catalog-v1\""),
        ResponseSpec::empty(503),
        ResponseSpec::json("{ definitely not json"),
    ]);
    let mut catalog = catalog_from_server(&cache_dir, &server);

    let fresh = catalog.refresh().await.expect("fresh refresh");
    assert!(!fresh.stale);
    let cached_time = fresh.fetched_at.clone();

    let error_response = catalog.refresh().await.expect("stale fallback");
    assert!(error_response.stale);
    assert_eq!(error_response.fetched_at, cached_time);
    assert_eq!(error_response.model_count, EXPECTED_MODELS);
    assert!(error_response
        .warnings
        .iter()
        .any(|warning| warning.contains("HTTP 503")));

    let malformed = catalog.refresh().await.expect("malformed fallback");
    assert!(malformed.stale);
    assert!(malformed
        .warnings
        .iter()
        .any(|warning| warning.contains("not valid JSON")));
}

#[tokio::test]
async fn catalog_network_failure_without_cache_is_a_safe_error() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![
        ResponseSpec::empty(503).with_body(r#"{"error":"server-body-secret"}"#)
    ]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    let error = catalog
        .refresh()
        .await
        .expect_err("HTTP failure without cache");
    assert!(error.contains("HTTP 503"), "unexpected error: {error}");
    assert!(!error.contains("server-body-secret"));
}

#[tokio::test]
async fn catalog_rejects_oversized_and_source_policy_violations_safely() {
    let cache_dir = temp_cache();
    let oversized_length = MockServer::start(vec![
        ResponseSpec::json("{}").with_header("Content-Length", "999999999")
    ]);
    let mut catalog = catalog_from_server(&cache_dir, &oversized_length);
    let error = catalog.refresh().await.expect_err("content-length cap");
    assert!(error.contains("too large"), "unexpected error: {error}");

    let cache_dir = temp_cache();
    let chunks = vec![vec![b'x'; RESPONSE_TEST_CAP + 1024 * 1024]];
    let chunked = MockServer::start(vec![ResponseSpec::empty(200).with_chunks(chunks)]);
    let mut catalog = catalog_from_server(&cache_dir, &chunked);
    let error = catalog.refresh().await.expect_err("chunked cap");
    assert!(error.contains("too large"), "unexpected error: {error}");

    let cache_dir = temp_cache();
    let mut plain_http = ModelCatalog::with_source(
        cache_dir.path().to_path_buf(),
        "http://example.com/api.json",
    );
    let error = plain_http.refresh().await.expect_err("remote http");
    assert!(error.contains("HTTPS"), "unexpected error: {error}");

    let cache_dir = temp_cache();
    let mut credentials = ModelCatalog::with_source(
        cache_dir.path().to_path_buf(),
        "http://user:url-secret@127.0.0.1:9/api.json",
    );
    let error = credentials.refresh().await.expect_err("url credentials");
    assert!(error.contains("credentials"));
    assert!(!error.contains("url-secret"));
}

#[tokio::test]
async fn catalog_accepts_small_chunked_responses() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![
        ResponseSpec::empty(200).with_chunks(vec![vec![b'a'; 2048], vec![b'b'; 2048]])
    ]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    let error = catalog.refresh().await.expect_err("invalid chunked json");
    assert!(error.contains("not valid JSON"), "{error}");
}

#[tokio::test]
async fn catalog_searches_canonical_and_preserves_request_ids() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![ResponseSpec::json(CATALOG_FIXTURE)]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    catalog.refresh().await.expect("refresh");

    let canonical = catalog.search("qwen3-coder", None);
    let coder = find(&canonical, "openai", "coder");
    assert_eq!(coder.canonical_id.as_deref(), Some("qwen3-coder"));
    assert_eq!(coder.id, "coder");
    assert_eq!(coder.match_reason, "Exact canonical model ID match");

    let canonical_openai = catalog.search("openai/gpt-5.4", None);
    let routed = find(&canonical_openai, "ai-router", "gpt-5.4");
    assert_eq!(routed.canonical_id.as_deref(), Some("openai/gpt-5.4"));
    assert_eq!(routed.match_reason, "Exact canonical model ID match");

    // A declared object `id` mismatch is not a canonical identity. The map
    // key remains the candidate/request ID.
    let alias = catalog.search("legacy-alias", None);
    let alias = find(&alias, "openai", "legacy-alias");
    assert_eq!(alias.id, "legacy-alias");
    assert_eq!(alias.canonical_id, None);

    let combined = catalog.search("openai/gpt-4o", None);
    let combined_top = &combined[0];
    assert_eq!(combined_top.provider_id, "openai");
    assert_eq!(combined_top.id, "gpt-4o");
    assert_eq!(combined_top.score, 1.0);
    assert_eq!(
        combined_top.match_reason,
        "Exact provider/model reference match"
    );
}

#[tokio::test]
async fn catalog_fuzzy_ranking_keeps_separators_dates_and_versions_distinct() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![ResponseSpec::json(CATALOG_FIXTURE)]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    catalog.refresh().await.expect("refresh");

    let separator = catalog.search("gpt4o", None);
    assert_eq!(separator[0].id, "gpt4o");
    assert_eq!(separator[0].score, 0.995);
    let hyphenated = find(&separator, "openai", "gpt-4o");
    assert!(
        hyphenated.score < separator[0].score,
        "separators must not collapse to an identical exact score"
    );

    let dated = catalog.search("gpt-4o-2024-05-13", None);
    assert_eq!(dated[0].id, "gpt-4o-2024-05-13");
    assert_eq!(dated[0].score, 0.995);
    assert_eq!(dated[0].match_reason, "Exact model ID match");
    let other_date = find(&dated, "openai", "gpt-4o-2024-08-06");
    assert!(
        other_date.score < 1.0,
        "a different date must not be treated as the same model"
    );
    assert!(
        other_date.match_reason != "Exact model ID match",
        "a different date must not receive an exact-match reason"
    );
}

#[tokio::test]
async fn catalog_search_is_bounded_and_cross_provider_for_unknown_filters() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![ResponseSpec::json(CATALOG_FIXTURE)]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    catalog.refresh().await.expect("refresh");

    let bulk = catalog.search("bulk-", None);
    assert_eq!(bulk.len(), 20);
    assert!(bulk.iter().all(|candidate| candidate.provider_id == "bulk"));

    let filtered = catalog.search("gpt-4o", Some("proxy"));
    assert_eq!(filtered.len(), 1);

    let unknown_provider = catalog.search("gpt-4o", Some("custom-gateway"));
    assert!(!unknown_provider.is_empty());
    assert!(unknown_provider[0]
        .match_reason
        .contains("not in the public catalog"));
    assert!(unknown_provider[0]
        .match_reason
        .contains("cross-provider suggestions"));

    let provider_scope = catalog.search("openai", None);
    assert_eq!(provider_scope.len(), 11);
    assert!(provider_scope
        .iter()
        .all(|candidate| candidate.provider_id == "openai"));
    assert!(provider_scope[0]
        .match_reason
        .starts_with("Provider ID match"));
}

#[tokio::test]
async fn catalog_normalizes_reasoning_to_bounded_v2_shape() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![ResponseSpec::json(CATALOG_FIXTURE)]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    catalog.refresh().await.expect("refresh");

    let candidates = catalog.search("gpt-4o", Some("openai"));
    let gpt4o = find(&candidates, "openai", "gpt-4o");
    let reasoning = gpt4o.reasoning.as_ref().expect("reasoning suggestion");
    let object = reasoning.as_object().expect("reasoning object");
    assert_eq!(object.get("supported"), Some(&Value::Bool(true)));
    assert_eq!(object.get("toggle"), Some(&Value::Bool(true)));
    assert_eq!(
        object.get("effort"),
        Some(&Value::Array(vec![
            Value::String("low".into()),
            Value::String("medium".into()),
            Value::String("high".into())
        ]))
    );
    assert_eq!(
        object.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["effort", "supported", "toggle"]
    );

    let budget = catalog.search("budget-reasoner", None);
    let budget = find(&budget, "openai", "budget-reasoner");
    let budget_reasoning = budget.reasoning.as_ref().unwrap();
    assert_eq!(budget_reasoning["budget"]["min"], serde_json::json!(1024));
    assert_eq!(budget_reasoning["budget"]["max"], serde_json::json!(8192));

    let gpt4 = catalog.search("gpt-4", Some("openai"));
    let gpt4 = find(&gpt4, "openai", "gpt-4");
    assert_eq!(
        gpt4.reasoning.as_ref().unwrap()["supported"],
        Value::Bool(false)
    );

    let weird = catalog.search("weird-reasoning", None);
    let weird = find(&weird, "openai", "weird-reasoning");
    let weird = weird.reasoning.as_ref().unwrap();
    assert_eq!(weird["effort"], serde_json::json!(["high"]));
    assert_eq!(weird["budget"]["min"], serde_json::json!(1));
    assert!(weird["budget"].get("max").is_none());
    assert!(weird.get("secretShape").is_none());
    assert_eq!(
        weird
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["budget", "effort", "supported"]
    );

    let capability = catalog.search("capability-reasoner", None);
    let capability = find(&capability, "openai", "capability-reasoner");
    let capability = capability.reasoning.as_ref().unwrap();
    assert_eq!(capability["effort"], serde_json::json!(["low", "high"]));
    assert_eq!(capability["budget"]["min"], serde_json::json!(256));
    assert_eq!(capability["budget"]["max"], serde_json::json!(4096));

    let direct = catalog.search("direct-reasoning", None);
    let direct = find(&direct, "openai", "direct-reasoning");
    let direct = direct.reasoning.as_ref().unwrap();
    assert_eq!(direct["supported"], Value::Bool(true));
    assert_eq!(direct["toggle"], Value::Bool(true));
    assert_eq!(direct["budget"]["max"], serde_json::json!(4096));
    assert!(direct.get("arbitrary").is_none());

    let alias = catalog.search("legacy-alias", None);
    let alias = find(&alias, "openai", "legacy-alias");
    assert!(alias.reasoning.is_none());
}

#[tokio::test]
async fn catalog_dtos_use_camel_case_and_public_metadata_only() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![ResponseSpec::json(CATALOG_FIXTURE)]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    let result = catalog.refresh().await.expect("refresh");
    let result_json = serde_json::to_value(&result).expect("result json");
    assert!(result_json.get("modelCount").is_some());
    assert!(result_json.get("fetchedAt").is_some());

    let candidates = catalog.search("gpt-4o", Some("openai"));
    let candidate = candidate_json(&candidates[0]);
    assert!(candidate.get("providerId").is_some());
    assert!(candidate.get("canonicalId").is_some());
    assert!(candidate.get("matchReason").is_some());
    assert!(!candidate.to_string().contains("sk-"));

    let cache_file = cache_dir.path().join("models-dev-public-catalog.v2.json");
    assert!(cache_file.exists(), "public metadata cache should exist");
    let cached = fs::read_to_string(&cache_file).expect("cache read");
    assert!(!cached.contains("server-body-secret"));
    assert!(cached.contains("canonical_id"));
}

#[tokio::test]
async fn catalog_requires_structurally_valid_provider_entries() {
    let cache_dir = temp_cache();
    let server = MockServer::start(vec![ResponseSpec::json(r#"{"meta":true,"providers":42}"#)]);
    let mut catalog = catalog_from_server(&cache_dir, &server);
    let error = catalog.refresh().await.expect_err("no providers");
    assert!(
        error.contains("no structurally valid provider entries"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
#[ignore = "public models.dev smoke check; the deterministic suite uses fixture servers"]
async fn live_models_dev_catalog_smoke() {
    let cache_dir = temp_cache();
    let mut catalog = ModelCatalog::new(cache_dir.path().to_path_buf());
    let result = catalog.refresh().await.expect("live models.dev refresh");
    assert!(result.model_count > 1_000, "unexpected live model count");
    assert!(!result.stale);

    let candidates = catalog.search("gpt-4o", None);
    assert!(!candidates.is_empty());
    for candidate in &candidates {
        if let Some(reasoning) = &candidate.reasoning {
            assert!(reasoning.is_object(), "reasoning must be normalized");
            assert!(
                reasoning
                    .get("supported")
                    .and_then(Value::as_bool)
                    .is_some(),
                "normalized reasoning must include a boolean supported flag"
            );
        }
    }
    assert!(
        catalog
            .search("gpt-5.4", None)
            .iter()
            .any(|candidate| candidate.canonical_id.is_some()),
        "live catalog should expose canonical_model_id when present"
    );
}

#[test]
fn catalog_types_are_public_and_serializable() {
    let candidate = ModelCandidate {
        provider_id: "p".to_string(),
        id: "m".to_string(),
        name: "M".to_string(),
        canonical_id: None,
        context: None,
        input: None,
        output: None,
        reasoning: Some(serde_json::json!({ "supported": true })),
        score: 0.5,
        match_reason: "test".to_string(),
    };
    let result = CatalogResult {
        model_count: 1,
        fetched_at: "2026-01-01T00:00:00Z".to_string(),
        stale: false,
        warnings: Vec::new(),
    };
    assert_eq!(
        serde_json::to_value(candidate).unwrap()["reasoning"]["supported"],
        Value::Bool(true)
    );
    assert_eq!(
        serde_json::to_value(result).unwrap()["modelCount"],
        serde_json::json!(1)
    );
}

// Inject a second request to verify the fixture can observe it.
#[tokio::test]
async fn mock_server_observes_a_request_beyond_the_planned_responses() {
    // The catalog test's shape: one planned response, one unwritten spare.
    let server = MockServer::start(vec![
        ResponseSpec::json(CATALOG_FIXTURE).with_header("ETag", "\"catalog-v1\""),
        ResponseSpec::empty(500),
    ]);

    // One planned request, sent the way the client sends it.
    let first = reqwest::Client::new()
        .get(format!("{}/api.json", server.base_url))
        .send()
        .await
        .expect("first request");
    assert_eq!(first.status().as_u16(), 200);
    assert!(server.wait_for_requests(1, Duration::from_secs(2)));

    // A second request the fixture did not plan for.
    let second = reqwest::Client::new()
        .get(format!("{}/api.json", server.base_url))
        .send()
        .await
        .expect("second request");
    assert_eq!(second.status().as_u16(), 500);

    // The point of the whole exercise: the extra request is observable.
    assert_eq!(
        server.observed_count(),
        2,
        "the fixture must see a request it did not plan for"
    );
}
