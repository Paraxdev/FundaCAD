# The UI Automation checks against fake trees, no window needed.
#   pwsh tests/build/test_uia_walk.ps1
$ErrorActionPreference = 'Stop'
# The deadline cases print what the walk would report, which must not land as annotations of this job.
Remove-Item Env:GITHUB_ACTIONS -ErrorAction SilentlyContinue
. (Join-Path $PSScriptRoot '../../scripts/a11y/uia_walk.ps1') -Library

$failures = New-Object System.Collections.Generic.List[string]
function Check([string]$What, [bool]$Ok) {
    if ($Ok) { Write-Host "ok   $What" } else { Write-Host "FAIL $What"; $failures.Add($What) }
}
function Page([object[]]$Kids = @()) {
    New-UiaNode 'Window' 'FundaCAD' $false @(New-UiaNode 'Pane' 'FundaCAD' $false @(New-UiaNode 'Document' 'FundaCAD' $false $Kids))
}
function Problems([object[]]$Windows) { , @(Get-UiaProblems $Windows) }

$okButton = New-UiaNode 'Button' 'New design'
$bare = New-UiaNode 'Button' ''

Check 'a page with a named button passes' ((Problems @(Page @($okButton))).Count -eq 0)

$p = Problems @(Page @($okButton, $bare))
Check 'a nameless button on screen fails' ($p.Count -eq 1 -and $p[0] -eq 'nameless Button at Window "FundaCAD" > Pane "FundaCAD" > Document "FundaCAD" > Button')

$p = Problems @(Page @($okButton, (New-UiaNode 'Button' "  `t")))
Check 'a name of only whitespace is no name' ($p.Count -eq 1 -and $p[0] -like 'nameless Button at *')

$p = Problems @(Page @($okButton, (New-UiaNode 'Button' '' $true)))
Check 'a nameless button off screen is left alone' ($p.Count -eq 0)

$p = Problems @(Page @($okButton, (New-UiaNode 'MenuItem' ''), (New-UiaNode 'SplitButton' '')))
Check 'a nameless menu item and split button fail' ($p.Count -eq 2 -and $p[0] -like 'nameless MenuItem at *' -and $p[1] -like 'nameless SplitButton at *')

$p = Problems @(Page @($okButton, (New-UiaNode 'Text' ''), (New-UiaNode 'Group' '')))
Check 'text and groups may go without a name' ($p.Count -eq 0)

$chrome = New-UiaNode 'Window' 'FundaCAD' $false @((New-UiaNode 'TitleBar' '' $false @($bare)), (Page @($okButton)))
$p = Problems @($chrome)
Check 'a nameless button outside the page fails too' ($p.Count -eq 1 -and $p[0] -eq 'nameless Button at Window "FundaCAD" > TitleBar > Button')

$deep = $bare
foreach ($i in 1..6) { $deep = New-UiaNode 'Group' "g$i" $false @($deep) }
$p = Problems @(Page @($okButton, $deep))
Check 'the path names the last five steps' ($p.Count -eq 1 -and $p[0] -eq 'nameless Button at Group "g4" > Group "g3" > Group "g2" > Group "g1" > Button')

$p = Problems @()
Check 'no window fails' ($p.Count -eq 1 -and $p[0] -eq 'no window of the app on the UI Automation tree')

$p = Problems @(New-UiaNode 'Window' 'FundaCAD' $false @($okButton))
Check 'a window with no document fails' ($p.Count -eq 1 -and $p[0] -eq 'no Document control, the page never reached UI Automation')

$p = Problems @(Page)
Check 'an empty document fails' ($p.Count -eq 1 -and $p[0] -like 'the Document holds no named button*')

$p = Problems @((New-UiaNode 'Window' 'FundaCAD' $false @($okButton, (New-UiaNode 'Document' 'FundaCAD'))))
Check 'a named button beside the document does not fill it' ($p.Count -eq 1 -and $p[0] -like 'the Document holds no named button*')

$p = Problems @(Page @(New-UiaNode 'MenuItem' 'Open'))
Check 'only a named button fills the document' ($p.Count -eq 1 -and $p[0] -like 'the Document holds no named button*')

$tree = @(Format-UiaTree (Page @($okButton, (New-UiaNode 'Button' 'Later' $true))))
Check 'the tree indents each level and marks what is off screen' (
    $tree.Count -eq 5 -and $tree[0] -eq 'Window "FundaCAD"' -and $tree[3] -eq '      Button "New design"' -and $tree[4] -eq '      Button "Later" [offscreen]')

$out = Join-Path ([IO.Path]::GetTempPath()) "uia-walk-test-$PID.txt"
$fakeTime = @{ now = 0.0; naps = 0 }
$nap = { param($s) $fakeTime.now += $s; $fakeTime.naps++ }
$now = { $fakeTime.now }
$walks = @{ n = 0 }
$building = {
    $walks.n++
    if ($walks.n -lt 3) { New-UiaNode 'Window' 'FundaCAD' $false @(New-UiaNode 'Document' 'FundaCAD') } else { Page @($okButton) }
}
$code = Invoke-UiaCheck -Take $building -Out $out -Wait 10 -Interval 1 -Sleep $nap -Clock $now
Check 'the walk asks again while the page builds and passes once it holds a named button' ($code -eq 0 -and $walks.n -eq 3 -and $fakeTime.naps -eq 2)
$text = Get-Content -LiteralPath $out -Raw
Check 'and writes the last walk' ($text -match 'windows of the app: 1' -and $text -match 'Button "New design"')

$fakeTime.now = 0.0
$fakeTime.naps = 0
$walks.n = 0
$broken = { $walks.n++; Page @($okButton, $bare) }
$code = Invoke-UiaCheck -Take $broken -Out $out -Wait 3 -Interval 1 -Sleep $nap -Clock $now
Check 'the walk gives up at the deadline and fails' ($code -eq 1 -and $walks.n -eq 4 -and $fakeTime.naps -eq 3)
Check 'and still writes the tree it failed on' ((Get-Content -LiteralPath $out -Raw) -match '(?m)^      Button\r?$')

$code = Invoke-UiaCheck -Take { } -Out $out -Wait 0 -Interval 1 -Sleep $nap -Clock $now
Check 'a walk that finds no window fails' ($code -eq 1 -and (Get-Content -LiteralPath $out -Raw) -match 'windows of the app: 0')
Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue

if ($failures.Count) {
    Write-Host "$($failures.Count) failed"
    exit 1
}
Write-Host 'all passed'
