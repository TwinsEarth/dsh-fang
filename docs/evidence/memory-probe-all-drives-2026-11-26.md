# 证据：全盘 pagefile/commit 探针（Windows 11 / TOFUTURE）

- 日期：2026-11-26
- 机器：TOFUTURE，Windows 11 build 26300
- 目的：证明 pagefile/commit 探针不再只看 C 盘，能列出 D: 分页文件、所有卷和 commit 上限

## 命令

在 Windows 上执行与 `src/lib/memory-guard.mjs` 同形的 PowerShell 脚本：

```powershell
$o = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$mm = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management" -ErrorAction SilentlyContinue
$pf = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ Name=[string]$_.Name; AllocatedBaseSize=[double]$_.AllocatedBaseSize; CurrentUsage=[double]$_.CurrentUsage; PeakUsage=[double]$_.PeakUsage }
})
$pfs = @(Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ Name=[string]$_.Name; InitialSize=[double]$_.InitialSize; MaximumSize=[double]$_.MaximumSize }
})
$vol = @(Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | ForEach-Object {
  [pscustomobject]@{ DeviceID=[string]$_.DeviceID; SizeMB=[math]::Round($_.Size / 1MB); FreeMB=[math]::Round($_.FreeSpace / 1MB); FileSystem=[string]$_.FileSystem }
})
$pfMB = [math]::Round((@($pf) | Measure-Object -Property AllocatedBaseSize -Sum).Sum)
$ramMB = [math]::Round($o.TotalVisibleMemorySize / 1024)
[pscustomobject]@{
  CommitLimitOSMB = [math]::Round($o.TotalVirtualMemorySize / 1024)
  CommitLimitDerivedMB = $ramMB + $pfMB
  CommitFreeMB = [math]::Round($o.FreeVirtualMemory / 1024)
  PhysicalTotalMB = $ramMB
  PageFileMB = $pfMB
  PageFileUsageMB = [math]::Round((@($pf) | Measure-Object -Property CurrentUsage -Sum).Sum)
  PageFilePeakMB = [math]::Round((@($pf) | Measure-Object -Property PeakUsage -Sum).Sum)
  PageFileDetails = @($pf)
  PageFileSettings = @($pfs)
  Volumes = @($vol)
  PagingFiles = [string](@($mm.PagingFiles) -join ";")
} | ConvertTo-Json -Compress -Depth 6
```

## 结果

```json
{"CommitLimitOSMB":44821,"CommitLimitDerivedMB":44821,"CommitFreeMB":17311,"PhysicalTotalMB":32476,"PhysicalFreeMB":17176,"PageFileMB":12345,"PageFileUsageMB":58,"PageFilePeakMB":69,"PageFileDetails":[{"Name":"D:\\pagefile.sys","AllocatedBaseSize":12345,"CurrentUsage":58,"PeakUsage":69}],"PageFileSettings":[{"Name":"d:\\pagefile.sys","InitialSize":12345,"MaximumSize":23456}],"Volumes":[{"DeviceID":"C:","SizeMB":203420,"FreeMB":86559,"FileSystem":"NTFS"},{"DeviceID":"D:","SizeMB":716809,"FreeMB":136221,"FileSystem":"NTFS"},{"DeviceID":"E:","SizeMB":1907712,"FreeMB":618575,"FileSystem":"NTFS"}],"PagingFiles":"d:\\pagefile.sys 12345 23456","AutomaticManagedPagefile":false,"SelfRssMB":86,"SelfPrivateMB":70}
```

## 判读

- 活动分页文件：`D:\pagefile.sys`，12345 MB，当前使用 58 MB；
- 系统盘 C: 没有活动分页文件；
- `CommitLimitOSMB=44821` 与 `物理内存 32476 + 分页文件 12345 = 44821` 一致；
- `PageFileDrives` 应解析为 `["D:"]`，`pageFileOffSystemDrive=true`；
- 旧输出只有一个 `PageFileMB=12345`，无法区分是 C 还是 D；新输出带 `PageFileDetails/PageFileSettings/Volumes`，可逐盘核对。

## 宿主 session 体量（同一机器，只读 stat）

```text
%USERPROFILE%\.dsh\sessions
TOTAL MB=222.56 files=206
60.91 MB  --E-DSH-DS--\session-ad7ddc1f-...\session.v4.jsonl.zstd
40.30 MB  --E-DSH-DS--\session-ac6d0217-...\session.v4.jsonl.zstd
25.01 MB  --E-DSH-DS--\session-24a36ef3-...\session.v4.jsonl.zstd
```

这说明 Host 侧确实存在单文件 60 MB 级会话；按 v3.8.14 默认单文件 48 MB 紧急线，会在首次扫描后拒绝新分身/新浏览器，直到该会话被归档/压缩。
