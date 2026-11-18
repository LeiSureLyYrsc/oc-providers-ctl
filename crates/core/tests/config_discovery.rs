use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use oc_providers_core::{discover_configs, prepare_changes, read_document, Dialect, Edit, EditOp};
use serde_json::json;
use tempfile::TempDir;

struct TestRoots {
    _dir: TempDir,
    global_file: PathBuf,
    managed_file: PathBuf,
}

fn roots() -> &'static TestRoots {
    static ROOTS: OnceLock<TestRoots> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let dir = tempfile::tempdir().expect("tempdir");
        let global_dir = dir.path().join("global").join("opencode");
        let managed_dir = dir.path().join("managed").join("opencode");
        let backup_dir = dir.path().join("backups");
        fs::create_dir_all(&global_dir).expect("global dir");
        fs::create_dir_all(&managed_dir).expect("managed dir");
        fs::create_dir_all(&backup_dir).expect("backup dir");

        let global_file = global_dir.join("opencode.jsonc");
        fs::write(
            &global_file,
            b"{\n  \"providers\": {\n    \"global-provider\": { \"package\": \"@global/pkg\" }\n  }\n}\n",
        )
        .expect("global config");

        let managed_file = managed_dir.join("opencode.json");
        fs::write(
            &managed_file,
            b"{\n  \"providers\": {\n    \"managed-provider\": { \"package\": \"@managed/pkg\" }\n  }\n}\n",
        )
        .expect("managed config");

        std::env::set_var("OC_PROVIDERS_CTL_CONFIG_DIR", &global_dir);
        std::env::set_var("OC_PROVIDERS_CTL_MANAGED_DIR", &managed_dir);
        std::env::set_var("OC_PROVIDERS_CTL_BACKUP_DIR", &backup_dir);

        TestRoots {
            _dir: dir,
            global_file,
            managed_file,
        }
    })
}

fn project_fixture() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("project");
    let base = dir.path().join("workspace").join("acme");
    let web = base.join("packages").join("web");
    fs::create_dir_all(base.join(".opencode")).expect("acme opencode dir");
    fs::create_dir_all(web.join(".opencode")).expect("web opencode dir");
    fs::create_dir_all(web.join("src")).expect("src");
    fs::write(
        base.join("opencode.json"),
        b"{\n  \"providers\": { \"acme-root\": { \"package\": \"@acme/root\" } }\n}\n",
    )
    .expect("acme direct");
    fs::write(
        web.join("opencode.jsonc"),
        b"{\n  // web direct\n  \"providers\": { \"acme-web\": { \"package\": \"@acme/web\" } }\n}\n",
    )
    .expect("web direct");
    fs::write(
        base.join(".opencode").join("opencode.jsonc"),
        b"{\n  \"providers\": { \"acme-opencode\": { \"package\": \"@acme/dot\" } }\n}\n",
    )
    .expect("acme dot");
    fs::write(
        web.join(".opencode").join("opencode.json"),
        b"{\n  \"providers\": { \"web-opencode\": { \"package\": \"@web/dot\" } }\n}\n",
    )
    .expect("web dot");
    (dir, web)
}

fn source_ids(sources: &[oc_providers_core::SourceDocument]) -> Vec<String> {
    sources
        .iter()
        .flat_map(|s| s.providers.iter().map(|p| p.id.clone()))
        .collect()
}

#[test]
fn discovers_global_project_and_managed_in_merge_order() {
    let roots = roots();
    let (_dir, web) = project_fixture();
    let snapshot = discover_configs(Some(&web));

    let ids = source_ids(&snapshot.sources);
    assert_eq!(
        ids,
        vec![
            "global-provider",
            "acme-root",
            "acme-web",
            "acme-opencode",
            "web-opencode",
            "managed-provider",
        ],
        "global -> project direct farthest..closest -> .opencode farthest..closest -> managed"
    );

    assert_eq!(
        snapshot.project_path.as_deref(),
        Some(web.to_string_lossy().as_ref())
    );
    assert!(snapshot.warnings.iter().any(|w| w.contains("not verified")));
    assert!(snapshot
        .warnings
        .iter()
        .any(|w| w.contains("V1") || w.contains("Legacy")));

    let global = snapshot
        .sources
        .iter()
        .find(|s| s.path.ends_with("opencode.jsonc") && s.providers[0].id == "global-provider")
        .expect("global source");
    assert!(global.writable);
    assert_eq!(global.path, roots.global_file.to_string_lossy());

    let managed = snapshot
        .sources
        .iter()
        .find(|s| s.providers[0].id == "managed-provider")
        .expect("managed source");
    assert!(!managed.writable);
    assert!(managed
        .warnings
        .iter()
        .any(|w| w.contains("machine-managed")));
    assert_eq!(managed.path, roots.managed_file.to_string_lossy());

    for source in snapshot
        .sources
        .iter()
        .filter(|s| !s.path.contains("managed"))
    {
        assert!(
            source.writable,
            "normal source should be writable: {}",
            source.path
        );
        assert_eq!(source.dialect, Dialect::V2);
    }
}

#[test]
fn managed_configuration_cannot_be_prepared_for_editing() {
    let roots = roots();
    let doc = read_document(&roots.managed_file).expect("read managed");
    assert!(!doc.writable);
    assert!(doc.warnings.iter().any(|w| w.contains("machine-managed")));
    let edit = Edit {
        op: EditOp::Set,
        path: vec!["model".to_string()],
        value: Some(json!("a/b")),
    };
    let err = prepare_changes(&roots.managed_file, &doc.hash, &[edit]).expect_err("managed edit");
    assert!(err.contains("managed") || err.contains("read-only"));
}

#[test]
fn discovery_redacts_credentials_and_never_returns_raw_config() {
    let _roots = roots();
    let dir = tempfile::tempdir().expect("project");
    let project = dir.path().join("secret-project");
    fs::create_dir_all(&project).expect("project dir");
    let path = project.join("opencode.jsonc");
    fs::write(
        &path,
        b"{\n  // comment with sk-project-secret\n  \"providers\": {\n    \"private\": {\n      \"package\": \"pkg\",\n      \"settings\": { \"baseURL\": \"https://user:pw@private.test/v1\", \"apiKey\": \"sk-project-secret\" },\n      \"models\": { \"m\": { \"modelID\": \"m\", \"headers\": { \"Authorization\": \"Bearer header-secret\" } } }\n    }\n  }\n}\n",
    )
    .expect("secret config");

    let snapshot = discover_configs(Some(&project));
    let serialized = serde_json::to_string(&snapshot).expect("snapshot json");
    assert!(!serialized.contains("sk-project-secret"));
    assert!(!serialized.contains("Bearer header-secret"));
    assert!(!serialized.contains("user:pw"));
    let source = snapshot
        .sources
        .iter()
        .find(|s| s.path == path.to_string_lossy())
        .expect("project source");
    assert_eq!(
        source.providers[0].base_url.as_deref(),
        Some("https://private.test/v1")
    );
}

#[test]
fn project_none_discovers_only_global_and_managed() {
    let _roots = roots();
    let snapshot = discover_configs(None);
    assert!(snapshot.project_path.is_none());
    let ids = source_ids(&snapshot.sources);
    assert_eq!(ids, vec!["global-provider", "managed-provider"]);
}

#[test]
fn missing_project_directory_is_reported_without_reading_anything_else() {
    let _roots = roots();
    let dir = tempfile::tempdir().expect("temp");
    let missing = dir.path().join("does-not-exist");
    let snapshot = discover_configs(Some(&missing));
    assert!(snapshot
        .warnings
        .iter()
        .any(|w| w.contains("not a directory")));
    assert!(snapshot.project_path.is_some());
    assert_eq!(
        source_ids(&snapshot.sources),
        vec!["global-provider", "managed-provider"]
    );
}

#[test]
fn v1_sources_are_flagged_as_legacy() {
    let _roots = roots();
    let dir = tempfile::tempdir().expect("project");
    let project = dir.path().join("legacy-project");
    fs::create_dir_all(&project).expect("project dir");
    fs::write(
        project.join("opencode.json"),
        b"{\n  \"provider\": { \"legacy\": { \"npm\": \"@ai-sdk/openai-compatible\" } }\n}\n",
    )
    .expect("legacy config");
    let snapshot = discover_configs(Some(&project));
    assert!(snapshot
        .warnings
        .iter()
        .any(|w| w.contains("Legacy V1 provider format detected")));
    let legacy = snapshot
        .sources
        .iter()
        .find(|s| s.providers.iter().any(|p| p.id == "legacy"))
        .expect("legacy source");
    assert_eq!(legacy.dialect, Dialect::V1);
    assert_eq!(legacy.providers[0].dialect, Dialect::V1);
}

#[test]
fn both_json_and_jsonc_are_discovered_without_duplicates() {
    let _roots = roots();
    let dir = tempfile::tempdir().expect("project");
    let project = dir.path().join("dual");
    fs::create_dir_all(&project).expect("project dir");
    fs::write(
        project.join("opencode.json"),
        b"{\n  \"providers\": { \"json-entry\": { \"package\": \"pkg-a\" } }\n}\n",
    )
    .expect("json");
    fs::write(
        project.join("opencode.jsonc"),
        b"{\n  \"providers\": { \"jsonc-entry\": { \"package\": \"pkg-b\" } }\n}\n",
    )
    .expect("jsonc");
    let snapshot = discover_configs(Some(&project));
    let ids = source_ids(&snapshot.sources);
    assert!(ids.contains(&"json-entry".to_string()));
    assert!(ids.contains(&"jsonc-entry".to_string()));
    let matching: Vec<_> = snapshot
        .sources
        .iter()
        .filter(|s| s.path.contains("dual"))
        .collect();
    assert_eq!(matching.len(), 2);
}
