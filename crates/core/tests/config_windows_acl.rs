//! Windows-only assertions that committed backups are created with a
//! restrictive, non-inherited DACL. Skipped with an explicit message when the
//! host cannot create a private backup directory.
#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use oc_providers_core::{commit_changes, prepare_changes, read_document, Edit, EditOp};
use serde_json::json;
use tempfile::TempDir;

struct Support {
    _dir: TempDir,
    backup_dir: PathBuf,
}

fn support() -> Option<&'static Support> {
    static SUPPORT: OnceLock<Option<Support>> = OnceLock::new();
    SUPPORT
        .get_or_init(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let backup_dir = dir.path().join("backups");
            fs::create_dir_all(&backup_dir).expect("backup dir");
            std::env::set_var("OC_PROVIDERS_CTL_BACKUP_DIR", &backup_dir);
            Some(Support {
                _dir: dir,
                backup_dir,
            })
        })
        .as_ref()
}

fn acl_of(path: &Path) -> Option<String> {
    let script = format!(
        "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath '{}'; \
         $a.Access | ForEach-Object {{ \"{{0}}|{{1}}|{{2}}|{{3}}\" -f $_.IdentityReference.Value, $_.AccessControlType, $_.FileSystemRights, $_.IsInherited }}; \
         \"AREACCESSRULESPROTECTED:\" + $a.AreAccessRulesProtected",
        path.display()
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn current_user_sid() -> Option<String> {
    let script = "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_string())
}

#[test]
fn committed_backup_gets_restrictive_non_inherited_acl() {
    let Some(support) = support() else {
        eprintln!("skipping: could not prepare private backup dir on this host");
        return;
    };
    let source = "{\n  \"providers\": {\n    \"acme\": { \"package\": \"pkg\" }\n  }\n}\n";
    let path = support._dir.path().join("opencode.jsonc");
    fs::write(&path, source).expect("write config");

    let before = read_document(&path).expect("read");
    let prepared = prepare_changes(
        &path,
        &before.hash,
        &[Edit {
            op: EditOp::Set,
            path: vec!["model".to_string()],
            value: Some(json!("acme/m")),
        }],
    )
    .expect("prepare");
    commit_changes(&prepared).expect("commit");

    let backup = fs::read_dir(&support.backup_dir)
        .expect("read backup dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|entry| entry.extension().is_some_and(|ext| ext == "bak"))
        .expect("backup file exists");

    let Some(sid) = current_user_sid() else {
        eprintln!("skipping: powershell could not resolve the current user SID");
        return;
    };

    let dir_acl = match acl_of(&support.backup_dir) {
        Some(acl) => acl,
        None => {
            eprintln!("skipping: powershell Get-Acl unavailable");
            return;
        }
    };
    assert!(
        dir_acl.contains("AREACCESSRULESPROTECTED:True"),
        "backup directory DACL must be protected (inheritance disabled): {dir_acl}"
    );

    let file_acl = acl_of(&backup).expect("backup acl");
    assert!(
        file_acl.contains("AREACCESSRULESPROTECTED:True"),
        "backup file DACL must be protected: {file_acl}"
    );
    // `OW` in the SDDL renders as the "OWNER RIGHTS" principal, not the literal
    // owner SID, which is why the owner is granted without being named.
    assert!(
        file_acl.contains("NT AUTHORITY\\SYSTEM"),
        "backup ACL must grant SYSTEM: {file_acl}"
    );
    assert!(
        file_acl.contains("OWNER RIGHTS") || file_acl.contains(sid.as_str()),
        "backup ACL must grant the current owner: {file_acl}"
    );
    for unexpected in ["Everyone", "BUILTIN\\Users", "Authenticated Users"] {
        assert!(
            !file_acl.contains(unexpected),
            "backup ACL must not grant {unexpected}: {file_acl}"
        );
    }

    // The original config bytes are still recoverable from the backup.
    let backup_bytes = fs::read(&backup).expect("read backup");
    assert_eq!(backup_bytes, source.as_bytes());
}
