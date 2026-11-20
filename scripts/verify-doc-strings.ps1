#!/usr/bin/env pwsh
# Verify that every verbatim error quoting in docs/ still exists in the Rust source.
#
# Rationale: docs/config-editing.md promises "提示原文取自 config.rs". That promise
# decays the moment someone rewords an error string. This script makes the decay a
# failing check instead of a quietly wrong document.
#
# SCOPE - what this check does and does not prove (read before trusting it):
#   PROVES:   each quoted sentence still exists somewhere in the Rust source.
#   DOES NOT: that the sentence appears under the condition the doc claims, or that
#             the advice next to it is right. A message can be raised from several
#             places; this script cannot tell which one a user hit. Treat a green run
#             as "no drift", never as "the guidance is correct".
#
#   A wording check passing is NOT a classification check passing. This has already
#   bitten us once: an index of error messages was built by extracting literals from
#   source -- every message "existed", so this style of check was green, yet the claim
#   "this error has three sources" was wrong, because what changed was HOW MANY places
#   raise it and under WHAT condition, not the wording. Source-derived inventories are
#   a snapshot of one commit and decay silently as code moves; regenerate them at each
#   version boundary instead of trusting a stored copy.
#
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-doc-strings.ps1
#
# Exit 0 = every quoted string found in source. Exit 1 = at least one is unverified
#          or the self-test failed.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$docsDir = Join-Path $repo 'docs'

$sourceFiles = @(
    'crates/core/src/config.rs',
    'crates/core/src/inventory.rs',
    'crates/core/src/catalog.rs',
    'src-tauri/src/commands.rs',
    'src-tauri/src/state.rs',
    'src-tauri/src/paths.rs'
) | ForEach-Object { Join-Path $repo $_ } | Where-Object { Test-Path $_ }

if (-not $sourceFiles) { Write-Error "No source files found under $repo"; exit 1 }

function Get-QuotedErrorLiterals {
    param($Docs)
    # Only error-MESSAGE-shaped literals are collected: a capitalised sentence ending
    # in a period. That deliberately excludes paths, env vars, identifiers and code
    # snippets, which other docs legitimately quote without being error strings.
    $pattern = '`([A-Z][^`]{12,200}\.)`'
    foreach ($doc in $Docs) {
        $text = [System.IO.File]::ReadAllText($doc.FullName, [System.Text.Encoding]::UTF8)
        foreach ($m in [regex]::Matches($text, $pattern)) {
            $literal = ($m.Groups[1].Value -replace '`', '').Trim()
            # An error message has whitespace; identifiers and paths do not.
            if ($literal -notmatch '\s') { continue }
            # Skip placeholders: the source has format!() templates, so {..} and <..>
            # never match verbatim. Those are checked by eye in the doc instead.
            if ($literal -match '<|\{|\}') { continue }
            [pscustomobject]@{ Doc = $doc.Name; Literal = $literal }
        }
    }
}

# --- Self-test -------------------------------------------------------------
# A check that can only ever pass is not a check. Sentinel's point: without a
# deliberate negative case, the next person sees a green run and never learns
# whether it could have gone red. So we prove the matcher rejects an absent string
# on every single run, using the same code path as the real check.
$sentinel = 'This sentence is deliberately absent from the source tree.'
if ([regex]::Escape($sentinel) -match [regex]::Escape('Actually this one is present.')) {
    Write-Output "SELF-TEST FAILED: matcher reported a hit for an absent literal."
    exit 1
}
$selfTestHit = (($sourceFiles | ForEach-Object { [System.IO.File]::ReadAllText($_, [System.Text.Encoding]::UTF8) }) -join "`n") -match [regex]::Escape($sentinel)
if ($selfTestHit) {
    Write-Output "SELF-TEST FAILED: the sentinel literal unexpectedly exists in source; pick a new one."
    exit 1
}
Write-Output "Self-test OK: an absent literal is correctly reported as absent."

# --- Real check ------------------------------------------------------------
$source = ($sourceFiles | ForEach-Object { [System.IO.File]::ReadAllText($_, [System.Text.Encoding]::UTF8) }) -join "`n"

$docs = Get-ChildItem $docsDir -Filter *.md -File
$literals = @(Get-QuotedErrorLiterals -Docs $docs)
$missing = @()

foreach ($item in $literals) {
    if ($source -notmatch [regex]::Escape($item.Literal)) {
        $missing += $item
    }
}

Write-Output "Checked $($literals.Count) quoted literals across $($docs.Count) doc file(s)."

if ($missing.Count -gt 0) {
    Write-Output ""
    Write-Output "UNVERIFIED - these are quoted in docs but absent from source:"
    $missing | ForEach-Object { Write-Output ("  [{0}] {1}" -f $_.Doc, $_.Literal) }
    Write-Output ""
    Write-Output "Either the doc quotes it inaccurately, or the source string changed and the doc must follow."
    exit 1
}

Write-Output "OK - every quoted literal exists verbatim in the Rust source."
Write-Output "Reminder: this proves no drift in wording only. It does NOT prove the surrounding advice,"
Write-Output "or which code path raises a message, or how many paths do. Those need spot-checking"
Write-Output "against the throw sites on the branch you are documenting."
exit 0
