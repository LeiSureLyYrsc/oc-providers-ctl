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


# One comparison, used by both the self-test and the real check, so a green self-test
# proves something about the check that actually runs.
#
# Case-sensitive on purpose: `-match`/`-notmatch` are case-INSENSITIVE by default in
# PowerShell, so "the LIMIT field must be an object." used to pass against a source
# string that says "The limit field must be an object.". A wording check that ignores
# case is not checking the wording.
#
# SCOPE of this comparison: it answers "does this text appear anywhere in the source",
# not "is this text an entire Rust string literal". A doc fragment with a trailing period
# removed would still match its parent sentence. Making it exact would mean parsing Rust
# string literals (format!, escapes, multi-line concatenation) -- a different job. The
# README states this limit rather than implying the checker is exact.
function Test-LiteralPresent {
    param([string]$Source, [string]$Literal)
    return $Source.IndexOf($Literal, [System.StringComparison]::Ordinal) -ge 0
}
$script:SkippedLiterals = New-Object System.Collections.ArrayList
function Get-QuotedErrorLiterals {
    param($Docs)
    # Only error-MESSAGE-shaped literals are collected: a capitalised sentence ending
    # in a period. That deliberately excludes paths, env vars, identifiers and code
    # snippets, which other docs legitimately quote without being error strings.
    #
    # The body class used to be `[^`]`, which forbade a backtick INSIDE the literal.
    # That silently excluded every error message that quotes a field name in backticks
    # (for example the "field must be an object" pair). They were not reported as
    # skipped either: they never reached the collector at all, so the run still read
    # as full coverage. `.{12,200}?` (lazy) admits them.
    #
    # Two guards keep the widened class from matching prose that merely spans a pair
    # of backticks:
    #   - no newline  : a literal lives on one line; without this, lazy matching
    #                   bridges two unrelated sentences across a line break.
    #   - no CJK      : the surrounding documentation is Chinese, the Rust error
    #                   strings are not, so a CJK character inside the span means we
    #                   caught prose rather than a message. `|` is excluded for the
    #                   same reason: it is table syntax, not message text.
    $pattern = '`([A-Z][^\r\n|\u4e00-\u9fff\u3000-\u303f]{12,200}?\.)`'
    foreach ($doc in $Docs) {
        $text = [System.IO.File]::ReadAllText($doc.FullName, [System.Text.Encoding]::UTF8)
        foreach ($m in [regex]::Matches($text, $pattern)) {
            # Group 1 already excludes the surrounding backticks.
            # A message that quotes a field name, like "A `remove` edit ...", keeps
            # its INNER backticks: stripping them made the comparison impossible.
            # Markdown escaping: such a literal is written as \` in the doc so the
            # code span renders, while the source has a bare backtick. Undo the
            # escape before comparing; an already-bare backtick is left alone.
            $literal = ($m.Groups[1].Value -replace '\\`', '`').Trim()
            # An error message has whitespace; identifiers and paths do not.
            if ($literal -notmatch '\s') { continue }
            # Skip placeholders: the source has format!() templates, so {..} and <..>
            # never match verbatim. Those are checked by eye in the doc instead.
            if ($literal -match '<|\{|\}') { [void]$script:SkippedLiterals.Add($literal); continue }
            [pscustomobject]@{ Doc = $doc.Name; Literal = $literal }
        }
    }
}

# --- Self-test -------------------------------------------------------------
# A check that can only ever pass is not a check. Sentinel's point: without a
# deliberate negative case, the next person sees a green run and never learns
# whether it could have gone red. So we prove the matcher rejects an absent string
# on every single run, using the same function as the real check.
$selfTestSource = ($sourceFiles | ForEach-Object { [System.IO.File]::ReadAllText($_, [System.Text.Encoding]::UTF8) }) -join "`n"

$sentinel = 'This sentence is deliberately absent from the source tree.'
if (Test-LiteralPresent -Source $selfTestSource -Literal $sentinel) {
    Write-Output "SELF-TEST FAILED: the sentinel literal unexpectedly exists in source; pick a new one."
    exit 1
}
Write-Output "Self-test OK: an absent literal is correctly reported as absent."

# Second, independent negative case: the matcher must be case-SENSITIVE.
# Without this, the case-insensitivity bug fixed above could silently return.
# It uses a real sentence from the docs in a different case, so if a future
# change ever made the comparison case-insensitive again, this goes red.
$caseSource = 'Write-Output "The limit field must be an object."'
$caseVariant = 'THE LIMIT FIELD MUST BE AN OBJECT.'
if (Test-LiteralPresent -Source $caseSource -Literal $caseVariant) {
    Write-Output "SELF-TEST FAILED: matcher accepted a case-only variant; it must compare case-sensitively."
    exit 1
}
if (-not (Test-LiteralPresent -Source $caseSource -Literal 'The limit field must be an object.')) {
    Write-Output "SELF-TEST FAILED: matcher rejected the exact literal; it must find identical text."
    exit 1
}
Write-Output "Self-test OK: matching is case-sensitive and still finds exact text."

# --- Real check ------------------------------------------------------------
$source = ($sourceFiles | ForEach-Object { [System.IO.File]::ReadAllText($_, [System.Text.Encoding]::UTF8) }) -join "`n"

$docs = Get-ChildItem $docsDir -Filter *.md -File
$literals = @(Get-QuotedErrorLiterals -Docs $docs)
$missing = @()

foreach ($item in $literals) {
    if (-not (Test-LiteralPresent -Source $source -Literal $item.Literal)) {
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

Write-Output "OK - every checked literal exists verbatim in the Rust source."

# Literals containing placeholders ({id}, {status}, ...) are skipped on purpose: the source has
# format!() templates and the doc writes the readable form with braces, so the two can never be
# equal. They are NOT covered by this script. Say so out loud: a green run must not imply full
# coverage, because the skipped ones are exactly where a rewritten message goes unnoticed.
$skipped = @($script:SkippedLiterals)
if ($skipped.Count -gt 0) {
    Write-Output ""
    Write-Output "NOT CHECKED - $($skipped.Count) literal(s) contain placeholders and were skipped;"
    Write-Output "these are verified by eye only, not by this script:"
    $skipped | Sort-Object -Unique | ForEach-Object { Write-Output ("  " + $_) }
}
Write-Output "Reminder: this proves no drift in wording only. It does NOT prove the surrounding advice,"
Write-Output "or which code path raises a message, or how many paths do. Those need spot-checking"
Write-Output "against the throw sites on the branch you are documenting."
exit 0
