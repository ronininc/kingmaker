$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$Verifier = Join-Path $Source 'portable-verify.mjs'
# UNIT.json and payload.json must match before an existing directory is touched.
& $Node $Verifier verify $Source windows
if ($LASTEXITCODE -ne 0) { throw 'Invalid UNIT.json or payload.json' }
$Dest = if ($env:KINGMAKER_ENGINE_HOME) { $env:KINGMAKER_ENGINE_HOME } else { Join-Path $env:LOCALAPPDATA 'Ronin\Kingmaker' }
& $Node $Verifier safe-destination $Source $Dest $HOME
if ($LASTEXITCODE -ne 0) { throw 'Refusing an unsafe Kingmaker install directory' }
$Dest = [IO.Path]::GetFullPath($Dest)
$Parent = Split-Path -Parent $Dest
[IO.Directory]::CreateDirectory($Parent) | Out-Null
$Lock = "$Dest.install-lock"
$LockHandle = [IO.File]::Open($Lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$Stage = "$Dest.stage-$PID"
$Backup = "$Dest.backup-$PID"
$Moved = $false
$Placed = $false
$StageOwned = $false
try {
  if ((Test-Path -LiteralPath $Stage) -or (Test-Path -LiteralPath $Backup)) { throw 'Staging path already exists' }
  New-Item -ItemType Directory -Path $Stage -ErrorAction Stop | Out-Null
  $StageOwned = $true
  Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Stage -Recurse
  & $Node (Join-Path $Stage 'portable-verify.mjs') verify $Stage windows
  if ($LASTEXITCODE -ne 0) { throw 'Staged payload verification failed' }
  if (Test-Path -LiteralPath $Dest) { Move-Item -LiteralPath $Dest -Destination $Backup; $Moved = $true }
  Move-Item -LiteralPath $Stage -Destination $Dest
  $Placed = $true
  if ($Moved) { Write-Output "Previous installation retained at $Backup" }
  Write-Output "Installed portable CLI: $Dest\kingmaker.cmd. No PATH, service, security or model-download settings changed."
} catch {
  if ($Placed) { Remove-Item -LiteralPath $Dest -Recurse -Force }
  if ($Moved -and (Test-Path -LiteralPath $Backup)) { Move-Item -LiteralPath $Backup -Destination $Dest }
  throw
} finally {
  if ($StageOwned -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force }
  $LockHandle.Dispose()
  Remove-Item -LiteralPath $Lock -Force
}
