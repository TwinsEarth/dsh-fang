# Windows Job Object E2E evidence — 2026-11-26

Host: Microsoft Windows 11 专业版 (build 26300)
Node: v22.23.2
Helper: fang-job-host.exe, 82944 bytes
SHA-256: ffc01a6b1f4f7caaaefe04236d1cdb987c92997f00750e9c34db75837276b9a1

Command:

    node tools/job-object-windows-e2e.mjs --helper native/win32/fang-job-host.exe --memory

Output:

    PASS kill-on-close helper=21540 child=23484 (kill-on-close)
    PASS job-memory-64mb helper=9676 child=22076 exit=1 (memory limit enforced)
    PASS process-memory-64mb helper=21832 child=3712 exit=1 (memory limit enforced)
    PASS job-object-e2e

## What each case proves
1. kill-on-close: only the helper was terminated (no taskkill /T). Windows closed the Job handle and killed child 23484, proving KILL_ON_JOB_CLOSE owns the tree.
2. job-memory-64mb: --job-memory-mb 64 made a growing child fail allocation (child exit 1), proving JOB_OBJECT_LIMIT_JOB_MEMORY.
3. process-memory-64mb: --job-process-memory-mb 64 did the same per process, proving JOB_OBJECT_LIMIT_PROCESS_MEMORY.

## Conclusion
CREATE_SUSPENDED -> AssignProcessToJobObject -> ResumeThread works on a real Windows host; KILL_ON_JOB_CLOSE and both memory limits are effective.
