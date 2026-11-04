$ErrorActionPreference = 'Stop'

$Unit = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = if ($env:KINGMAKER_ENGINE_HOME) { [IO.Path]::GetFullPath($env:KINGMAKER_ENGINE_HOME) } else { Join-Path $env:LOCALAPPDATA 'Ronin\Kingmaker' }
$Dest = [IO.Path]::GetFullPath($Dest)
if ([IO.Path]::GetPathRoot($Dest) -eq $Dest -or $Dest.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) { throw "Refusing an unsafe Kingmaker install directory: $Dest" }
$Stage = "$Dest.new.$PID"
$Backup = "$Dest.backup.$PID"

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Kingmaker requires Node.js 22 or newer.' }
$major = [int]((& $node.Source -p "Number(process.versions.node.split('.')[0])").Trim())
if ($major -lt 22) { throw "Kingmaker requires Node.js 22 or newer (found $(& $node.Source --version))." }

$required = @('UNIT.json', 'engine\payload.json', 'engine\lib\kingmaker.mjs', 'kingmaker.cmd')
foreach ($name in $required) { if (-not (Test-Path -LiteralPath (Join-Path $Unit $name))) { throw "This Kingmaker unit is incomplete: $name is missing; nothing was installed." } }
$identity = Get-Content -LiteralPath (Join-Path $Unit 'UNIT.json') -Raw | ConvertFrom-Json
$payload = Get-Content -LiteralPath (Join-Path $Unit 'engine\payload.json') -Raw | ConvertFrom-Json
if ($identity.schema -ne 'kingmaker.unit/1' -or $identity.unit -ne 'kingmaker' -or $identity.platform -ne 'windows' -or $identity.arch -ne 'x64') { throw 'Invalid Windows unit identity.' }
if ($identity.version -ne $payload.version) { throw 'Unit and payload versions differ.' }

Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Stage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $Unit 'engine') -Destination (Join-Path $Stage 'engine') -Recurse
Copy-Item -LiteralPath (Join-Path $Unit 'UNIT.json') -Destination $Stage
Copy-Item -LiteralPath (Join-Path $Unit 'kingmaker.cmd') -Destination $Stage
Copy-Item -LiteralPath (Join-Path $Unit 'PORTABLE-NOTES.txt') -Destination $Stage

$movedOld = $false
try {
  if (Test-Path -LiteralPath $Dest) { Move-Item -LiteralPath $Dest -Destination $Backup; $movedOld = $true }
  Move-Item -LiteralPath $Stage -Destination $Dest
  if ($movedOld) { Remove-Item -LiteralPath $Backup -Recurse -Force }
} catch {
  Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
  if ($movedOld -and -not (Test-Path -LiteralPath $Dest) -and (Test-Path -LiteralPath $Backup)) { Move-Item -LiteralPath $Backup -Destination $Dest }
  throw
}

$version = (Get-Content -LiteralPath (Join-Path $Dest 'engine\package.json') -Raw | ConvertFrom-Json).version
Write-Host "Installed Kingmaker $version in $Dest"
Write-Host "Launcher: $Dest\kingmaker.cmd"
