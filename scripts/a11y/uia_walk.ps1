<#
Walks the UI Automation tree of the app's windows, writes it to a file and fails on what a
screen reader cannot use: an on screen button or menu item with no name, or no web document
holding a named button.

    powershell -File scripts/a11y/uia_walk.ps1 -Exe src-tauri/target/release/fundacad.exe -Out uia/uia.txt

The walk is Windows only. The checks work on plain nodes, so they are tested wherever pwsh
runs (tests/build/test_uia_walk.ps1 dot sources this file with -Library).
#>
param(
    [string]$Exe = '',
    [int]$ProcessId = 0,
    [string]$Out = 'uia.txt',
    [double]$Wait = 120,
    [double]$Interval = 1,
    [switch]$Library
)

$UiaNamedRoles = @('Button', 'SplitButton', 'MenuItem')

function New-UiaNode {
    param([string]$Role, [string]$Name = '', [bool]$Offscreen = $false, [object[]]$Children = @())
    [pscustomobject]@{ Role = $Role; Name = $Name; Offscreen = $Offscreen; Children = @($Children) }
}

function Format-UiaLabel {
    param($Node)
    if ($Node.Name) { '{0} "{1}"' -f $Node.Role, $Node.Name } else { $Node.Role }
}

function Find-UiaProblems {
    param($Node, [string[]]$Path, [bool]$InDocument, $Found, $State)
    $here = @($Path) + @(Format-UiaLabel $Node)
    if ($Node.Role -eq 'Document') {
        $State.documents++
        $InDocument = $true
    }
    if (($UiaNamedRoles -contains $Node.Role) -and -not $Node.Offscreen) {
        if ([string]::IsNullOrWhiteSpace($Node.Name)) {
            $tail = $here[([Math]::Max(0, $here.Count - 5))..($here.Count - 1)]
            $Found.Add(('nameless {0} at {1}' -f $Node.Role, ($tail -join ' > ')))
        } elseif ($InDocument -and $Node.Role -eq 'Button') {
            $State.filled++
        }
    }
    foreach ($c in $Node.Children) { Find-UiaProblems $c $here $InDocument $Found $State }
}

function Get-UiaProblems {
    param([object[]]$Windows = @())
    if (-not $Windows -or $Windows.Count -eq 0) { return @('no window of the app on the UI Automation tree') }
    $found = New-Object System.Collections.Generic.List[string]
    $state = @{ documents = 0; filled = 0 }
    foreach ($w in $Windows) { Find-UiaProblems $w @() $false $found $state }
    # WebView2 builds its tree only once a client asks, so a bare Document means the page is not in yet.
    if ($state.documents -eq 0) {
        $found.Add('no Document control, the page never reached UI Automation')
    } elseif ($state.filled -eq 0) {
        $found.Add('the Document holds no named button, the page has not reached UI Automation yet')
    }
    return $found.ToArray()
}

function Format-UiaTree {
    param($Node, [int]$Depth = 0)
    $mark = ''
    if ($Node.Offscreen) { $mark = ' [offscreen]' }
    ('  ' * $Depth) + (Format-UiaLabel $Node) + $mark
    foreach ($c in $Node.Children) { Format-UiaTree $c ($Depth + 1) }
}

function Read-UiaElement {
    param($Element, [int]$Depth, [int]$MaxDepth, $Budget)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    try {
        $current = $Element.Current
        $role = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        $name = [string]$current.Name
        $offscreen = [bool]$current.IsOffscreen
    } catch {
        return New-UiaNode 'Unreadable' $_.Exception.Message $true
    }
    $kids = New-Object System.Collections.Generic.List[object]
    if ($Depth -lt $MaxDepth) {
        try { $child = $walker.GetFirstChild($Element) } catch { $child = $null }
        while ($null -ne $child -and $Budget.left -gt 0) {
            $Budget.left--
            $kids.Add((Read-UiaElement $child ($Depth + 1) $MaxDepth $Budget))
            try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
        }
    }
    New-UiaNode $role $name $offscreen $kids.ToArray()
}

function Get-UiaSnapshot {
    param([int]$ProcessId, [int]$MaxNodes = 20000, [int]$MaxDepth = 80)
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    # From the handle, not a search of the desktop, which would wake the accessibility of every other app.
    $handle = (Get-Process -Id $ProcessId).MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    Read-UiaElement $window 0 $MaxDepth @{ left = $MaxNodes }
}

function Invoke-UiaCheck {
    param(
        [scriptblock]$Take,
        [string]$Out,
        [double]$Wait,
        [double]$Interval,
        [scriptblock]$Sleep = { param($s) Start-Sleep -Milliseconds ([int]($s * 1000)) },
        [scriptblock]$Clock = { [Diagnostics.Stopwatch]::GetTimestamp() / [Diagnostics.Stopwatch]::Frequency }
    )
    $deadline = (& $Clock) + $Wait
    while ($true) {
        $windows = @(& $Take)
        $found = @(Get-UiaProblems $windows)
        if ($found.Count -eq 0 -or (& $Clock) -ge $deadline) { break }
        & $Sleep $Interval
    }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("windows of the app: $($windows.Count)")
    $lines.Add('')
    foreach ($w in $windows) { foreach ($l in @(Format-UiaTree $w)) { $lines.Add($l) } }
    Set-Content -LiteralPath $Out -Value $lines -Encoding UTF8
    $mark = ''
    if ($env:GITHUB_ACTIONS) { $mark = '::error::' }
    foreach ($p in $found) { Write-Host "${mark}uia: $p" }
    if ($found.Count -eq 0) {
        Write-Host "uia: $($windows.Count) window(s) checked, no nameless control, a document is present"
        return 0
    }
    return 1
}

if ($Library) { return }

$ErrorActionPreference = 'Stop'
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
$dir = Split-Path -Parent $Out
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$proc = $null
$code = 1
try {
    if ($Exe) {
        $logs = @{ RedirectStandardOutput = (Join-Path $dir 'gui.out.log'); RedirectStandardError = (Join-Path $dir 'gui.err.log') }
        $proc = Start-Process -FilePath $Exe -PassThru @logs
        # Note: without touching Handle now, ExitCode reads null once the process has gone.
        $null = $proc.Handle
        $ProcessId = $proc.Id
    }
    if ($ProcessId -le 0) { throw 'give -Exe to start the app or -ProcessId of a running one' }
    $take = {
        if ($proc -and $proc.HasExited) { throw "the app exited with code $($proc.ExitCode) before its window was walked" }
        Get-UiaSnapshot -ProcessId $ProcessId
    }
    $code = Invoke-UiaCheck -Take $take -Out $Out -Wait $Wait -Interval $Interval
} catch {
    $mark = ''
    if ($env:GITHUB_ACTIONS) { $mark = '::error::' }
    Write-Host "${mark}uia: $($_.Exception.Message)"
    $code = 1
} finally {
    if ($proc -and -not $proc.HasExited) { & taskkill.exe /PID $proc.Id /T /F | Out-Null }
}
exit $code
