# Remove the "claude-mobile-approver-bridge" Scheduled Task installed by install-autostart.ps1.
#
# Stops the task if it's running, then unregisters it. Idempotent: a no-op if the task is absent.
# This does NOT touch the bridge's data, .env, or any installed hooks — it only removes the
# logon autostart entry.
#
# Usage (run by YOU):
#   pwsh scripts/uninstall-autostart.ps1

$ErrorActionPreference = "Stop"

$TaskName = "claude-mobile-approver-bridge"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "No Scheduled Task named '$TaskName' — nothing to remove."
  exit 0
}

Write-Host "Removing Scheduled Task '$TaskName'"

# Best-effort stop first so we don't orphan a running instance.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Removed. The bridge will no longer auto-start at logon."
Write-Host "Note: a bridge already running in this session is left alone; stop it manually if needed."
