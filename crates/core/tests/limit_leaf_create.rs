//! Regression repro for: "adding limit.context to a model that has no `limit`
//! object fails with `The parent object does not exist.`"
//!
//! Originally written to confirm the defect against 8209fa4. Requires
//! `validate_creatable_block`, so it only builds on top of the fix.
//!
//! Design note kept from a mistake I made with these: the one thing a batch test
//! must never do is stop at "prepare succeeded and counted 2 edits". That version
//! of the batch case passed on a genuinely broken sibling test, because the values
//! were never committed and never read back. Every assertion below that could be
//! about a value commits and reads the file.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use oc_providers_core::{commit_changes, prepare_changes, read_document, Edit, EditOp};
use serde_json::json;
use tempfile::TempDir;

struct Support {
    _dir: TempDir,
    backup_dir: PathBuf,
}

fn support() -> &'static Support {
    static SUPPORT: OnceLock<Support> = OnceLock::new();
    SUPPORT.get_or_init(|| {
        let dir = tempfile::tempdir().expect("tempdir");
        let backup_dir = dir.path().join("backups");
        fs::create_dir_all(&backup_dir).expect("backup dir");
        std::env::set_var("OC_PROVIDERS_CTL_BACKUP_DIR", &backup_dir);
        Support {
            _dir: dir,
            backup_dir,
        }
    })
}

#[allow(dead_code)]
fn backup_dir() -> PathBuf {
    support().backup_dir.clone()
}

fn write_config(name: &str, bytes: &[u8]) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("config tempdir");
    let path = dir.path().join(name);
    fs::write(&path, bytes).expect("write fixture");
    (dir, path)
}

fn edit_set(path: &[&str], value: serde_json::Value) -> Edit {
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

/// V1 model that deliberately has NO `limit` object �?exactly the state the UI
/// leaves a freshly created model in.
fn v1_model_without_limit() -> &'static str {
    r#"{
  "provider": {
    "acme": {
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "bare": { "name": "Bare Model" }
      }
    }
  }
}
"#
}

fn v2_model_without_limit() -> &'static str {
    r#"{
  "providers": {
    "acme": {
      "package": "@opencode/ai/providers/openai-compatible",
      "models": {
        "bare": { "modelID": "upstream/bare" }
      }
    }
  }
}
"#
}

/// Apply the edits for real and return the on-disk document as JSON.
///
/// Assertions about *values* must go through here. `prepare_changes` only proves
/// the edit list is acceptable; it is not evidence about what gets written.
fn commit_and_reload(path: &std::path::Path, edits: &[Edit]) -> serde_json::Value {
    let doc = read_document(path).expect("read before commit");
    assert!(doc.writable, "fixture must be writable");
    let prepared = prepare_changes(path, &doc.hash, edits).expect("prepare must succeed");
    commit_changes(&prepared).expect("commit must succeed");
    let bytes = fs::read(path).expect("read back");
    serde_json::from_slice(&bytes).expect("committed file must still be valid JSON")
}

/// Read a value by path, for asserting what actually landed on disk.
fn at<'a>(root: &'a serde_json::Value, path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut cur = root;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

/// The reported defect. Must fail on HEAD with `The parent object does not
/// exist.`; must pass after the fix.
#[test]
fn v1_can_add_limit_leaf_to_model_without_limit_object() {
    let (_dir, path) = write_config("opencode.jsonc", v1_model_without_limit().as_bytes());
    let doc = read_document(&path).expect("read");
    assert!(doc.writable, "fixture must be writable");

    let prepared = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["provider", "acme", "models", "bare", "limit", "context"],
            json!(32000),
        )],
    );
    let prepared = prepared.expect("adding limit.context to a model without `limit` must succeed");
    assert!(prepared.preview.diff.contains("limit.context"));
}

#[test]
fn v2_can_add_limit_leaf_to_model_without_limit_object() {
    let (_dir, path) = write_config("opencode.jsonc", v2_model_without_limit().as_bytes());
    let doc = read_document(&path).expect("read");
    assert!(doc.writable, "fixture must be writable");

    prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["providers", "acme", "models", "bare", "limit", "context"],
            json!(64000),
        )],
    )
    .expect("V2 adding limit.context to a model without `limit` must succeed");
}

/// Removing a leaf from a missing parent must still be an error �?the fix must
/// not turn "does not exist" into a silent no-op.
#[test]
fn removing_limit_leaf_from_model_without_limit_still_fails() {
    let (_dir, path) = write_config("opencode.jsonc", v1_model_without_limit().as_bytes());
    let doc = read_document(&path).expect("read");

    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_remove(&[
            "provider", "acme", "models", "bare", "limit", "context",
        ])],
    )
    .expect_err("removing a leaf under a missing parent must fail");
    assert!(
        err.to_lowercase().contains("parent") || err.to_lowercase().contains("does not exist"),
        "unexpected error text: {err}"
    );
}

/// A `limit` block of the wrong type must be refused, and this pins **what the
/// user actually sees when it is** -- which is not the message the name of this
/// test used to promise.
///
/// Correction, credit to Forge for spotting the first half of it: the previous
/// version of this test returned early when the document came back unwritable,
/// so it asserted nothing at all. And that early return was not a corner case --
/// it is the only outcome. `provider_has_invalid_types` (config.rs:1085-1090)
/// treats a non-object `limit` as an invalid type, which sets `unsafe_nesting`,
/// which makes `is_writable` false, which makes `prepare_changes` bail at the
/// file-level gate (config.rs:243) before any per-edit validation runs.
///
/// The consequence is broader than this one field: the invalid-shape arm of
/// `validate_creatable_block` is unreachable from all four of its call sites
/// (limit, capabilities, options, settings), because every one of those fields
/// is in `provider_has_invalid_types`. So `The `limit` field must be an object.`
/// cannot currently reach a user, and docs must not describe it as reachable.
///
/// What a user does get is the V1/V2-mixture sentence, which is misleading for
/// this input: nothing is mixed. This test pins that reality rather than the
/// intended design, so that whichever of the two gets fixed, it fails loudly and
/// someone splits it into two cases.
#[test]
fn a_malformed_limit_block_makes_the_file_read_only_with_the_file_level_message() {
    let source = br#"{
  "provider": {
    "acme": {
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "bare": { "name": "Bare Model", "limit": "not-an-object" }
      }
    }
  }
}
"#;
    let (_dir, path) = write_config("opencode.jsonc", source);
    let doc = read_document(&path).expect("a wrong-typed limit still parses");

    // Asserted explicitly, not skipped. This is the behaviour that matters.
    assert!(
        !doc.writable,
        "a non-object `limit` must make the file read-only; if this ever becomes \
         writable, the specific shape message becomes reachable and this test \
         should be split into the read-only case and a message case"
    );

    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &["provider", "acme", "models", "bare", "limit", "context"],
            json!(1000),
        )],
    )
    .expect_err("an edit to a read-only file must be refused");

    // The real message, and the fact that it never claims a missing parent.
    assert!(
        !err.contains("does not exist"),
        "a wrong-typed parent must not be reported as a missing parent: {err}"
    );
    assert_eq!(
        err, "This file contains an unsafe mixture of V1 and V2 provider syntax and is read-only.",
        "this is the message users actually get for a non-object `limit`; it says \
         'unsafe mixture' for a single mistyped scalar, which is why the docs \
         cannot promise the 'must be an object' wording"
    );
}

/// Batch case: several limit leaves added to a model with no `limit` at all.
/// Validation sees the original AST for every edit, so this must not depend on
/// the order the edits happen to be listed in.
///
/// This commits and asserts each value **by leaf name**. An earlier version of
/// this test only asserted `prepare` succeeded with `edit_count == 2`, and it
/// therefore passed while a sibling test in the same PR had the values swapped:
/// nothing here ever looked at what was written. Pairing a value with a position
/// in the batch is precisely the bug that taught me to write it this way.
#[test]
fn batch_of_limit_leaves_creates_one_parent_object() {
    // (leaf, value) pairs, keyed by leaf name so iteration order cannot matter.
    let leaves: [(&str, serde_json::Value); 2] =
        [("context", json!(32000)), ("output", json!(4096))];

    for reverse in [false, true] {
        let (_dir, path) = write_config("opencode.jsonc", v1_model_without_limit().as_bytes());
        let mut edits: Vec<Edit> = leaves
            .iter()
            .map(|(leaf, value)| {
                edit_set(
                    &["provider", "acme", "models", "bare", "limit", *leaf],
                    value.clone(),
                )
            })
            .collect();
        if reverse {
            edits.reverse();
        }

        let written = commit_and_reload(&path, &edits);
        let limit = at(&written, &["provider", "acme", "models", "bare", "limit"])
            .unwrap_or_else(|| panic!("`limit` object was not created (reverse={reverse})"));

        // One parent object, and each value sits under the leaf it names.
        assert!(
            limit.is_object(),
            "`limit` must be a single object: {limit}"
        );
        for (leaf, value) in leaves.iter() {
            assert_eq!(
                limit.get(*leaf),
                Some(value),
                "leaf `{leaf}` carries the wrong value after a batch commit (reverse={reverse}): {limit}"
            );
        }
        assert_eq!(
            limit.as_object().map(|o| o.len()),
            Some(leaves.len()),
            "no extra keys may appear in the created `limit` object: {limit}"
        );
    }
}

/// Adding a second leaf to an existing `limit` object keeps the first one.
#[test]
fn adding_leaf_to_existing_limit_preserves_siblings() {
    let source = br#"{
  "provider": {
    "acme": {
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "bare": { "name": "Bare Model", "limit": { "context": 32000 } }
      }
    }
  }
}
"#;
    let (_dir, path) = write_config("opencode.jsonc", source);
    let written = commit_and_reload(
        &path,
        &[edit_set(
            &["provider", "acme", "models", "bare", "limit", "output"],
            json!(4096),
        )],
    );
    let limit = at(&written, &["provider", "acme", "models", "bare", "limit"])
        .expect("`limit` must still exist");
    assert_eq!(
        limit.get("context"),
        Some(&json!(32000)),
        "existing sibling was lost: {limit}"
    );
    assert_eq!(
        limit.get("output"),
        Some(&json!(4096)),
        "new leaf was not written: {limit}"
    );
}

/// Control: V2 `capabilities.reasoning` never had the existence check, so it
/// already accepted a create. Documents the asymmetry that made the bug feel
/// arbitrary to users.
#[test]
fn v2_capabilities_reasoning_create_already_worked() {
    let (_dir, path) = write_config("opencode.jsonc", v2_model_without_limit().as_bytes());
    let doc = read_document(&path).expect("read");
    let result = prepare_changes(
        &path,
        &doc.hash,
        &[edit_set(
            &[
                "providers",
                "acme",
                "models",
                "bare",
                "capabilities",
                "reasoning",
            ],
            json!({ "supported": true }),
        )],
    );
    assert!(
        result.is_ok(),
        "capabilities.reasoning create: {:?}",
        result.err()
    );
}

/// Removing `capabilities.reasoning` when `capabilities` is absent must fail
/// with a message that names the real problem, not a generic parent error.
#[test]
fn removing_capabilities_reasoning_without_parent_fails() {
    let (_dir, path) = write_config("opencode.jsonc", v2_model_without_limit().as_bytes());
    let doc = read_document(&path).expect("read");
    let err = prepare_changes(
        &path,
        &doc.hash,
        &[edit_remove(&[
            "providers",
            "acme",
            "models",
            "bare",
            "capabilities",
            "reasoning",
        ])],
    )
    .expect_err("removing a leaf under a missing parent must fail");
    assert!(!err.is_empty());
}
