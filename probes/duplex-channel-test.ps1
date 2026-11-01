// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
# Experiment: duplex inherited-pipe channel (host -> worker via stdin, worker -> host via stdout).
# ASCII only.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -Path (Join-Path $here 'AppContainerHost.cs')

$attach = [AppContainerHost]::Attach('dsh-worker')
Write-Output ("attach=" + $attach)
if ($attach -like '*FAIL*') { exit 1 }
$folder = [AppContainerHost]::FolderPath()
$work = Join-Path $folder 'duplex-work'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$nodeCopy = Join-Path $work 'node.exe'
if (-not (Test-Path $nodeCopy)) { Copy-Item (Get-Command node).Source $nodeCopy -Force }
Copy-Item (Join-Path $here 'worker-duplex.js') (Join-Path $work 'worker-duplex.js') -Force

$boot = 'const fs=require(''node:fs'');const d=process.argv[1];const src=fs.readFileSync(d+''/worker-duplex.js'',''utf8'');process.argv=[''node'',''worker-duplex.js''];const u=''data:text/javascript;base64,'' + Buffer.from(src).toString(''base64'');import(u).catch(e=>{process.stdout.write(JSON.stringify({ok:false,result:{bootError:String(e&&e.message||e)}})+''\n'')});'
$cmd = '"' + $nodeCopy + '" -e "' + $boot + '" "' + $work + '"'

function Send-Worker($op, $payload) {
  $req = @{ id = [guid]::NewGuid().ToString('N').Substring(0,8); op = $op; payload = $payload } | ConvertTo-Json -Compress
  $out = $null
  $res = [AppContainerHost]::LaunchDuplex($cmd, $work, 30000, $req, [ref]$out)
  Write-Output ("  [" + $op + "] launch=" + $res)
  Write-Output ("  [" + $op + "] stdout=" + $out)
}

Write-Output '=== 1) ping ==='
Send-Worker 'ping' $null
Write-Output '=== 2) compute ==='
Send-Worker 'compute' @(10, 20, 30)
Write-Output '=== 3) isolation ==='
Send-Worker 'isolation' $null

[AppContainerHost]::ReleaseSid()
Write-Output 'done'
