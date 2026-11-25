// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
# Pipe-based container executor (raw protocol): source code goes IN over stdin,
# JSON result comes OUT over stdout. No code/result files cross the boundary.
# ASCII only.
param(
  [Parameter(Mandatory=$true)][string]$CodeFile,
  [Parameter(Mandatory=$true)][string]$ResultFile,
  [int]$TimeoutSec = 60
)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -Path (Join-Path $here 'AppContainerHost.cs')

$attach = [AppContainerHost]::Attach('dsh-worker')
if ($attach -like '*FAIL*') {
  $c = [AppContainerHost]::Create('dsh-worker')
  if (-not $c.StartsWith('OK')) { Set-Content -Path $ResultFile -Value '{"ok":false,"error":"attach/create failed"}' -Encoding UTF8; exit 1 }
  $attach = [AppContainerHost]::Attach('dsh-worker')
}
$folder = [AppContainerHost]::FolderPath()
if (-not $folder -or $folder -like '*FAIL*') {
  Set-Content -Path $ResultFile -Value '{"ok":false,"error":"no container folder"}' -Encoding UTF8
  [AppContainerHost]::ReleaseSid(); exit 1
}
$work = Join-Path $folder 'pipe-exec'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$nodeCopy = Join-Path $work 'node.exe'
if (-not (Test-Path $nodeCopy)) { Copy-Item (Get-Command node).Source $nodeCopy -Force }
Copy-Item (Join-Path $here 'worker-pipe-exec.mjs') (Join-Path $work 'worker-pipe-exec.mjs') -Force

# Raw source straight from disk as a string (avoid ConvertTo-Json entirely).
$code = [System.IO.File]::ReadAllText($CodeFile)
if ($null -eq $code) { $code = '' }
$code = [string]$code
Write-Host ("codeLen=" + $code.Length + " codeFile=" + $CodeFile)

$boot = 'const fs=require(''node:fs'');const d=process.argv[1];const src=fs.readFileSync(d+''/worker-pipe-exec.mjs'',''utf8'');process.argv=[''node'',''worker-pipe-exec.mjs''];const u=''data:text/javascript;base64,'' + Buffer.from(src).toString(''base64'');import(u).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message||e)})+''\n'')});'
$cmd = '"' + $nodeCopy + '" -e "' + $boot + '" "' + $work + '"'

$stdout = $null
$res = [AppContainerHost]::LaunchDuplex($cmd, $work, $TimeoutSec * 1000, $code, [ref]$stdout)
Write-Host ("launch=" + $res)
$line = ($stdout -split "`n" | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -Last 1)
if (-not $line) {
  Set-Content -Path $ResultFile -Value '{"ok":false,"error":"no stdout"}' -Encoding UTF8
} else {
  [System.IO.File]::WriteAllText($ResultFile, $line.Trim(), (New-Object System.Text.UTF8Encoding($false)))
}
[AppContainerHost]::ReleaseSid()
exit 0
