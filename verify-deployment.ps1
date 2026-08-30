$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
. (Join-Path $repoRoot 'scripts/Import-TsbotEnv.ps1')

$script = Join-Path $repoRoot 'scripts/verify_deployment.py'
$venvPython = Join-Path $repoRoot 'backend/.venv/Scripts/python.exe'

if (Test-Path -LiteralPath $venvPython) {
    & $venvPython $script @args
    exit $LASTEXITCODE
}

$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    & $python.Source $script @args
    exit $LASTEXITCODE
}

$launcher = Get-Command py -ErrorAction SilentlyContinue
if ($launcher) {
    & $launcher.Source -3 $script @args
    exit $LASTEXITCODE
}

throw 'Python 3 not found. Install Python or create backend/.venv first.'
