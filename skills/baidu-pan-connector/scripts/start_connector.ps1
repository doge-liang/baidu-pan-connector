[CmdletBinding()]
param(
    [string]$StateRoot = $env:BAIDU_PAN_CONNECTOR_STATE_DIR,
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $skillRoot 'tools\bridge.py'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
if (-not $StateRoot) {
    $StateRoot = Join-Path $codexHome 'state\baidu-pan-connector'
}
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$logs = Join-Path $StateRoot 'logs'
$pythonCache = Join-Path $StateRoot 'cache\python'
New-Item -ItemType Directory -Path $logs, $pythonCache -Force | Out-Null

$env:BAIDU_PAN_CONNECTOR_STATE_DIR = $StateRoot
$env:PYTHONPYCACHEPREFIX = $pythonCache
# Some managed Windows environments expose `python` through a persistent
# wrapper process. Prefer the Python launcher to resolve the real interpreter
# so the PID written below owns the listening socket itself.
$python = (& py -3 -c "import sys; print(sys.executable)").Trim()
if (-not $python -or -not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'Unable to resolve the Python interpreter executable.'
}

if ($Background) {
    $stdout = Join-Path $logs 'bridge-stdout.log'
    $stderr = Join-Path $logs 'bridge-stderr.log'
    $process = Start-Process -FilePath $python `
        -ArgumentList @('-B', $bridge) `
        -WorkingDirectory $skillRoot `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -LiteralPath (Join-Path $StateRoot 'bridge.pid') -Value $process.Id
    Write-Output "Baidu Pan Connector started: pid=$($process.Id) state=$StateRoot"
    return
}

& $python -B $bridge
exit $LASTEXITCODE
