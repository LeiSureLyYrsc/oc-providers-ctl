#!/usr/bin/env pwsh
# Verify that each eligible error excerpt in docs/ still appears in the Rust source.
#
# Rationale: docs/config-editing.md promises "提示原文取自 config.rs". That promise
# decays the moment someone rewords an error string. This script makes the decay a
# failing check instead of a quietly wrong document.
#
# SCOPE - what this check does and does not prove (read before trusting it):
#   PROVES:   each checked excerpt still appears somewhere in the Rust source.
#   DOES NOT: that the sentence appears under the condition the doc claims, or that
#             the advice next to it is right. A message can be raised from several
#             places; this script cannot tell which one a user hit. Treat a green run
#             as "no drift", never as "the guidance is correct".
#   DOES NOT: prove the source stopped there. A message that gains another sentence
#             inside the same literal is not caught: the doc's excerpt is still a
#             prefix of a real message, which is what legitimately quoting a first
#             sentence looks like. Those two are the same shape, and this check cannot
#             separate them.
#   DOES NOT: prove a required excerpt's fixed id is bound to the right sentence.
#             Swapping two markers passes -- both sentences are real source strings.
#   DOES NOT: apply the message-boundary rule to excerpts without a placeholder. Those
#             are compared as verbatim substrings, so text added before or after them in
#             the source goes unnoticed. Only placeholder-bearing excerpts get the
#             boundary test, because a placeholder is what made their spelling ambiguous.
#             State it here because a protection that covers only some excerpts, with
#             no stated range, reads as covering all of them.
#   DOES NOT: follow `concat!`. It requires the quoted sentence to exist as a complete
#             quoted literal. Prefix spliced in as its own literal (`concat!("Note: ",
#             "Provider...")`) passes while the final message differs; the same prefix
#             written inside that one literal fails.
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
# Exit 0 = every checked excerpt found in source. Exit 1 = at least one is unverified
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
function Get-RequiredErrorLiterals {
    param([string]$DocName, [string]$Text, [string[]]$Ids)

    foreach ($id in $Ids) {
        $markerPattern = '<!--[ \t]*verify:' + [regex]::Escape($id) + '[ \t]*-->'
        $markers = [regex]::Matches($Text, $markerPattern)
        if ($markers.Count -eq 0) { throw "MISSING MARKER in ${DocName}: $id" }
        if ($markers.Count -gt 1) { throw "DUPLICATE MARKER in ${DocName}: $id" }

        $markerIndex = $markers[0].Index
        $lineStart = $Text.LastIndexOf("`n", $markerIndex) + 1
        $lineEnd = $Text.IndexOf("`n", $markerIndex)
        if ($lineEnd -lt 0) { $lineEnd = $Text.Length }
        $row = $Text.Substring($lineStart, $lineEnd - $lineStart).Trim()
        if (-not ($row.StartsWith('|') -and $row.EndsWith('|'))) {
            throw "INVALID MARKER in ${DocName}: $id must be in a table row."
        }

        # The marked cell must contain one code span immediately followed by its marker.
        $cells = $row -split '(?<!\\)\|'
        $markedCell = $cells | Where-Object { $_ -cmatch $markerPattern }
        $cellPattern = '^[ \t]*(?<fence>`+)(?<literal>[^`]+)\k<fence>[ \t]*' + $markerPattern + '[ \t]*$'
        $match = [regex]::Match([string]$markedCell, $cellPattern)
        if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups['literal'].Value)) {
            throw "INVALID MARKER in ${DocName}: $id must follow a single code span in the same cell."
        }

        [pscustomobject]@{ Doc = $DocName; Literal = $match.Groups['literal'].Value.Trim(); Id = $id }
    }
}

# --- Placeholder normalisation ----------------------------------------------
# A doc excerpt may write a Rust placeholder differently from the source, and it may
# be RIGHT to do so: the source spells it `{}` or `{provider_label}` while the doc
# writes `{id}`, because a reader needs a name, not the format argument's variable.
# Comparing such an excerpt verbatim reports drift that is not there.
#
# So both sides are normalised before comparing: `{name}`, `{}` and `<name>` all
# collapse to one sentinel. Any placeholder matches any other placeholder.
#
# WHAT THIS GIVES UP, stated plainly so nobody mistakes it for exactness: after
# normalisation the script can no longer prove the doc's placeholder NAME matches
# the source's. It proves the surrounding words match, in order, with the same
# NUMBER of placeholders. A doc that renamed `{status}` to `{code}` still passes.
# That is the intended trade: the words are the text a user sees, and the argument
# variable is not. The four required excerpts are exempt (see below) precisely
# because they are worth pinning exactly.
#
# Two things are deliberately NOT placeholders:
#   - `{}` inside a backtick-quoted field name ("The configuration field `{}` must
#     be {expected}.") is a doc-side stand-in for a field name, and it normalises
#     like any other placeholder; the source's own escape of it is what the
#     sentinel covers.
#   - a trailing ` ...` is an ABBREVIATION MARK, not a placeholder: the doc is
#     quoting the START of a sentence and saying "it goes on". Normalising it away
#     would silently accept any ending. Such excerpts are refused as unverifiable
#     instead of being checked, because the words after the mark were never written
#     down. See Get-QuotedErrorLiterals.
$script:PlaceholderSentinel = [string][char]0x01
function ConvertTo-NormalisedText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $s = [regex]::Replace($Text, '\{[A-Za-z_][A-Za-z0-9_]*\}', $script:PlaceholderSentinel)
    $s = [regex]::Replace($s, '\{\}', $script:PlaceholderSentinel)
    $s = [regex]::Replace($s, '<[A-Za-z_][A-Za-z0-9_]*>', $script:PlaceholderSentinel)
    return $s
}

# Does `$Needle` start a real message in the (already normalised) source, without being
# the whole message? "Starts" = sits right after a `"` or a newline.
#
# Called ONLY for excerpts that do not end with a period. For those, a SPACE after the
# match means the source sentence keeps going -- that is what a truncated excerpt looks
# like (`...so its` + ` model-list protocol...`). The space must therefore count as
# "continues" here. It is the opposite of the rule in Test-LiteralPresentNormalised,
# where a trailing space is what makes a legitimate first-sentence quote valid, and the
# two rules differ because the excerpt's own last character differs.
#
# A path or a character class will not satisfy this: it does not sit at the start of a
# message at all.
function Test-LiteralStartsMessage {
    param([string]$Source, [string]$Needle)
    $at = 0
    while (($at = $Source.IndexOf($Needle, $at, [System.StringComparison]::Ordinal)) -ge 0) {
        $before = if ($at -eq 0) { '' } else { $Source.Substring($at - 1, 1) }
        $endAt = $at + $Needle.Length
        $after = if ($endAt -ge $Source.Length) { '' } else { $Source.Substring($endAt, 1) }
        $starts = ($before -eq '"')
        $continues = ($after -ne '"') -and ($after -ne '')
        if ($starts -and $continues) { return $true }
        $at++
    }
    return $false
}

# Normalised comparison with MESSAGE BOUNDARIES.
#
# A bare substring test is too weak once normalisation is in place. Three shapes pass
# a substring test that should not:
#
#   1. source says `Lookup failed: Provider '{id}' was not found...` -- the doc excerpt
#      is in there, but it is not a message on its own; the user also sees the prefix.
#   2. source says `...configuration file..extra` -- the doc's trailing period matched
#      the first of two periods.
#   3. the doc excerpt is missing its final period, or stops mid-sentence at `so its`
#      -- a substring that ends early is always present in its own continuation.
#
# So a hit only counts when the excerpt STARTS a message and ENDS one. What counts:
#   start: immediately after `\"` (the opening quote of the Rust literal). NOT after a
#          bare newline: a literal that begins with `Lookup failed:` and then breaks the
#          line would otherwise let the original sentence on the next line count as a
#          message start, hiding the prefix.
#   end:   a `\"`, a SPACE, or end of source. NOT a bare newline, for the same reason in
#          reverse: the message continues on that next line.
#
# The space is load-bearing and is why this is not simply "quoted on both sides".
# Several messages here open with one sentence and then continue -- "...protocol is
# unknown. Add an official OpenAI or Anthropic `package`/`npm` setting...". A doc may
# rightly quote only the first sentence, which ends at a period followed by a space.
# Requiring the quote would reject those and force docs to carry advice they don't
# need. Normalisation has already collapsed placeholders, so `"` here is the source's
# own quote character, not a backtick.
function Test-LiteralPresentNormalised {
    param([string]$Source, [string]$Literal)
    $needle = ConvertTo-NormalisedText -Text $Literal
    $hay = ConvertTo-NormalisedText -Text $Source
    $at = 0
    while (($at = $hay.IndexOf($needle, $at, [System.StringComparison]::Ordinal)) -ge 0) {
        $before = if ($at -eq 0) { '' } else { $hay.Substring($at - 1, 1) }
        $endAt = $at + $needle.Length
        $after = if ($endAt -ge $hay.Length) { '' } else { $hay.Substring($endAt, 1) }
        $startsMessage = ($before -eq '"')
        $endsMessage = ($after -eq '"') -or ($after -eq '') -or ($after -eq ' ')
        if ($startsMessage -and $endsMessage) { return $true }
        $at++
    }
    return $false
}

# A doc excerpt that is a truncated or de-punctuated ERROR MESSAGE must fail, not vanish.
# The collector above requires a trailing period, so without this the three ways to
# wreck an excerpt -- delete its period, cut it mid-sentence, or paste it behind another
# message -- all end with "never collected, therefore never checked, therefore green".
#
# The hard part is telling a BROKEN MESSAGE from a legitimate non-message quote: docs
# also quote paths, field names and code snippets inline, and those must not be dragged
# in. A shape test cannot do it (`A-Z a-z 0-9 _ - / : @` looks like nothing and IS
# legitimate). So the test is a fact about the SOURCE, not about the quote:
#
#   an excerpt without a trailing period fails only when it matches the BEGINNING of a
#   real source message and is not the whole of it.
#
# That is precise in both directions. A truncated message or a de-punctuated one does
# start a real message. A path or a character class does not, so it is left alone
# instead of being forced into an error-message check it never belonged to.
function Get-SuspiciousErrorFragments {
    param($Docs, [string]$NormSource)
    # Fence width matched, as above, so a single-backtick span cannot close on an inner one.
    $pattern = '(?<fence>`+)(?<lit>[A-Z][^\r\n|\u4e00-\u9fff\u3000-\u303f]{12,200}?)\k<fence>'
    foreach ($doc in $Docs) {
        $text = [System.IO.File]::ReadAllText($doc.FullName, [System.Text.Encoding]::UTF8)
        foreach ($m in [regex]::Matches($text, $pattern)) {
            $fragment = $m.Groups['lit'].Value.Trim()
            if ($fragment -notmatch '\s') { continue }
            if ($fragment.EndsWith('.')) { continue }
            if ($fragment -match '\s\.\.\.$') { continue }
            $needle = ConvertTo-NormalisedText -Text $fragment
            if (Test-LiteralStartsMessage -Source $NormSource -Needle $needle) {
                $lineNo = ($text.Substring(0, $m.Index) -split "`n").Count
                [pscustomobject]@{ Doc = $doc.Name; Literal = $fragment; Line = $lineNo }
            }
        }
    }
}

$script:SkippedLiterals = New-Object System.Collections.ArrayList
function Get-QuotedErrorLiterals {
    param($Docs, $RequiredLiterals)
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
    # The two exclusions above are chosen for the CURRENT corpus: no Rust error string
    # contains `|` or CJK today (checked across every capitalised, period-terminated
    # literal in the five source files). They exist only to stop lazy matching from
    # bridging prose. **If someone adds a message containing `|` or Chinese text, it
    # becomes INVISIBLE again -- the same silent failure as the nested-backtick bug.**
    # Re-check this class when the docs gain a message of that shape.
    # The fence must be WIDTH-MATCHED: an opener and its closer have the same number
    # of backticks. A message that quotes a field name needs a double-backtick span;
    # written with single backticks it would otherwise close on the INNER one.
    #
    # The trailing period is required HERE because it is what separates an error message
    # from the paths, field names and code snippets docs also quote inline. Dropping it
    # used to be a silent escape: delete the period and the span stops matching, so the
    # excerpt is never collected and the run stays green. Get-QuotedErrorLiterals still
    # looks for those separately (see below) and fails when one is a truncated message.
    $pattern = '(?<fence>`+)(?<lit>[A-Z][^\r\n|\u4e00-\u9fff\u3000-\u303f]{12,200}?\.)\k<fence>'
    foreach ($doc in $Docs) {
        $text = [System.IO.File]::ReadAllText($doc.FullName, [System.Text.Encoding]::UTF8)
        $requiredInDoc = @($RequiredLiterals | Where-Object Doc -CEQ $doc.Name | ForEach-Object Literal)
        foreach ($m in [regex]::Matches($text, $pattern)) {
            # 1-based line number of the excerpt, for the failure report: a message
            # that names the file and line can be acted on, one that only quotes the
            # text leaves the reader searching.
            $lineNo = ($text.Substring(0, $m.Index) -split "`n").Count
            # The fence group replaces group 1 now that the pattern is fence-aware.
            # A message that quotes a field name, like "A `remove` edit ...", keeps
            # its inner backticks. In Markdown, wrap it in a double-backtick span.
            $literal = $m.Groups['lit'].Value.Trim()
            # An error message has whitespace; identifiers and paths do not.
            if ($literal -notmatch '\s') { continue }
            if ($requiredInDoc -ccontains $literal) { continue }
            # A trailing " ..." means the doc quoted only the beginning of a
            # sentence. There is nothing after the mark to compare, so this cannot
            # be verified -- but it IS still an excerpt someone must check by eye.
            # Keep reporting it as unchecked rather than silently normalising the
            # mark away and accepting whatever ending the source happens to have.
            if ($literal -match '\s\.\.\.$') {
                [void]$script:SkippedLiterals.Add([pscustomobject]@{ Literal = $literal; Doc = $doc.Name; Line = $lineNo })
                continue
            }
            [pscustomobject]@{ Doc = $doc.Name; Literal = $literal; Line = $lineNo }
        }
    }
}

# --- Self-test -------------------------------------------------------------
# A check that can only ever pass is not a check. Sentinel's point: without a
# deliberate negative case, the next person sees a green run and never learns
# whether it could have gone red. So we prove the matcher rejects an absent string
# on every single run, using the same function as the real check.
#
# Every self-test case below runs against its OWN fixture, so nothing here depends
# on statement order: this block can be moved anywhere without going vacuous. The
# real source is read on the line after it, used only by the actual check.


# (a) an absent literal must be reported absent
$absentFixture = 'Write-Output "Some other sentence entirely."'
$sentinel = 'This sentence is deliberately absent from the source tree.'
if (Test-LiteralPresent -Source $absentFixture -Literal $sentinel) {
    Write-Output "SELF-TEST FAILED: matcher reported a hit for an absent literal."
    exit 1
}
Write-Output "Self-test OK: an absent literal is correctly reported as absent."

# (b) the matcher must be case-SENSITIVE. Without this the case-insensitivity bug
# could silently return.
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

# (c) normalisation must match a doc placeholder against a differently-named source
# placeholder, and must still REJECT a real word change. The second half matters more
# than the first: normalisation that accepts anything is worse than no normalisation,
# because it removes the check while still reporting green.
$normSource = 'Write-Output "Provider ''{provider_label}'' was not found in this configuration file."'
if (-not (Test-LiteralPresentNormalised -Source $normSource -Literal "Provider '{id}' was not found in this configuration file.")) {
    Write-Output "SELF-TEST FAILED: normalisation failed to match two differently-named placeholders."
    exit 1
}
if (-not (Test-LiteralPresentNormalised -Source 'Write-Output "Ignored {} provider entries."' -Literal 'Ignored {n} provider entries.')) {
    Write-Output "SELF-TEST FAILED: normalisation failed to match a doc name against a bare `{}`."
    exit 1
}
if (Test-LiteralPresentNormalised -Source $normSource -Literal "Provider '{id}' was not found in this file.") {
    Write-Output "SELF-TEST FAILED: normalisation accepted a changed word; it must only forgive placeholders."
    exit 1
}
if (Test-LiteralPresentNormalised -Source 'Write-Output "Ignored {} provider entries."' -Literal 'Ignored {n} entries.') {
    Write-Output "SELF-TEST FAILED: normalisation accepted a dropped word."
    exit 1
}
# A doc that renames a placeholder must NOT be caught: this is the cost we accepted,
# asserted here so it is a documented property rather than a surprise later.
if (-not (Test-LiteralPresentNormalised -Source $normSource -Literal "Provider '{anything}' was not found in this configuration file.")) {
    Write-Output "SELF-TEST FAILED: normalisation should treat all placeholders as equal."
    exit 1
}
Write-Output "Self-test OK: normalisation matches placeholders and still rejects changed words."

# --- Real check ------------------------------------------------------------
$source = ($sourceFiles | ForEach-Object { [System.IO.File]::ReadAllText($_, [System.Text.Encoding]::UTF8) }) -join "`n"
$docs = Get-ChildItem $docsDir -Filter *.md -File
$requiredDoc = 'config-editing.md'
# Keep the required IDs independent of the document so deletion fails the check.
$requiredIds = @(
    'label-empty-or-too-long',
    'label-control-chars',
    'label-reserved-char',
    'max-models-truncated'
)
$requiredText = [System.IO.File]::ReadAllText((Join-Path $docsDir $requiredDoc), [System.Text.Encoding]::UTF8)
$requiredLiterals = @(Get-RequiredErrorLiterals -DocName $requiredDoc -Text $requiredText -Ids $requiredIds)

# The four required excerpts are pinned exactly and must NOT be swept into the
# normalised set. If they were, one failure would turn two checks red and nobody
# could tell which mechanism broke. Make the count an assertion rather than a
# comment: adding a fifth required excerpt, or losing a marker, must fail here
# instead of quietly changing which path checks it.
if ($requiredLiterals.Count -ne $requiredIds.Count) {
    Write-Output "SELF-TEST FAILED: expected $($requiredIds.Count) required excerpts, got $($requiredLiterals.Count)."
    exit 1
}
$literals = $requiredLiterals + @(Get-QuotedErrorLiterals -Docs $docs -RequiredLiterals $requiredLiterals)
$missing = @()

# Excerpts that look like a damaged message: no trailing period, and they start a real
# source message without being the whole of it. Reported as failures alongside the
# ordinary misses, because "the check silently stopped seeing this" is the failure mode
# they were created by.
$normSource = ConvertTo-NormalisedText -Text $source
$suspicious = @(Get-SuspiciousErrorFragments -Docs $docs -NormSource $normSource)

foreach ($item in $literals) {
    # The required excerpts are complete Rust string literals, pinned verbatim.
    if ($item.Id) {
        if (-not (Test-LiteralPresent -Source $source -Literal ('"' + $item.Literal + '"'))) { $missing += $item }
        continue
    }
    # Only excerpts that actually carry a placeholder go through the boundary test.
    # An excerpt with none is compared as a plain substring, exactly as before.
    #
    # Why they differ: a placeholder is what makes the doc's spelling ambiguous, so
    # only those need normalising, and only those used to be skipped for being
    # unverifiable. Tightening a plain excerpt that was never ambiguous buys nothing
    # and costs correctness -- a message containing no placeholder may legitimately be
    # quoted as part of a longer line, and the old verbatim rule allowed that. Turning
    # the new rule on it made ordinary, correct excerpts go red.
    if ($item.Literal -notmatch '<|\{|\}') {
        if (-not (Test-LiteralPresent -Source $source -Literal $item.Literal)) {
            $missing += $item
        }
        continue
    }
    # An excerpt with a placeholder may spell it differently, so compare normalised.
    if (-not (Test-LiteralPresentNormalised -Source $source -Literal $item.Literal)) {
        $missing += $item
    }
}

# Two counts, because they answer two different questions and neither replaces the
# other. `occurrences` counts how many times an excerpt appears (the same sentence
# quoted twice is two); `distinct` counts how many different sentences must be
# checked. They differ whenever a doc quotes the same message more than once, which
# happens in this corpus -- so the gap is normal, not a miscount. Reporting only one
# number has already caused a reader to read the gap as missing rows.
$occurrences = $literals.Count
$distinct = @($literals | ForEach-Object { $_.Literal } | Sort-Object -Unique).Count
Write-Output "Checked $occurrences excerpt occurrence(s) ($distinct distinct) across $($docs.Count) doc file(s), including $($requiredLiterals.Count) required excerpts."

if ($missing.Count -gt 0 -or $suspicious.Count -gt 0) {
    Write-Output ""
    if ($missing.Count -gt 0) {
        Write-Output "UNVERIFIED - these are quoted in docs but absent from source:"
        foreach ($item in $missing) {
            $location = if ($item.Id) { "$($item.Doc):$($item.Id)" } else { "$($item.Doc):$($item.Line)" }
            Write-Output ("  [{0}] {1}" -f $location, $item.Literal)
        }
    }
    if ($suspicious.Count -gt 0) {
        if ($missing.Count -gt 0) { Write-Output "" }
        Write-Output "TRUNCATED - these quote the start of a real message but not all of it:"
        foreach ($item in $suspicious) {
            Write-Output ("  [{0}:{1}] {2}" -f $item.Doc, $item.Line, $item.Literal)
        }
        Write-Output "Restore the missing ending, or quote the whole sentence."
    }
    Write-Output ""
    Write-Output "Either the doc quotes it inaccurately, or the source string changed and the doc must follow."
    Write-Output "A placeholder mismatch is NOT the cause: {name}, {} and <name> are all treated as equal."
    exit 1
}

Write-Output "OK - every checked literal exists in the Rust source (placeholders normalised)."

# Excerpts quoted only up to an abbreviation mark cannot be compared: there is
# nothing after the mark to match. Reported, never silently accepted.
$skipped = @($script:SkippedLiterals)
if ($skipped.Count -gt 0) {
    $skippedDistinct = @($skipped | ForEach-Object { $_.Literal } | Sort-Object -Unique).Count
    Write-Output ""
    Write-Output "NOT CHECKED - $($skipped.Count) excerpt occurrence(s) ($skippedDistinct distinct) stop at an abbreviation mark (` ...`);"
    Write-Output "these are verified by eye only, not by this script:"
    foreach ($literal in ($skipped | ForEach-Object { $_.Literal } | Sort-Object -Unique)) {
        Write-Output ("  " + $literal)
        foreach ($hit in ($skipped | Where-Object { $_.Literal -ceq $literal })) {
            Write-Output ("        at {0}:{1}" -f $hit.Doc, $hit.Line)
        }
    }
}
# The four required excerpts are printed as id -> excerpt pairs on every run, not only on
# failure. The script cannot prove an id is bound to the right sentence: swapping two
# markers leaves both present, both real source strings, and the run green. A human must
# read the pairs, so put them where a human reads. Printing the doc's own text is not a
# second copy of the truth -- it is the same text, shown in the one place review happens.
Write-Output ""
Write-Output "Required excerpts (id -> text currently bound to it; verify these pairings by eye):"
foreach ($item in $requiredLiterals) {
    Write-Output ("  {0}" -f $item.Id)
    Write-Output ("    -> {0}" -f $item.Literal)
}

Write-Output ""
Write-Output "Reminder: this proves no drift in wording only. It does NOT prove the surrounding advice,"
Write-Output "or which code path raises a message, or how many paths do. Those need spot-checking"
Write-Output "against the throw sites on the branch you are documenting."
Write-Output "It also does NOT prove that a required excerpt's fixed ID is bound to the right sentence."
Write-Output "Swapping two markers still passes: both are present and both are real source strings."
Write-Output "That pairing is verified by a human reading the pairs printed above, not by this script."
exit 0
