//! Core library for the `oc-providers-ctl` desktop application.
//!
//! This crate owns the filesystem and network boundary. The desktop shell only
//! receives the serde DTOs declared here (and by the network modules) and never
//! raw configuration file contents or credential values.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod catalog;
pub mod config;
pub mod inventory;

pub use catalog::{CatalogResult, ModelCandidate, ModelCatalog};
pub use config::{
    commit_changes, discover_configs, prepare_changes, read_document, restore_last_backup,
    PreparedChange,
};
pub use inventory::{fetch_inventory, ProviderInventory};

/// Which OpenCode configuration dialect a source file or provider entry uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    V1,
    V2,
    Ambiguous,
    Mixed,
    Invalid,
}

/// How a provider obtains credentials, without exposing any credential value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialStatus {
    /// The provider points at an environment or file reference, e.g. `{env:NAME}`.
    Reference,
    /// A literal credential value is present in the configuration file.
    Inline,
    /// No credential field was recognized.
    None,
}

/// One discovered configuration source and its safe, redacted projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDocument {
    pub path: String,
    pub hash: String,
    pub dialect: Dialect,
    pub writable: bool,
    pub warnings: Vec<String>,
    pub providers: Vec<ProviderEntry>,
    pub default_model: Option<String>,
}

/// A provider entry. Credential values are deliberately absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderEntry {
    pub id: String,
    pub name: Option<String>,
    pub dialect: Dialect,
    pub base_url: Option<String>,
    pub credential_status: CredentialStatus,
    pub models: Vec<ModelEntry>,
}

/// Safe model metadata. Arbitrary nested values are redacted where they could
/// carry credentials or custom authorization headers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelEntry {
    pub id: String,
    pub request_id: Option<String>,
    pub name: Option<String>,
    pub context: Option<i64>,
    pub input: Option<i64>,
    pub output: Option<i64>,
    pub reasoning: Option<Value>,
    pub variants: Option<Value>,
}

/// A requested change to an existing provider/model/default-model path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub op: EditOp,
    pub path: Vec<String>,
    #[serde(default)]
    pub value: Option<Value>,
}

/// Edit operation kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditOp {
    Set,
    Remove,
}

/// A redacted preview of a batch edit targeting a single file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangePreview {
    pub preview_id: String,
    pub path: String,
    pub diff: String,
    pub warnings: Vec<String>,
    pub edit_count: usize,
}

/// A workspace scan result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub sources: Vec<SourceDocument>,
    pub warnings: Vec<String>,
    pub project_path: Option<String>,
}
