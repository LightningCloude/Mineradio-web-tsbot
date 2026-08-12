$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
. (Join-Path $repoRoot 'scripts/Import-TsbotEnv.ps1')

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    throw 'Missing npm.cmd in PATH. Install Node.js first.'
}

$vite = Join-Path $repoRoot 'web/node_modules/.bin/vite.cmd'
if (-not (Test-Path $vite)) {
    throw 'Missing web/node_modules/.bin/vite.cmd. Run npm.cmd --prefix web install first.'
}

$hostAddr = if ($env:TSBOT_WEB_HOST) {
    $env:TSBOT_WEB_HOST.Trim() -replace '^https?://', '' -replace '/.*$', '' -replace ':.+$', ''
} else {
    '127.0.0.1'
}

$port = if ($env:TSBOT_WEB_PORT) {
    $env:TSBOT_WEB_PORT.Trim().TrimStart(':')
} else {
    '8080'
}

Push-Location (Join-Path $repoRoot 'web')
try {
    & $npm.Source run build
    & $vite preview --host $hostAddr --port $port
}
finally {
    Pop-Location
}
