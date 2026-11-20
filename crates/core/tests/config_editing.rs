use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use oc_providers_core::{
    commit_changes, prepare_changes, read_document, restore_last_backup, CredentialStatus, Dialect,
    Edit, EditOp, SourceDocument,
};
use serde_json::{json, Value};
use tempfile::TempDir;

struct TestSupport {
    _dir: TempDir,
    backup_dir: PathBuf,
}

fn support() -> &'static TestSupport {
    static SUPPORT: OnceLock<TestSupport> = OnceLock::new();
    SUPPORT.get_or_init(|| {
        let dir = tempfile::tempdir().expect("tempdir");
        let backup_dir = dir.path().join("backups");
        fs::create_dir_all(&backup_dir).expect("backup dir");
        std::env::set_var("OC_PROVIDERS_CTL_BACKUP_DIR", &backup_dir);
        TestSupport {
            _dir: dir,
            backup_dir,
        }
    })
}

fn backup_dir() -> PathBuf {
    support().backup_dir.clone()
}

fn backup_count_for(prefix: &str) -> usize {
    fs::read_dir(backup_dir())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
                .count()
        })
        .unwrap_or(0)
}

fn write_config(name: &str, bytes: &[u8]) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("config tempdir");
    let path = dir.path().join(name);
    fs::write(&path, bytes).expect("write fixture");
    (dir, path)
}

fn edit_set(path: &[&str], value: Value) -> Edit {
    Edit {
        op: EditOp::Set,
        path: path.iter().map(|s| s.to_string()).collect(),
        value: Some(value),
    }
}

fn edit_remove(path: &[&str]) -> Edit {
    Edit {
        op: EditOp::Remove,
        path: path.iter().map(|s| s.to_string()).collect(),
        value: None,
    }
}

fn v1_fixture() -> String {
    "\u{feff}{\r\n  // header comment\r\n  \"$schema\": \"https://opencode.ai/config.json\",\r\n  \"theme\": \"custom-theme\",\r\n  \"model\": \"acme/coder\",\r\n  \"provider\": {\r\n    // provider comment\r\n    \"acme\": {\r\n      \"npm\": \"@ai-sdk/openai-compatible\",\r\n      \"name\": \"Acme\",\r\n      \"options\": {\r\n        \"baseURL\": \"https://user:secret@api.acme.test/v1\",\r\n        \"apiKey\": \"sk-live-NEVER-LEAK\",\r\n        \"timeout\": 30000,\r\n      },\r\n      \"models\": {\r\n        \"coder\": {\r\n          \"name\": \"Acme Coder\",\r\n          \"id\": \"upstream-coder\",\r\n          \"reasoning\": true,\r\n          \"limit\": { \"context\": 32000, \"output\": 4096 },\r\n          \"variants\": {\r\n            \"high\": { \"reasoningEffort\": \"high\", \"headers\": { \"Authorization\": \"Bearer variant-secret\" } },\r\n          },\r\n        },\r\n      },\r\n    },\r\n  },\r\n}\r\n".to_string()
}

fn v2_fixture() -> &'static str {
    "{\n  // V2 configuration\n  \"model\": \"acme/coder\",\n  \"providers\": {\n    \"acme\": {\n      \"package\": \"@opencode/ai/providers/openai-compatible\",\n      \"name\": \"Acme V2\",\n      \"settings\": {\n        \"baseURL\": \"{env:ACME_BASE_URL}\",\n        \"apiKey\": \"v2-inline-secret\",\n      },\n      \"models\": {\n        \"coder\": {\n          \"modelID\": \"upstream/coder-v2\",\n          \"name\": \"Acme Coder\",\n          \"limit\": { \"context\": 64000, \"input\": 32000, \"output\": 8192 },\n          \"capabilities\": { \"reasoning\": { \"supported\": true, \"effort\": [\"high\"] } },\n          \"variants\": [\n            { \"id\": \"high\", \"settings\": { \"reasoningEffort\": \"high\" } },\n          ],\n        },\n      },\n    },\n  },\n}\n"
}

fn assert_dto_has_no_secret(doc: &SourceDocument, secrets: &[&str]) {
    let serialized = serde_json::to_string(doc).expect("serialize DTO");
    for secret in secrets {
        assert!(
            !serialized.contains(secret),
            "DTO leaked forbidden value {secret:?}: {serialized}"
        );
    }
}

#[test]
fn safe_variant_strings_survive_dto_redaction() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let doc = read_document(&path).expect("read v2");
    let variants = doc.providers[0].models[0]
        .variants
        .as_ref()
        .expect("variants");
    assert_eq!(variants[0]["id"], json!("high"));
    assert_eq!(variants[0]["settings"]["reasoningEffort"], json!("high"));
    assert_eq!(
        doc.providers[0].models[0].reasoning.as_ref().unwrap()["effort"],
        json!(["high"])
    );
}

#[test]
fn read_v1_document_redacts_credentials_and_reports_structure() {
    let (_dir, path) = write_config("opencode.jsonc", v1_fixture().as_bytes());
    let doc = read_document(&path).expect("read v1");

    assert_eq!(doc.dialect, Dialect::V1);
    assert!(doc.writable);
    assert_eq!(doc.hash.len(), 64);
    assert_eq!(doc.default_model.as_deref(), Some("acme/coder"));
    assert_eq!(doc.providers.len(), 1);

    let provider = &doc.providers[0];
    assert_eq!(provider.id, "acme");
    assert_eq!(provider.dialect, Dialect::V1);
    assert_eq!(provider.name.as_deref(), Some("Acme"));
    assert_eq!(
        provider.base_url.as_deref(),
        Some("https://api.acme.test/v1")
    );
    assert_eq!(provider.credential_status, CredentialStatus::Inline);
    assert_eq!(provider.models.len(), 1);

    let model = &provider.models[0];
    assert_eq!(model.id, "coder");
    assert_eq!(model.request_id.as_deref(), Some("upstream-coder"));
    assert_eq!(model.context, Some(32000));
    assert_eq!(model.output, Some(4096));
    assert_eq!(model.reasoning, Some(json!(true)));
    assert_userinfo_gone(&doc);
    assert_dto_has_no_secret(
        &doc,
        &[
            "sk-live-NEVER-LEAK",
            "Bearer variant-secret",
            "variant-secret",
            "user:secret",
        ],
    );

    let warnings = doc.warnings.join("\n");
    assert!(warnings.contains("base URL containing credentials"));
}

fn assert_userinfo_gone(doc: &SourceDocument) {
    let base = doc.providers[0].base_url.as_deref().unwrap_or("");
    assert!(!base.contains("user:secret"));
}

#[test]
fn read_v2_document_and_mixed_top_level_are_supported() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let doc = read_document(&path).expect("read v2");
    assert_eq!(doc.dialect, Dialect::V2);
    assert!(doc.writable);
    let provider = &doc.providers[0];
    assert_eq!(provider.dialect, Dialect::V2);
    assert_eq!(provider.base_url.as_deref(), Some("{env:ACME_BASE_URL}"));
    assert_eq!(provider.credential_status, CredentialStatus::Inline);
    let model = &provider.models[0];
    assert_eq!(model.request_id.as_deref(), Some("upstream/coder-v2"));
    assert_eq!(model.context, Some(64000));
    assert_eq!(model.input, Some(32000));
    assert!(model.reasoning.is_some());
    assert!(model.variants.as_ref().is_some_and(|v| v.is_array()));
    assert_dto_has_no_secret(&doc, &["v2-inline-secret"]);

    let mixed = "{\n  \"provider\": { \"legacy\": { \"npm\": \"pkg\" } },\n  \"providers\": { \"modern\": { \"package\": \"pkg2\" } }\n}\n";
    let (_dir2, path2) = write_config("mixed.jsonc", mixed.as_bytes());
    let mixed_doc = read_document(&path2).expect("read mixed");
    assert_eq!(mixed_doc.dialect, Dialect::Mixed);
    assert!(mixed_doc.writable);
    assert_eq!(mixed_doc.providers.len(), 2);
    assert_eq!(mixed_doc.providers[0].dialect, Dialect::V1);
    assert_eq!(mixed_doc.providers[1].dialect, Dialect::V2);
}

#[test]
fn ambiguous_document_requires_explicit_provider_map_creation() {
    let source = b"{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"theme\": \"custom-theme\"\n}\n";
    let (_dir, path) = write_config("opencode.jsonc", source);
    let doc = read_document(&path).expect("read ambiguous");
    assert_eq!(doc.dialect, Dialect::Ambiguous);
    assert!(doc.writable);

    let default_edit = edit_set(&["model"], json!("acme/coder"));
    let err =
        prepare_changes(&path, &doc.hash, &[default_edit]).expect_err("ambiguous default model");
    assert!(err.contains("explicit provider format"));

    let creation = edit_set(
        &["provider", "first"],
        json!({ "npm": "@ai-sdk/openai-compatible", "name": "First" }),
    );
    let prepared = prepare_changes(&path, &doc.hash, &[creation]).expect("prepare creation");
    assert_eq!(prepared.preview.edit_count, 1);
    commit_changes(&prepared).expect("commit creation");

    let after = read_document(&path).expect("reread");
    assert_eq!(after.dialect, Dialect::V1);
    assert_eq!(after.providers.len(), 1);
    let text = fs::read_to_string(&path).expect("read text");
    assert!(text.contains("\"theme\": \"custom-theme\""));
    assert!(text.contains("\"provider\":"));
}

#[test]
fn rejects_unsafe_nested_mixture_and_duplicate_keys() {
    let unsafe_source = br#"{
  "providers": {
    "broken": {
      "npm": "@ai-sdk/openai-compatible",
      "package": "@opencode/ai/providers/openai-compatible"
    }
  }
}"#;
    let (_dir, path) = write_config("unsafe.jsonc", unsafe_source);
    let doc = read_document(&path).expect("read unsafe");
    assert_eq!(doc.dialect, Dialect::V2);
    assert!(!doc.writable);
    assert_eq!(doc.providers[0].dialect, Dialect::Mixed);
    let err = prepare_changes(&path, &doc.hash, &[edit_set(&["model"], json!("x/y"))])
        .expect_err("unsafe mixture");
    assert!(err.contains("unsafe mixture") || err.contains("read-only"));

    let duplicates = br#"{
  "provider": {
    "dup": {"npm": "pkg-one"},
    "dup": {"npm": "pkg-two"}
  }
}"#;
    let (_dir2, path2) = write_config("duplicates.jsonc", duplicates);
    let dup_doc = read_document(&path2).expect("read duplicates");
    assert!(!dup_doc.writable);
    assert!(dup_doc.warnings.iter().any(|w| w.contains("Duplicate")));
    let err = prepare_changes(&path2, &dup_doc.hash, &[edit_set(&["model"], json!("x/y"))])
        .expect_err("duplicates");
    assert!(err.contains("Duplicate"));
}

#[test]
fn prepare_and_commit_preserve_comments_bom_crlf_trailing_commas_and_credentials() {
    let original = v1_fixture().into_bytes();
    let (_dir, path) = write_config("opencode.jsonc", &original);
    let before = read_document(&path).expect("read before");

    let edits = vec![
        edit_set(
            &["provider", "acme", "options", "baseURL"],
            json!("https://api.acme.test/v2"),
        ),
        edit_set(
            &["provider", "acme", "models", "coder", "name"],
            json!("Acme Coder v2"),
        ),
        edit_set(
            &["provider", "acme", "models", "coder", "limit", "context"],
            json!(64000),
        ),
        edit_set(&["model"], json!("acme/coder")),
    ];

    let prepared = prepare_changes(&path, &before.hash, &edits).expect("prepare");
    assert!(!prepared.preview.diff.contains("sk-live-NEVER-LEAK"));
    assert!(!prepared.preview.diff.contains("variant-secret"));
    assert!(!prepared.preview.diff.contains("user:secret"));
    assert!(prepared.preview.diff.contains("semantic change preview"));

    let after = commit_changes(&prepared).expect("commit");
    let bytes = fs::read(&path).expect("read committed bytes");
    assert_eq!(&bytes[..3], &[0xef, 0xbb, 0xbf], "BOM preserved");

    let text = String::from_utf8(bytes[3..].to_vec()).expect("utf8");
    assert!(text.contains("\r\n"));
    assert!(!text.replace("\r\n", "").contains('\n'), "only CRLF stays");

    let original_text = String::from_utf8(original[3..].to_vec()).expect("original utf8");
    let diff = similar::TextDiff::from_lines(&original_text, &text);
    let changed_lines = diff
        .iter_all_changes()
        .filter(|change| change.tag() != similar::ChangeTag::Equal)
        .count();
    assert!(
        changed_lines <= 10,
        "unrelated lines were rewritten: {changed_lines} changed"
    );
    assert!(text.contains("// header comment"));
    assert!(text.contains("// provider comment"));
    assert!(text.contains("\"theme\": \"custom-theme\""));
    assert!(text.contains("\"apiKey\": \"sk-live-NEVER-LEAK\""));
    assert!(text.contains("Bearer variant-secret"));
    assert!(text.contains("\"timeout\": 30000,"));
    assert!(text.contains("\"baseURL\": \"https://api.acme.test/v2\","));
    assert!(text.contains("\"name\": \"Acme Coder v2\","));
    assert!(text.contains("\"context\": 64000,"));
    assert_eq!(after.hash.len(), 64);
    assert!(after.providers[0].base_url.as_deref() == Some("https://api.acme.test/v2"));

    let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temporary sibling must be removed");

    let restored = restore_last_backup(&path, &after.hash).expect("restore");
    let restored_bytes = fs::read(&path).expect("restore bytes");
    assert_eq!(restored_bytes, original);
    assert_eq!(restored.dialect, Dialect::V1);
}

#[test]
fn commit_refuses_stale_hash_without_modifying_file() {
    let (_dir, path) = write_config("stale-hash.jsonc", v2_fixture().as_bytes());
    let before = read_document(&path).expect("read");
    let edit = edit_set(
        &["providers", "acme", "settings", "baseURL"],
        json!("https://api.acme.test/v2"),
    );
    let prepared = prepare_changes(&path, &before.hash, &[edit]).expect("prepare");

    let external = format!("{}\n// external change\n", v2_fixture());
    fs::write(&path, external.as_bytes()).expect("external write");
    let backups_before = backup_count_for("stale-hash-");

    let err = commit_changes(&prepared).expect_err("stale commit");
    assert!(err.contains("changed after"));
    let bytes = fs::read_to_string(&path).expect("read external");
    assert!(bytes.ends_with("// external change\n"));
    assert_eq!(
        backup_count_for("stale-hash-"),
        backups_before,
        "no backup on stale hash"
    );
}

#[test]
fn rejects_credential_edits_redacted_roundtrips_and_whole_replacements() {
    let (_dir, path) = write_config("opencode.jsonc", v1_fixture().as_bytes());
    let doc = read_document(&path).expect("read");

    let credential_path = edit_set(
        &["provider", "acme", "options", "apiKey"],
        json!("new-secret"),
    );
    let err = prepare_changes(&path, &doc.hash, &[credential_path]).expect_err("credential path");
    assert!(err.contains("baseURL") || err.contains("credential"));

    let whole_provider = edit_set(&["provider", "acme"], json!({ "npm": "replacement" }));
    let err = prepare_changes(&path, &doc.hash, &[whole_provider]).expect_err("whole provider");
    assert!(err.contains("Replacing an existing provider"));

    let whole_model = edit_set(
        &["provider", "acme", "models", "coder"],
        json!({ "name": "x" }),
    );
    let err = prepare_changes(&path, &doc.hash, &[whole_model]).expect_err("whole model");
    assert!(err.contains("Replacing an existing model"));

    let nested_secret = edit_set(
        &["provider", "brand-new"],
        json!({
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "https://safe.test", "apiKey": "secret" }
        }),
    );
    let err = prepare_changes(&path, &doc.hash, &[nested_secret]).expect_err("nested secret");
    assert!(
        err.contains("baseURL") || err.contains("credential") || err.contains("cannot be added")
    );

    let headers = edit_set(
        &["providers", "brand-new"],
        json!({
            "package": "pkg",
            "headers": { "Authorization": "Bearer abc" }
        }),
    );
    let err = prepare_changes(&path, &doc.hash, &[headers]).expect_err("headers");
    assert!(err.contains("headers") || err.contains("cannot be added"));

    let redacted = edit_set(&["provider", "acme", "name"], json!("[REDACTED]"));
    let err = prepare_changes(&path, &doc.hash, &[redacted]).expect_err("redacted");
    assert!(err.contains("Redacted"));

    let existing_secret_variants = edit_set(
        &["provider", "acme", "models", "coder", "variants"],
        json!({ "high": { "reasoningEffort": "high" } }),
    );
    let err = prepare_changes(&path, &doc.hash, &[existing_secret_variants])
        .expect_err("replace secret variants");
    assert!(err.contains("variants contain credential"));

    let unrelated = edit_set(&["theme"], json!("other"));
    let err = prepare_changes(&path, &doc.hash, &[unrelated]).expect_err("unrelated root");
    assert!(err.contains("Only provider"));

    let invalid_default = edit_set(&["model"], json!(42));
    let err = prepare_changes(&path, &doc.hash, &[invalid_default]).expect_err("default type");
    assert!(err.contains("must be a string"));
}

#[test]
fn rejects_duplicate_and_ancestor_edits() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let doc = read_document(&path).expect("read");

    let duplicate = vec![
        edit_set(&["model"], json!("acme/coder")),
        edit_set(&["model"], json!("acme/coder")),
    ];
    let err = prepare_changes(&path, &doc.hash, &duplicate).expect_err("duplicate edit");
    assert!(err.contains("same path"));

    let nested = vec![
        edit_set(
            &["providers", "acme", "settings", "baseURL"],
            json!("https://x.test"),
        ),
        edit_set(&["providers", "acme"], json!({ "package": "pkg" })),
    ];
    let err = prepare_changes(&path, &doc.hash, &nested).expect_err("ancestor edit");
    assert!(err.contains("ancestor"));
}

#[test]
fn v2_edits_preserve_trivia_and_supported_fields() {
    let original = v2_fixture();
    let (_dir, path) = write_config("opencode.jsonc", original.as_bytes());
    let before = read_document(&path).expect("read");
    assert!(before.writable);

    let new_variants = json!([
        { "id": "balanced", "settings": { "reasoningEffort": "medium" } },
    ]);
    let edits = vec![
        edit_set(
            &["providers", "acme", "settings", "baseURL"],
            json!("https://api.acme.test/v2"),
        ),
        edit_set(
            &["providers", "acme", "models", "coder", "modelID"],
            json!("upstream/coder-next"),
        ),
        edit_set(
            &[
                "providers",
                "acme",
                "models",
                "coder",
                "capabilities",
                "reasoning",
            ],
            json!({ "supported": true, "effort": ["medium"], "toggle": true, "budget": { "min": 0, "max": 4096 } }),
        ),
        edit_set(
            &["providers", "acme", "models", "coder", "variants"],
            new_variants,
        ),
    ];
    let prepared = prepare_changes(&path, &before.hash, &edits).expect("prepare v2");
    let after = commit_changes(&prepared).expect("commit v2");
    let reread = read_document(&path).expect("reread v2 capabilities");
    let expected_reasoning = json!({
        "supported": true, "effort": ["medium"], "toggle": true,
        "budget": { "min": 0, "max": 4096 }
    });
    assert_eq!(
        after.providers[0].models[0].reasoning,
        Some(expected_reasoning.clone())
    );
    assert_eq!(
        reread.providers[0].models[0].reasoning,
        Some(expected_reasoning)
    );
    assert_eq!(
        after.providers[0].models[0].request_id.as_deref(),
        Some("upstream/coder-next")
    );
    assert_eq!(
        after.providers[0].base_url.as_deref(),
        Some("https://api.acme.test/v2")
    );

    let text = fs::read_to_string(&path).expect("read v2 text");
    assert!(text.contains("// V2 configuration"));
    assert!(text.contains("\"apiKey\": \"v2-inline-secret\","));
    assert!(text.contains("\"context\": 64000,"));
    assert!(text.contains("\"id\": \"balanced\","));
    assert!(text.contains("\"reasoningEffort\": \"medium\""));
}

#[test]
fn preview_masks_environment_references_and_credentials() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let doc = read_document(&path).expect("read");
    let prepared = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["providers", "acme", "settings", "baseURL"],
            json!("{env:TOP_SECRET_ENV_NAME}"),
        )],
    )
    .expect("prepare reference");
    assert!(prepared.preview.diff.contains("[reference]"));
    assert!(!prepared.preview.diff.contains("TOP_SECRET_ENV_NAME"));
    assert!(!prepared.preview.diff.contains("v2-inline-secret"));
    assert!(!prepared.preview.diff.contains("apiKey"));

    // A preview for a URL carrying hidden query secrets must not echo them.
    let secret_source = b"{\n  \"providers\": {\n    \"p\": {\n      \"package\": \"pkg\",\n      \"settings\": { \"baseURL\": \"https://api.test/v1?access_token=ACCESS-SECRET&api-key=API-KEY-SECRET\" }\n    }\n  }\n}\n";
    let (_dir2, path2) = write_config("preview-url.jsonc", secret_source);
    let doc2 = read_document(&path2).expect("read preview url");
    let prepared2 = prepare_changes(
        &path2,
        &doc2.hash,
        &[edit_set(
            &["providers", "p", "settings", "baseURL"],
            json!("https://api.test/v2"),
        )],
    )
    .expect("prepare preview url");
    for marker in ["ACCESS-SECRET", "API-KEY-SECRET", "access_token", "api-key"] {
        assert!(
            !prepared2.preview.diff.contains(marker),
            "preview leaked {marker:?}"
        );
    }
    assert!(!serde_json::to_string(&doc2)
        .expect("serialize")
        .contains("ACCESS-SECRET"));
}

#[test]
fn restore_last_backup_rejects_external_changes_and_requires_a_commit() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let initial = read_document(&path).expect("read");
    let err = restore_last_backup(&path, &initial.hash).expect_err("no backup");
    assert!(err.contains("No backup"));

    let prepared = prepare_changes(
        &path,
        &initial.hash,
        &[edit_set(
            &["providers", "acme", "models", "coder", "name"],
            json!("Changed Name"),
        )],
    )
    .expect("prepare");
    let committed = commit_changes(&prepared).expect("commit");
    let external = format!(
        "{}\n// external change after commit\n",
        fs::read_to_string(&path).unwrap()
    );
    fs::write(&path, external.as_bytes()).expect("external write");

    let err = restore_last_backup(&path, &committed.hash).expect_err("external restore");
    assert!(err.contains("changed since"));
    let current = fs::read_to_string(&path).expect("read external");
    assert!(current.ends_with("// external change after commit\n"));
}

#[test]
fn v1_api_base_url_fallback_and_precedence_are_reported_without_losing_fields() {
    let source = b"{\n  \"provider\": {\n    \"api-only\": {\n      \"api\": \"https://api-only.test/v1\",\n      \"models\": {}\n    },\n    \"both\": {\n      \"api\": \"https://api-legacy.test/v1\",\n      \"options\": { \"baseURL\": \"https://api-options.test/v1\" }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("opencode.jsonc", source);
    let doc = read_document(&path).expect("read v1 api");
    assert_eq!(doc.dialect, Dialect::V1);
    assert_eq!(
        doc.providers[0].base_url.as_deref(),
        Some("https://api-only.test/v1")
    );
    assert_eq!(
        doc.providers[1].base_url.as_deref(),
        Some("https://api-options.test/v1")
    );
    let warnings = doc.warnings.join("\n");
    assert!(warnings.contains("legacy provider.api"));
    assert!(warnings.contains("options.baseURL is the effective base URL"));

    let prepared = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["provider", "api-only", "options", "baseURL"],
            json!("https://api-only.test/v2"),
        )],
    )
    .expect("edit api fallback provider");
    let after = commit_changes(&prepared).expect("commit api fallback provider");
    assert_eq!(
        after.providers[0].base_url.as_deref(),
        Some("https://api-only.test/v2")
    );
    let text = fs::read_to_string(&path).expect("read v1 api text");
    assert!(text.contains("\"api\": \"https://api-only.test/v1\""));
    assert!(text.contains("\"baseURL\": \"https://api-only.test/v2\""));
}

#[test]
fn v2_reasoning_shape_is_strictly_validated() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let doc = read_document(&path).expect("read");
    let path_to_reasoning = [
        "providers",
        "acme",
        "models",
        "coder",
        "capabilities",
        "reasoning",
    ];
    let valid = edit_set(
        &path_to_reasoning,
        json!({
            "supported": true,
            "toggle": true,
            "effort": ["low", "high"],
            "budget": { "min": 64, "max": 8192 }
        }),
    );
    prepare_changes(&path, &doc.hash, &[valid]).expect("valid reasoning shape");

    for (label, value, expected) in [
        (
            "scalar effort",
            json!({ "supported": true, "effort": "high" }),
            "effort must be an array",
        ),
        (
            "missing supported",
            json!({ "effort": ["high"] }),
            "requires a boolean `supported`",
        ),
        (
            "false with effort",
            json!({ "supported": false, "effort": ["high"] }),
            "supported:false",
        ),
        (
            "duplicate effort",
            json!({ "supported": true, "effort": ["high", "high"] }),
            "unique",
        ),
        (
            "bad budget",
            json!({ "supported": true, "budget": { "min": 10, "max": 5 } }),
            "cannot exceed",
        ),
        (
            "unknown field",
            json!({ "supported": true, "verbosity": "high" }),
            "Unsupported",
        ),
    ] {
        let err = prepare_changes(&path, &doc.hash, &[edit_set(&path_to_reasoning, value)])
            .expect_err(label);
        assert!(err.contains(expected), "{label}: {err}");
    }
}

#[test]
fn credential_status_distinguishes_references_and_absence() {
    let source = b"{\n  \"providers\": {\n    \"referenced\": {\n      \"package\": \"pkg\",\n      \"env\": [\"ACME_API_KEY\"],\n      \"settings\": { \"baseURL\": \"https://api.acme.test/v1\" }\n    },\n    \"plain\": { \"package\": \"pkg2\" }\n  }\n}\n";
    let (_dir, path) = write_config("status.jsonc", source);
    let doc = read_document(&path).expect("read statuses");
    assert_eq!(
        doc.providers[0].credential_status,
        CredentialStatus::Reference
    );
    assert_eq!(doc.providers[1].credential_status, CredentialStatus::None);
    let serialized = serde_json::to_string(&doc).expect("serialize");
    assert!(!serialized.contains("ACME_API_KEY"));
}

#[test]
fn invalid_jsonc_is_reported_read_only() {
    let (_dir, path) = write_config("opencode.json", b"{ \"provider\": { ");
    let doc = read_document(&path).expect("read invalid");
    assert_eq!(doc.dialect, Dialect::Invalid);
    assert!(!doc.writable);
    assert!(doc.providers.is_empty());
    let err = prepare_changes(&path, &doc.hash, &[edit_set(&["model"], json!("x/y"))])
        .expect_err("invalid edit");
    assert!(err.contains("parsed safely"));
}

/// A model that carries no `limit` block yet must still accept its leaf fields.
///
/// The user-visible symptom was "The parent object does not exist." when adding
/// any limit value to a model that had no other parameters: validation demanded
/// an existing `limit` object while the write path already auto-creates missing
/// intermediate objects. Both dialects are covered, and both `limit` leaves the
/// editor exposes are exercised.
#[test]
fn limit_leaves_are_creatable_when_the_model_has_no_limit_block() {
    let v1 = b"{\n  \"provider\": {\n    \"acme\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"models\": {\n        \"bare\": { \"name\": \"Bare\" }\n      }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("bare-v1.jsonc", v1);
    let before = read_document(&path).expect("read v1");
    let prepared = prepare_changes(
        &path,
        &before.hash,
        &[edit_set(
            &["provider", "acme", "models", "bare", "limit", "context"],
            json!(128000),
        )],
    )
    .expect("creating limit.context on a model without limit must be allowed");
    commit_changes(&prepared).expect("commit v1 limit");
    let text = fs::read_to_string(&path).expect("read v1 back");
    assert!(
        text.contains("\"limit\": {"),
        "limit block created in V1: {text}"
    );
    assert!(
        text.contains("\"context\": 128000"),
        "value written in V1: {text}"
    );

    let v2 = b"{\n  \"providers\": {\n    \"acme\": {\n      \"package\": \"@opencode/ai/providers/openai-compatible\",\n      \"models\": {\n        \"bare\": { \"modelID\": \"upstream/bare\" }\n      }\n    }\n  }\n}\n";
    let (_dir2, path2) = write_config("bare-v2.jsonc", v2);
    let before2 = read_document(&path2).expect("read v2");
    let prepared2 = prepare_changes(
        &path2,
        &before2.hash,
        &[edit_set(
            &["providers", "acme", "models", "bare", "limit", "output"],
            json!(8192),
        )],
    )
    .expect("creating limit.output on a V2 model without limit must be allowed");
    commit_changes(&prepared2).expect("commit v2 limit");
    let text2 = fs::read_to_string(&path2).expect("read v2 back");
    assert!(
        text2.contains("\"limit\": {"),
        "limit block created in V2: {text2}"
    );
    assert!(
        text2.contains("\"output\": 8192"),
        "value written in V2: {text2}"
    );
}

/// Removing a limit leaf that is absent is still an error: only `Set` creates.
#[test]
fn removing_an_absent_limit_leaf_is_still_rejected() {
    let source = b"{\n  \"provider\": {\n    \"acme\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"models\": {\n        \"partial\": { \"name\": \"Partial\", \"limit\": { \"context\": 1000 } }\n      }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("partial-limit.jsonc", source);
    let before = read_document(&path).expect("read");
    let err = prepare_changes(
        &path,
        &before.hash,
        &[edit_remove(&[
            "provider", "acme", "models", "partial", "limit", "output",
        ])],
    )
    .expect_err("removing an absent leaf must not be allowed");
    assert!(
        err.contains("does not exist"),
        "unexpected removal error: {err}"
    );
}

/// A `limit` block whose value is not an object must not be silently
/// overwritten by a `Set`.
///
/// Note what actually stops it. `prepare_changes` rejects the whole file at the
/// `unsafe_nesting` gate before per-edit validation runs, so the more specific
/// `The `limit` field must be an object.` branch in `validate_creatable_block`
/// is not what a user sees here -- and is unreachable from this entry point.
/// `provider_has_invalid_types` already treats a non-object `limit` as an
/// invalid type, which is what sets `unsafe_nesting`. This test pins the
/// refusal and the message that really reaches the user; do not read it as
/// coverage of the specific branch.
#[test]
fn a_malformed_limit_block_is_rejected_with_a_distinct_error() {
    let source = b"{\n  \"provider\": {\n    \"acme\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"models\": {\n        \"weird\": { \"name\": \"Weird\", \"limit\": 4096 }\n      }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("weird-limit.jsonc", source);
    let before = read_document(&path).expect("read");
    let err = prepare_changes(
        &path,
        &before.hash,
        &[edit_set(
            &["provider", "acme", "models", "weird", "limit", "context"],
            json!(2048),
        )],
    )
    .expect_err("a non-object limit block must not be overwritten implicitly");
    assert!(
        !err.contains("does not exist"),
        "an invalid shape must not be reported as a missing parent: {err}"
    );
    assert_eq!(
        err, "This file contains an unsafe mixture of V1 and V2 provider syntax and is read-only.",
        "the file-level gate is what fires; if this changes, the specific branch \
         becomes live and this test should be split in two"
    );
}

/// `capabilities.reasoning` must follow the same create-on-Set rule as `limit`,
/// so one dialog does not accept one field and refuse its neighbour.
#[test]
fn capabilities_reasoning_is_creatable_and_removal_stays_strict() {
    let source = b"{\n  \"providers\": {\n    \"acme\": {\n      \"package\": \"@opencode/ai/providers/openai-compatible\",\n      \"models\": {\n        \"bare\": { \"modelID\": \"upstream/bare\" }\n      }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("bare-capabilities.jsonc", source);
    let before = read_document(&path).expect("read");
    let prepared = prepare_changes(
        &path,
        &before.hash,
        &[edit_set(
            &[
                "providers",
                "acme",
                "models",
                "bare",
                "capabilities",
                "reasoning",
            ],
            json!({ "supported": true, "effort": ["high"] }),
        )],
    )
    .expect("creating capabilities.reasoning on a model without it must be allowed");
    commit_changes(&prepared).expect("commit capabilities");
    let text = fs::read_to_string(&path).expect("read back");
    assert!(
        text.contains("\"capabilities\": {"),
        "capabilities block created: {text}"
    );
    assert!(
        text.contains("\"supported\": true"),
        "reasoning written: {text}"
    );

    let after = read_document(&path).expect("read after");
    let err = prepare_changes(
        &path,
        &after.hash,
        &[edit_remove(&[
            "providers",
            "acme",
            "models",
            "bare",
            "capabilities",
            "reasoning",
        ])],
    )
    .expect("removing a present reasoning leaf is allowed");
    commit_changes(&err).expect("commit removal");
}

/// Adding a second limit leaf to a model that already has one must work too.
///
/// This is the same `validate_leaf_exists` call producing a *different*
/// message than the empty-model case: a user who already filled one limit sees
/// "The requested leaf field does not exist." instead of "The parent object
/// does not exist.". Pinning it separately stops a future refactor from
/// restoring the strict check on `Set` while the empty-model test stays green.
#[test]
fn adding_a_second_limit_leaf_keeps_the_existing_sibling() {
    let source = b"{\n  \"provider\": {\n    \"acme\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"models\": {\n        \"half\": { \"name\": \"Half\", \"limit\": { \"context\": 32000 } }\n      }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("half-limit.jsonc", source);
    let before = read_document(&path).expect("read");
    let prepared = prepare_changes(
        &path,
        &before.hash,
        &[edit_set(
            &["provider", "acme", "models", "half", "limit", "output"],
            json!(4096),
        )],
    )
    .expect("adding a second limit leaf must be allowed");
    commit_changes(&prepared).expect("commit second leaf");
    let text = fs::read_to_string(&path).expect("read back");
    assert!(
        text.contains("\"context\": 32000"),
        "existing sibling must survive: {text}"
    );
    assert!(
        text.contains("\"output\": 4096"),
        "new leaf written: {text}"
    );
}

/// Two limit leaves created in one batch, in either order, must both land.
#[test]
fn a_batch_can_create_two_limit_leaves_in_either_order() {
    for paths in [
        [
            ["provider", "acme", "models", "bare", "limit", "context"],
            ["provider", "acme", "models", "bare", "limit", "output"],
        ],
        [
            ["provider", "acme", "models", "bare", "limit", "output"],
            ["provider", "acme", "models", "bare", "limit", "context"],
        ],
    ] {
        let source = b"{\n  \"provider\": {\n    \"acme\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"models\": {\n        \"bare\": { \"name\": \"Bare\" }\n      }\n    }\n  }\n}\n";
        let (_dir, path) = write_config("batch-limit.jsonc", source);
        let before = read_document(&path).expect("read");
        // Pin each value to its leaf name, not to its position in the batch:
        // the point of the test is that order does not matter.
        let value_for = |leaf: &str| match leaf {
            "context" => json!(64000),
            _ => json!(2048),
        };
        let edits = vec![
            edit_set(&paths[0], value_for(paths[0][5])),
            edit_set(&paths[1], value_for(paths[1][5])),
        ];
        let prepared = prepare_changes(&path, &before.hash, &edits).expect("batch create limit");
        commit_changes(&prepared).expect("commit batch");
        let text = fs::read_to_string(&path).expect("read back");
        assert!(text.contains("\"context\": 64000"), "context in: {text}");
        assert!(text.contains("\"output\": 2048"), "output in: {text}");
    }
}

#[test]
fn model_and_provider_creation_are_scaffolded_safely() {
    let source = b"{\n  \"provider\": {\n    \"acme\": {\n      \"npm\": \"@ai-sdk/openai-compatible\"\n    }\n  }\n}\n";
    let (_dir, path) = write_config("opencode.jsonc", source);
    let before = read_document(&path).expect("read");

    let model = edit_set(
        &["provider", "acme", "models", "new-model"],
        json!({
            "name": "New Model",
            "id": "upstream-new",
            "limit": { "context": 100000, "output": 8000 }
        }),
    );
    let prepared = prepare_changes(&path, &before.hash, &[model]).expect("create model");
    let after = commit_changes(&prepared).expect("commit model");
    let text = fs::read_to_string(&path).expect("read");
    assert!(text.contains("\"models\": {"));
    assert!(text.contains("\"new-model\": {"));
    assert!(text.contains("\"context\": 100000,"));
    assert_eq!(after.providers[0].models.len(), 1);

    let provider = edit_set(
        &["provider", "second"],
        json!({
            "name": "Second",
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "https://second.test/v1" },
            "models": { "m1": { "name": "M1" } }
        }),
    );
    let prepared = prepare_changes(&path, &after.hash, &[provider]).expect("create provider");
    let final_doc = commit_changes(&prepared).expect("commit provider");
    let text = fs::read_to_string(&path).expect("read final");
    assert!(text.contains("\"second\": {"));
    assert!(text.contains("\"baseURL\": \"https://second.test/v1\""));
    assert_eq!(final_doc.providers.len(), 2);
}

#[test]
fn deletion_is_explicit_and_removes_whole_entry_safely() {
    let source = b"{\n  \"provider\": {\n    \"keep\": {\n      \"npm\": \"pkg\",\n    },\n    \"drop\": {\n      \"npm\": \"pkg\",\n      \"options\": { \"apiKey\": \"drop-secret\" },\n    },\n  },\n}\n";
    let (_dir, path) = write_config("opencode.jsonc", source);
    let before = read_document(&path).expect("read");
    let prepared = prepare_changes(&path, &before.hash, &[edit_remove(&["provider", "drop"])])
        .expect("prepare delete");
    assert!(prepared.preview.diff.contains("- remove provider.drop"));
    assert!(!prepared.preview.diff.contains("drop-secret"));
    assert!(prepared
        .preview
        .warnings
        .iter()
        .any(|w| w.contains("credential")));
    let after = commit_changes(&prepared).expect("commit delete");
    assert_eq!(after.providers.len(), 1);
    assert_eq!(after.providers[0].id, "keep");
    let text = fs::read_to_string(&path).expect("read");
    assert!(!text.contains("\"drop\""));
    assert!(!text.contains("drop-secret"));
    assert!(text.contains("\"keep\""));
    assert!(text.trim_end().ends_with('}'));
}

#[test]
fn base_url_fragments_and_url_query_secrets_never_reach_dto() {
    let source = b"{
  \"providers\": {
    \"fragment\": {
      \"package\": \"pkg\",
      \"settings\": { \"baseURL\": \"https://api.test/v1#token=FRAGMENT-SECRET\" }
    },
    \"key-query\": {
      \"package\": \"pkg\",
      \"settings\": { \"baseURL\": \"https://host.test/v1?key=PRIVATE-KEY\" }
    },
    \"sig-query\": {
      \"package\": \"pkg\",
      \"settings\": { \"baseURL\": \"https://host.test/v1?keep=1&sig=SIGNATURE-SECRET&signature=SIG2\" }
    },
    \"benign-query\": {
      \"package\": \"pkg\",
      \"settings\": { \"baseURL\": \"https://host.test/v1?region=eu&keyboard=us\" }
    },
    \"malformed\": {
      \"package\": \"pkg\",
      \"settings\": { \"baseURL\": \"https://user:pw@bad host/v1#x\" }
    }
  }
}
";
    let (_dir, path) = write_config("url-secrets.jsonc", source);
    let doc = read_document(&path).expect("read url secrets");

    let fragment = &doc.providers[0];
    assert_eq!(fragment.base_url.as_deref(), Some("https://api.test/v1"));
    let key_query = &doc.providers[1];
    assert_eq!(key_query.base_url.as_deref(), Some("https://host.test/v1"));
    let sig_query = &doc.providers[2];
    assert_eq!(
        sig_query.base_url.as_deref(),
        Some("https://host.test/v1?keep=1")
    );
    let benign = &doc.providers[3];
    assert_eq!(
        benign.base_url.as_deref(),
        Some("https://host.test/v1?region=eu&keyboard=us")
    );
    let malformed = &doc.providers[4];
    assert_eq!(malformed.base_url, None, "unparsable URL must be hidden");

    let serialized = serde_json::to_string(&doc).expect("serialize DTO");
    for marker in [
        "FRAGMENT-SECRET",
        "PRIVATE-KEY",
        "SIGNATURE-SECRET",
        "#token=",
        "?key=",
        "sig=",
        "bad host",
        "user:pw",
    ] {
        assert!(
            !serialized.contains(marker),
            "DTO leaked {marker:?}: {serialized}"
        );
    }

    let warnings = doc.warnings.join("\n");
    assert!(warnings.contains("base URL containing credentials"));
    assert!(warnings.contains("fragment"));

    // Unrelated edits must keep the original URL bytes, including the fragment.
    let before = read_document(&path).expect("re-read");
    let prepared = prepare_changes(
        &path,
        &before.hash,
        &[edit_set(
            &["providers", "benign-query", "name"],
            json!("Benign"),
        )],
    )
    .expect("prepare unrelated edit");
    commit_changes(&prepared).expect("commit unrelated edit");
    let text = fs::read_to_string(&path).expect("read after edit");
    assert!(text.contains("https://api.test/v1#token=FRAGMENT-SECRET"));
    assert!(text.contains("https://host.test/v1?key=PRIVATE-KEY"));
    assert!(text.contains("https://user:pw@bad host/v1#x"));
}

#[test]
fn existing_base_url_with_hidden_secret_cannot_be_rewritten_from_dto_value() {
    let source = b"{\n  \"providers\": {\n    \"fragment\": {\n      \"package\": \"pkg\",\n      \"settings\": { \"baseURL\": \"https://api.test/v1#token=FRAGMENT-SECRET\" }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("fragment-edit.jsonc", source);
    let doc = read_document(&path).expect("read");

    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["providers", "fragment", "settings", "baseURL"],
            json!("https://api.test/v1?key=NEW-SECRET"),
        )],
    )
    .expect_err("new secret query");
    assert!(err.contains("secret query parameters"), "{err}");

    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["providers", "fragment", "settings", "baseURL"],
            json!("https://api.test/v2#token=NEW-SECRET"),
        )],
    )
    .expect_err("new fragment");
    assert!(err.contains("fragment"), "{err}");

    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["providers", "fragment", "settings", "baseURL"],
            json!("https://api.test/v2?sig=SIG"),
        )],
    )
    .expect_err("new signature query");
    assert!(err.contains("secret query parameters"), "{err}");

    let prepared = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["providers", "fragment", "settings", "baseURL"],
            json!("https://api.test/v2"),
        )],
    )
    .expect("clean base url replacement");
    commit_changes(&prepared).expect("commit clean base url");
    let text = fs::read_to_string(&path).expect("read");
    assert!(!text.contains("FRAGMENT-SECRET"));
    assert!(text.contains("https://api.test/v2"));
}

#[test]
fn wrong_typed_limit_leaves_make_source_read_only() {
    let source = b"{\n  \"providers\": {\n    \"bad-limit\": {\n      \"package\": \"pkg\",\n      \"models\": {\n        \"m\": { \"modelID\": \"m\", \"limit\": { \"context\": \"32768\", \"output\": 4096 } }\n      }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("bad-limit.jsonc", source);
    let doc = read_document(&path).expect("read bad limit");
    assert!(!doc.writable, "wrong-typed limit must be read-only");
    assert_eq!(doc.providers[0].models[0].context, None);
    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(&["model"], json!("bad-limit/m"))],
    )
    .expect_err("bad limit edit");
    assert!(err.contains("unsafe"), "{err}");

    let negative = b"{\n  \"provider\": {\n    \"neg\": {\n      \"npm\": \"pkg\",\n      \"models\": {\n        \"m\": { \"limit\": { \"context\": -1 } }\n      }\n    }\n  }\n}\n";
    let (_dir2, path2) = write_config("neg-limit.jsonc", negative);
    let neg_doc = read_document(&path2).expect("read negative limit");
    assert!(!neg_doc.writable);
}

#[test]
fn malformed_v2_reasoning_makes_source_read_only() {
    let source = b"{\n  \"providers\": {\n    \"bad-reasoning\": {\n      \"package\": \"pkg\",\n      \"models\": {\n        \"m\": { \"modelID\": \"m\", \"capabilities\": { \"reasoning\": { \"supported\": true, \"effort\": \"high\" } } }\n      }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("bad-reasoning.jsonc", source);
    let doc = read_document(&path).expect("read bad reasoning");
    assert!(!doc.writable, "scalar effort must be read-only");
    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(&["model"], json!("bad-reasoning/m"))],
    )
    .expect_err("bad reasoning edit");
    assert!(err.contains("unsafe"), "{err}");

    // Unknown provider-level keys stay preserved and must not make the file
    // read-only or break edits.
    let future = b"{\n  \"providers\": {\n    \"future\": {\n      \"package\": \"pkg\",\n      \"someFutureField\": { \"nested\": [1, 2, 3] }\n    }\n  }\n}\n";
    let (_dir2, path2) = write_config("future.jsonc", future);
    let future_doc = read_document(&path2).expect("read future field");
    assert!(
        future_doc.writable,
        "unknown provider keys must be preserved"
    );
    let prepared = prepare_changes(
        &path2,
        &future_doc.hash,
        &[edit_set(&["providers", "future", "name"], json!("Future"))],
    )
    .expect("edit provider with unknown key");
    commit_changes(&prepared).expect("commit");
    let text = fs::read_to_string(&path2).expect("read");
    assert!(text.contains("\"someFutureField\": { \"nested\": [1, 2, 3] }"));
}

#[test]
fn mixed_delete_and_edit_cannot_silently_drop_unrelated_comments() {
    let source = b"{\n  \"provider\": {\n    \"acme\": {\n      \"npm\": \"pkg\",\n      \"models\": {\n        \"keep\": {\n          // model variant comment\n          \"variants\": { \"high\": {} }\n        }\n      }\n    },\n    \"drop\": {\n      // drop entry comment\n      \"npm\": \"pkg\",\n      \"options\": { \"apiKey\": \"drop-secret\" }\n    }\n  }\n}\n";
    let (_dir, path) = write_config("mixed-delete.jsonc", source);
    let before = read_document(&path).expect("read");

    let ok = prepare_changes(&path, &before.hash, &[edit_remove(&["provider", "drop"])])
        .expect("plain whole-entry delete");
    commit_changes(&ok).expect("commit plain delete");
    let text = fs::read_to_string(&path).expect("read after delete");
    assert!(text.contains("// model variant comment"));
    assert!(!text.contains("// drop entry comment"));
    assert!(!text.contains("drop-secret"));

    // Same batch: delete one entry and edit another. Comments inside the edited
    // model must survive, so the edit is allowed but comments must not vanish.
    let (_dir2, path2) = write_config("mixed-delete2.jsonc", source);
    let before2 = read_document(&path2).expect("read 2");
    let prepared = prepare_changes(
        &path2,
        &before2.hash,
        &[
            edit_remove(&["provider", "drop"]),
            edit_set(
                &["provider", "acme", "models", "keep", "variants"],
                json!({ "high": { "reasoningEffort": "high" } }),
            ),
        ],
    );
    match prepared {
        Ok(change) => {
            commit_changes(&change).expect("commit mixed");
            let text = fs::read_to_string(&path2).expect("read mixed");
            assert!(text.contains("// model variant comment"));
            assert!(!text.contains("drop-secret"));
        }
        Err(err) => {
            assert!(err.contains("comment"), "unexpected rejection: {err}");
            let unchanged = fs::read_to_string(&path2).expect("read unchanged");
            assert!(unchanged.contains("// model variant comment"));
            assert!(unchanged.contains("drop-secret"));
        }
    }
}

#[test]
fn symlink_destination_swap_between_prepare_and_commit_is_refused() {
    let _ = support();
    let dir = tempfile::tempdir().expect("tempdir");
    let real_target = dir.path().join("real-target.jsonc");
    let victim = dir.path().join("victim.jsonc");
    fs::write(&real_target, v2_fixture().as_bytes()).expect("write target");

    let path = dir.path().join("opencode.jsonc");
    #[cfg(unix)]
    let created = { std::os::unix::fs::symlink(&real_target, &path).is_ok() };
    #[cfg(windows)]
    let created = match std::os::windows::fs::symlink_file(&real_target, &path) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "skipping symlink swap test: symlink creation denied ({error}); enable Developer Mode or run as admin to cover this path"
            );
            false
        }
    };
    #[cfg(not(any(unix, windows)))]
    let created = false;

    if !created {
        return;
    }

    // A symlinked destination is read-only up front, so prepare must fail
    // closed rather than resolving through the link.
    let doc = read_document(&path).expect("read symlink doc");
    assert!(!doc.writable, "symlink destination must be read-only");
    assert!(doc
        .warnings
        .iter()
        .any(|warning| warning.contains("symlink")));
    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(&["model"], json!("acme/coder"))],
    )
    .expect_err("symlink prepare");
    assert!(
        err.contains("symlink") || err.contains("read-only"),
        "{err}"
    );

    // Swapping a regular file for a symlink after prepare must also be refused
    // at commit time, and the link target must be untouched.
    let regular = dir.path().join("regular.jsonc");
    fs::write(&regular, v2_fixture().as_bytes()).expect("write regular");
    let before = read_document(&regular).expect("read regular");
    let prepared = prepare_changes(
        &regular,
        &before.hash,
        &[edit_set(
            &["providers", "acme", "models", "coder", "name"],
            json!("Swapped"),
        )],
    )
    .expect("prepare regular");

    fs::write(&victim, "unchanged victim\r\n").expect("write victim");
    fs::remove_file(&regular).expect("remove regular");
    #[cfg(unix)]
    let swapped = std::os::unix::fs::symlink(&victim, &regular).is_ok();
    #[cfg(windows)]
    let swapped = std::os::windows::fs::symlink_file(&victim, &regular).is_ok();
    #[cfg(not(any(unix, windows)))]
    let swapped = false;

    if !swapped {
        eprintln!("skipping second phase: could not swap destination for a symlink");
        return;
    }

    let err = commit_changes(&prepared).expect_err("symlink commit");
    assert!(
        err.contains("symlink") || err.contains("read-only") || err.contains("changed"),
        "{err}"
    );
    let victim_bytes = fs::read_to_string(&victim).expect("read victim");
    assert_eq!(victim_bytes, "unchanged victim\r\n");
    assert!(
        fs::symlink_metadata(&regular)
            .expect("metadata")
            .file_type()
            .is_symlink(),
        "destination must still be the swapped symlink"
    );
}

#[test]
fn prepared_change_requires_exact_hash_shape_and_extension() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let doc = read_document(&path).expect("read");
    let err = prepare_changes(&path, "not-a-hash", &[edit_set(&["model"], json!("a/b"))])
        .expect_err("bad hash");
    assert!(err.contains("hash"));

    let no_edits = prepare_changes(&path, &doc.hash, &[]).expect_err("empty edits");
    assert!(no_edits.contains("No edits"));

    let (_dir2, path2) = write_config("config.txt", b"{}");
    let err = read_document(&path2).expect_err("extension");
    assert!(err.contains(".json"));
}

#[test]
fn read_only_file_is_not_editable() {
    let (_dir, path) = write_config("opencode.jsonc", b"{\n  \"providers\": {}\n}\n");
    let doc = read_document(&path).expect("read");
    let original_permissions = fs::metadata(&path).expect("metadata").permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).expect("set readonly");
    let doc_readonly = read_document(&path).expect("read readonly");
    assert!(!doc_readonly.writable);
    let err = prepare_changes(&path, &doc.hash, &[edit_set(&["model"], json!("a/b"))])
        .expect_err("readonly");
    assert!(err.contains("read-only"));
    if let Err(error) = fs::set_permissions(&path, original_permissions) {
        eprintln!("cleanup: could not clear read-only flag: {error}");
    }
}

#[test]
fn dto_shapes_use_camel_case_and_no_raw_config() {
    let (_dir, path) = write_config("opencode.jsonc", v2_fixture().as_bytes());
    let doc = read_document(&path).expect("read");
    let value = serde_json::to_value(&doc).expect("to value");
    let object = value.as_object().expect("object");
    for key in [
        "path",
        "hash",
        "dialect",
        "writable",
        "warnings",
        "providers",
        "defaultModel",
    ] {
        assert!(object.contains_key(key), "missing {key}");
    }
    let provider = object["providers"][0].as_object().unwrap();
    for key in [
        "id",
        "name",
        "dialect",
        "baseUrl",
        "credentialStatus",
        "models",
    ] {
        assert!(provider.contains_key(key), "missing {key}");
    }
    let model = provider["models"][0].as_object().unwrap();
    for key in [
        "id",
        "requestId",
        "name",
        "context",
        "input",
        "output",
        "reasoning",
        "variants",
    ] {
        assert!(model.contains_key(key), "missing {key}");
    }
    let serialized = value.to_string();
    assert!(!serialized.contains("v2-inline-secret"));
    assert!(!serialized.contains("\"apiKey\""));
}
