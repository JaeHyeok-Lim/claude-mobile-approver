# Bring the bridge online + reachable from the phone (Windows / PowerShell).
# Thin wrapper over scripts/up.mjs. Forwards any flags (e.g. --provider ngrok).
#   pwsh scripts/up.ps1
#   pwsh scripts/up.ps1 --provider cloudflare --mode named
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $here "up.mjs") @args
exit $LASTEXITCODE
