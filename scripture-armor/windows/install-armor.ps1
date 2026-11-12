# Scripture Armor - Windows install.
#
# DEFAULT POSTURE (Robbie's order, 2026-10-26): the vault daemon is
# ALWAYS ON. This standard install creates/loads the identity and
# then registers vaultd to start at BOOT, before any login, running
# as the owner user, restarted on failure without limit. That
# registration prints every system change it makes.
#
# HOW IT IS HOSTED - stated plainly: stock Windows cannot run a
# Node script as a true Service Control Manager service without a
# service-host binary, and no service host (WinSW / NSSM /
# node-windows) ships anywhere in this ecosystem - we checked. So
# the default is a Task Scheduler boot task with an S4U principal:
# it starts at startup whether or not anyone logs on, runs as the
# owner (so it can read the owner's identity store), stores NO
# password, and restarts on failure. Same posture as the macOS
# LaunchDaemon and the Linux systemd service; different host,
# because the host is what the platform actually provides.
#
# NOT RUN ON WINDOWS: this script was written and statically
# reviewed on a Linux machine; no Windows host was available to
# execute it. Two things are therefore labeled, not implied:
#   1. This installer itself has not yet had a live Windows run.
#   2. vaultd's Windows transport is a named pipe, computed by the
#      daemon's transport helper (daemon-transport.mjs) from the
#      identity dir — the mapping is unit-proven with the platform
#      injected, but the daemon has not yet bound a pipe on a live
#      Windows host. That first live run (WINDOWS-PROOF) is the open
#      item, and the installer prints this note again at the daemon
#      step so it is never silent.
#
# Run in an ELEVATED PowerShell for the default boot task:
#   powershell -ExecutionPolicy Bypass -File .\windows\install-armor.ps1
# The -UserTask fallback and -NoDaemon opt-out need no elevation.
#
# Options:
#   -DesignatedHost   also set the AC power plan so this host never
#                     sleeps or hibernates on AC power (powercfg
#                     standby/hibernate timeouts to 0 = never), so
#                     sleep cannot take vaultd down.
#                     (or: $env:SCRIPTURE_ARMOR_DESIGNATED_HOST = '1')
#   -UserTask         explicit fallback: an AtLogOn task in the
#                     owner's session (starts at LOGIN, ends at
#                     logoff; NOT the default posture).
#   -NoDaemon         opt out of task registration entirely;
#                     vaultd then runs only when started manually.
#                     (or: $env:SCRIPTURE_ARMOR_DAEMON = 'off';
#                      'daemon'/'service'/'boot' = default,
#                      'agent'/'user'/'logon' = the fallback, so
#                      the env var means the same three postures on
#                      every platform)
[CmdletBinding()]
param(
  [switch]$DesignatedHost,
  [switch]$UserTask,
  [switch]$NoDaemon
)
$ErrorActionPreference = 'Stop'

# --- mode + flags ------------------------------------------------------
$mode = 'boot'
if ($NoDaemon) { $mode = 'off' }
elseif ($UserTask) { $mode = 'logon' }
if ($env:SCRIPTURE_ARMOR_DAEMON) {
  switch ($env:SCRIPTURE_ARMOR_DAEMON.ToLower()) {
    'off'                        { $mode = 'off' }
    'agent'                      { $mode = 'logon' }
    'user'                       { $mode = 'logon' }
    'logon'                      { $mode = 'logon' }
    'daemon'                     { $mode = 'boot' }
    'service'                    { $mode = 'boot' }
    'boot'                       { $mode = 'boot' }
    default { throw "SCRIPTURE_ARMOR_DAEMON must be daemon, agent, or off (got: $($env:SCRIPTURE_ARMOR_DAEMON))" }
  }
}
if ($env:SCRIPTURE_ARMOR_DESIGNATED_HOST -eq '1') { $DesignatedHost = $true }

$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$ownerHome = $env:USERPROFILE
$identityDir = $null

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- locate the tree ---------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path (Split-Path -Parent $scriptDir) 'armor.mjs')) {
  $repo = Split-Path -Parent $scriptDir
} elseif (Test-Path (Join-Path $ownerHome 'scripture-armor\armor.mjs')) {
  $repo = Join-Path $ownerHome 'scripture-armor'
} else {
  throw 'could not locate the scripture-armor tree (armor.mjs not found).'
}

# --- node >= 24 ----------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host 'Scripture Armor v4 needs Node >= 24 (ML-KEM-768 / ML-DSA-65 in the standard library).'
  Write-Host 'This machine reports: no node on PATH'
  Write-Host 'Install Node 24 from nodejs.org and re-run this script.'
  exit 1
}
$nodeExe = $nodeCmd.Source
$nodeVer = (& $nodeExe -v) -replace '^v', ''
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 24) {
  Write-Host 'Scripture Armor v4 needs Node >= 24 (ML-KEM-768 / ML-DSA-65 in the standard library).'
  Write-Host "This machine reports: v$nodeVer"
  Write-Host 'Install Node 24 from nodejs.org and re-run this script.'
  exit 1
}
Write-Host "node: v$nodeVer - OK"
Write-Host "repo: $repo"
$productPaths = (& $nodeExe (Join-Path $repo 'product-paths.mjs') --home $ownerHome | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw "Invalid product identity policy" }
$identityDir = $productPaths.identityDir

# --- build variant device match ----------------------------------------
# Builds are versioned per Windows version (windows/builds.json): the
# site serves the latest build, and this installer device-matches — it
# asks the shared selector which variant fits THIS machine and prints
# the answer. A mismatch never blocks the install; it is printed so it
# is never silent.
$osBuild = [Environment]::OSVersion.Version.Build
$selector = Join-Path $repo 'windows\select-build.mjs'
$buildsManifest = Join-Path $repo 'windows\builds.json'
if ((Test-Path $selector) -and (Test-Path $buildsManifest)) {
  $pick = (& $nodeExe $selector --os-build $osBuild --json | ConvertFrom-Json)
  if ($pick.pick) {
    Write-Host "device match: Windows build $osBuild -> build variant $($pick.pick.variant) ($($pick.pick.matched))"
  } else {
    Write-Host "device match: NO build variant claims Windows build $osBuild - see windows\builds.json" -ForegroundColor Yellow
  }
}

# --- identity --------------------------------------------------------------
Push-Location $repo
try {
  if (Test-Path (Join-Path $identityDir 'identity.json')) {
    Write-Host "identity already exists at $identityDir - loading it (PQ migration is automatic if it predates v4):"
  } else {
    Write-Host "creating identity at $identityDir`:"
  }
  & $nodeExe armor.mjs identity --identity-dir $identityDir
  if ($LASTEXITCODE -ne 0) { throw "armor.mjs identity failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
Write-Host ''
Write-Host 'Your public identity block is printed above by the identity command.'
Write-Host ''

# --- daemon registration -----------------------------------------------------
$taskBoot = if ($productPaths.product -eq 'kingmaker') { 'KingmakerScriptureArmorVaultd' } else { 'ScriptureArmorVaultd' }
$taskLogon = $taskBoot + 'Logon'
$vaultdPath = Join-Path $repo 'vaultd.mjs'
# NO --socket is persisted in the task. The daemon's endpoint is decided
# by its one transport helper (daemon-transport.mjs) from the identity
# dir — on Windows a named pipe derived from the identity dir. An earlier
# version of this installer baked a filesystem socket path into the task
# arguments; a filesystem path is not a legal Windows IPC endpoint, and
# an explicit --socket would override the helper's default forever.
$taskArgs = "`"$vaultdPath`" serve --identity-dir `"$identityDir`""

function Register-VaultdTask([string]$name, [string]$triggerKind) {
  $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArgs -WorkingDirectory $repo
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  if ($triggerKind -eq 'boot') {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType S4U -RunLevel Highest
  } else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner
    $principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
  }
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "  [done] scheduled task registered: $name ($triggerKind trigger, runs as $owner)"
}

if ($mode -eq 'boot') {
  if (-not (Test-Admin)) {
    Write-Host 'error: the default boot task registers in Task Scheduler for startup and needs an elevated PowerShell.' -ForegroundColor Red
    Write-Host 'Re-run from an Administrator PowerShell:'
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    Write-Host 'Fallbacks: -UserTask (login-level, no elevation), or run the daemon manually:'
    Write-Host "  node `"$vaultdPath`" serve"
    exit 1
  }
  Write-Host 'Installing the vault daemon - DEFAULT always-on posture (boot task, before login).'
  Write-Host "  owner user:        $owner"
  Write-Host "  node:              $nodeExe"
  Write-Host "  repo:              $repo"
  Write-Host "  identity dir:      $identityDir"

  # Migrate a pre-existing fallback (logon) task: export, never silently delete.
  $existingLogon = Get-ScheduledTask -TaskName $taskLogon -ErrorAction SilentlyContinue
  if ($existingLogon) {
    $backup = Join-Path $identityDir "$taskLogon.backup.xml"
    if (Test-Path $backup) {
      $stamp = Get-Date -Format 'yyyyMMddHHmmss'
      $backup = Join-Path $identityDir "$taskLogon.backup.$stamp.xml"
    }
    Export-ScheduledTask -TaskName $taskLogon | Set-Content -LiteralPath $backup -Encoding Unicode
    Unregister-ScheduledTask -TaskName $taskLogon -Confirm:$false
    Write-Host "  [done] existing fallback logon task exported (not deleted) to: $backup, then unregistered"
  }

  Register-VaultdTask $taskBoot 'boot'
  Start-ScheduledTask -TaskName $taskBoot
  Write-Host '  [done] task started; vaultd now starts at boot, before login, and Task Scheduler restarts it on failure.'
  Write-Host '  [note] vaultd on Windows is UNVERIFIED on a live host - see the header of this script (named-pipe transport).'

  if ($DesignatedHost) {
    # Best-effort read of the current AC standby timeout (seconds) for the revert note.
    $prevStandby = $null
    try {
      $q = powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
      $acLine = $q | Select-String 'Current AC Power Setting Index' | Select-Object -First 1
      if ($acLine -and ($acLine.Line -match '0x([0-9a-fA-F]+)')) { $prevStandby = [Convert]::ToInt32($Matches[1], 16) }
    } catch { $prevStandby = $null }
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    Write-Host '  [done] POWER POLICY CHANGED (designated host): powercfg /change standby-timeout-ac 0 and hibernate-timeout-ac 0'
    Write-Host '         this host will not sleep or hibernate on AC power while these settings stand.'
    if ($null -ne $prevStandby) {
      $prevMin = [math]::Floor($prevStandby / 60)
      Write-Host "         revert with: powercfg /change standby-timeout-ac $prevMin  (your previous standby timeout, minutes)"
      Write-Host '         and set hibernate-timeout-ac back to your preferred minutes the same way.'
    } else {
      Write-Host '         revert with: powercfg /change standby-timeout-ac <minutes> and hibernate-timeout-ac <minutes>'
      Write-Host '         (your previous values could not be read automatically; check powercfg /query SCHEME_CURRENT SUB_SLEEP)'
    }
  } else {
    Write-Host '  [unchanged] power policy: this install did NOT change system sleep.'
    Write-Host '         on a designated always-on host, re-run with -DesignatedHost (or'
    Write-Host '         $env:SCRIPTURE_ARMOR_DESIGNATED_HOST = ''1'') to set the AC standby'
    Write-Host '         and hibernate timeouts to never, so sleep cannot take vaultd down.'
  }
  Write-Host "Daemon install complete: $taskBoot is the default, always-on posture."
  Write-Host "  remove later: Unregister-ScheduledTask -TaskName $taskBoot -Confirm:`$false"
}
elseif ($mode -eq 'logon') {
  Write-Host 'Installing the vault daemon - FALLBACK posture (AtLogOn task), per explicit request.'
  Write-Host '  WARNING: this is not the default. vaultd starts at LOGIN and ends at'
  Write-Host '  logoff; it does not run before login. Prefer the default boot task.'
  $existingBoot = Get-ScheduledTask -TaskName $taskBoot -ErrorAction SilentlyContinue
  if ($existingBoot) {
    Write-Host "  [note] the default boot task ($taskBoot) also exists; both would contend for the same socket - the boot task is the real posture."
  }
  Register-VaultdTask $taskLogon 'logon'
  Start-ScheduledTask -TaskName $taskLogon
  Write-Host '  [done] task started for this session.'
  Write-Host '  [note] vaultd on Windows is UNVERIFIED on a live host - see the header of this script (named-pipe transport).'
  Write-Host '  [unchanged] power policy: logon mode cannot change system sleep.'
  Write-Host "Fallback install complete. Remove later: Unregister-ScheduledTask -TaskName $taskLogon -Confirm:`$false"
}
else {
  Write-Host 'Vault daemon task registration SKIPPED (-NoDaemon / SCRIPTURE_ARMOR_DAEMON=off).'
  Write-Host 'This is an explicit opt-out of the default always-on posture. To install later, re-run:'
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`"   (elevated, for the default boot task)"
  Write-Host 'Or run the daemon manually in the foreground:'
  Write-Host "  node `"$vaultdPath`" serve"
}

Write-Host ''
Write-Host 'Install complete.'
