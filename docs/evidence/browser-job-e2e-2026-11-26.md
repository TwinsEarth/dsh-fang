# Windows browser Job Object E2E evidence — 2026-11-26

Host: Microsoft Windows 11 家庭版 (build 26300)
Edge: 158.0.4370.33
Helper: fang-job-host.exe, 82944 bytes
SHA-256: ffc01a6b1f4f7caaaefe04236d1cdb987c92997f00750e9c34db75837276b9a1

Command: node tools/browser-job-windows-e2e.mjs --helper native/win32/fang-job-host.exe

Output:
PASS browser root=8884 helper=15556 tree=8884,5948,17000,15588,14300,4904,13332,2376,17168,9456,17972,6328,8908,18140
PASS browser tree gone after kill-on-close (root=8884)

Method: launched headless Edge under the Job helper; confirmed the root plus 13 Edge children; terminated only the helper (not taskkill /T); every Edge process carrying the unique profile path disappeared.
