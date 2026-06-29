# Register a Windows Scheduled Task that keeps the approval bridge running.
#
# Task name: "claude-mobile-approver-bridge"
#   Trigger : at LOGON of the current user
#   Action  : node "<abs repo>/scripts/run-bridge.mjs"   (working dir = repo root)
#   On fail : restart (3 attempts, 1 min apart)
#
# This only keeps the BRIDGE process alive. It does NOT install hooks and does NOT gate any
# tool calls, so it is SAFE on its own — gating is a separate, deliberate step
# (scripts/install-hooks-global.mjs --apply).
#
# Idempotent: re-running replaces the existing task definition.
# Reversible: scripts/uninstall-autostart.ps1 removes it.
#
# Usage (run by YOU, not auto-invoked):
#   pwsh scripts/install-autostart.ps1
#
# Notes:
#   - No admin rights needed: the task runs as the current interactive user (-RunLevel Limited).
#   - If `node` is not on PATH for non-interactive task context, edit $NodeExe below to the
#     absolute node.exe path.

$ErrorActionPreference = "Stop"

$TaskName = "claude-mobile-approver-bridge"

# scripts/ -> repo root is one level up. Resolve to absolute paths.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RunBridge = Join-Path $RepoRoot "scripts\run-bridge.mjs"

# Prefer the node on PATH; fall back gracefully to the bare command name.
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeExe = if ($NodeCmd) { $NodeCmd.Source } else { "node" }

if (-not (Test-Path $RunBridge)) {
  Write-Error "run-bridge.mjs not found at $RunBridge"
  exit 1
}

Write-Host "Registering Scheduled Task '$TaskName'"
Write-Host "  user      : $env:USERNAME"
Write-Host "  trigger   : AtLogOn"
Write-Host "  action    : `"$NodeExe`" `"$RunBridge`""
Write-Host "  workingDir: $RepoRoot"
Write-Host "  onFailure : restart x3, 1 min apart"
Write-Host ""

$Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$RunBridge`"" -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

# -Force makes this idempotent: replaces an existing task with the same name.
Register-ScheduledTask -TaskName $TaskName `
  -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings `
  -Description "Keeps the claude-mobile-approver bridge running at logon (loopback only; no gating)." `
  -Force | Out-Null

Write-Host "Registered. The bridge will start at your next logon."
Write-Host "Start it now without logging out:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove it:                         pwsh scripts/uninstall-autostart.ps1"
