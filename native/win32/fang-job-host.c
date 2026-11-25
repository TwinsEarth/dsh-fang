// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// fang-job-host.exe: Windows Job Object launcher/guard for a Fang fork.
//
// Why this exists:
//   Node has no public Win32 Job Object API. A detached sidecar + taskkill can
//   kill a visible tree, but it cannot make the kernel own the tree. This tiny
//   helper creates a Job Object with KILL_ON_JOB_CLOSE, launches the requested
//   fork host suspended, assigns it to the job before it can spawn children,
//   then resumes it. The helper holds the only job handle while the fork runs.
//
// Safety:
//   * If this helper exits/crashes, the job handle closes and Windows kills the
//     entire fork tree (including descendants that taskkill might miss).
//   * If the DSH host exits or its heartbeat file goes stale (host frozen),
//     the helper calls TerminateJobObject and exits. This is independent of the
//     host's own event loop.
//   * The child is assigned before ResumeThread, so no pre-assignment child can
//     escape the job.
//
// This binary is intentionally small and has no third-party runtime dependency.

#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <stdint.h>

#define MAX_PATH_LEN 32768

static wchar_t g_log_path[MAX_PATH_LEN];
static FILE *g_log = NULL;
static CRITICAL_SECTION g_log_lock;

static void log_open(void) {
  if (g_log || !g_log_path[0]) return;
  _wfopen_s(&g_log, g_log_path, L"a, ccs=UTF-8");
}

static void log_line_v(const wchar_t *fmt, ...) {
  log_open();
  if (!g_log) return;
  EnterCriticalSection(&g_log_lock);
  SYSTEMTIME st;
  GetLocalTime(&st);
  fwprintf(g_log, L"%04d-%02d-%02dT%02d:%02d:%02d.%03d ",
    st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  va_list ap;
  va_start(ap, fmt);
  vfwprintf(g_log, fmt, ap);
  va_end(ap);
  fwprintf(g_log, L"\n");
  fflush(g_log);
  LeaveCriticalSection(&g_log_lock);
}

static void log_simple(const wchar_t *msg) {
  log_line_v(L"%ls", msg);
}

static int is_space(wchar_t c) { return c == L' ' || c == L'\t'; }

static int needs_quote(const wchar_t *s) {
  if (!s || !*s) return 1;
  for (const wchar_t *p = s; *p; ++p) {
    if (is_space(*p) || *p == L'"' || *p == L'\\') return 1;
  }
  return 0;
}

// Quote one argv element using the CommandLineToArgvW / MSVCRT rules.
static void append_quoted(wchar_t *out, size_t cap, const wchar_t *arg, int force) {
  size_t used = wcslen(out);
  if (used >= cap - 1) return;
  if (!force && !needs_quote(arg)) {
    wcsncat(out, arg, cap - used - 1);
    return;
  }
  out[used++] = L'"';
  out[used] = 0;
  size_t backslashes = 0;
  for (const wchar_t *p = arg; *p; ++p) {
    if (*p == L'\\') {
      backslashes++;
      continue;
    }
    if (*p == L'"') {
      for (size_t i = 0; i < backslashes * 2 + 1 && used < cap - 1; ++i) out[used++] = L'\\';
      if (used < cap - 1) out[used++] = L'"';
    } else {
      for (size_t i = 0; i < backslashes && used < cap - 1; ++i) out[used++] = L'\\';
      if (used < cap - 1) out[used++] = *p;
    }
    backslashes = 0;
  }
  for (size_t i = 0; i < backslashes * 2 && used < cap - 1; ++i) out[used++] = L'\\';
  if (used < cap - 1) out[used++] = L'"';
  out[used] = 0;
}

static uint64_t file_mtime_ms(const wchar_t *path, int *exists) {
  WIN32_FILE_ATTRIBUTE_DATA data;
  if (!GetFileAttributesExW(path, GetFileExInfoStandard, &data)) {
    if (exists) *exists = 0;
    return 0;
  }
  if (exists) *exists = 1;
  ULARGE_INTEGER value;
  value.LowPart = data.ftLastWriteTime.dwLowDateTime;
  value.HighPart = data.ftLastWriteTime.dwHighDateTime;
  // FILETIME is 100ns since 1601; convert to milliseconds since boot-ish epoch
  // by comparing deltas only. Return the raw 100ns value in ms units.
  return value.QuadPart / 10000ULL;
}

static uint64_t now_filetime_ms(void) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER value;
  value.LowPart = ft.dwLowDateTime;
  value.HighPart = ft.dwHighDateTime;
  return value.QuadPart / 10000ULL;
}

static void write_utf8_json_string(FILE *f, const wchar_t *s) {
  char utf8[MAX_PATH_LEN * 4];
  int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, utf8, (int)sizeof(utf8), NULL, NULL);
  if (n <= 0) { fputs("\"\"", f); return; }
  fputc('"', f);
  for (char *p = utf8; *p; ++p) {
    if (*p == '"' || *p == '\\') fputc('\\', f);
    if (*p == '\n') { fputs("\\n", f); continue; }
    if (*p == '\r') { fputs("\\r", f); continue; }
    fputc(*p, f);
  }
  fputc('"', f);
}

static int write_ready_file(const wchar_t *path, DWORD helper_pid, DWORD child_pid,
                            const wchar_t *job_name, const wchar_t *mode, const wchar_t *error) {
  if (!path || !*path) return 0;
  FILE *f = NULL;
  _wfopen_s(&f, path, L"wb");
  if (!f) return 0;
  fputs("{\"helperPid\":", f);
  fprintf(f, "%lu", (unsigned long)helper_pid);
  fputs(",\"childPid\":", f);
  fprintf(f, "%lu", (unsigned long)child_pid);
  fputs(",\"jobName\":", f);
  write_utf8_json_string(f, job_name);
  fputs(",\"mode\":", f);
  write_utf8_json_string(f, mode);
  fputs(",\"error\":", f);
  if (error && *error) write_utf8_json_string(f, error); else fputs("null", f);
  fputs("}\n", f);
  fclose(f);
  return 1;
}

static int run_child(const wchar_t *command, wchar_t **args, int argc, int shell_mode,
                     HANDLE job, const wchar_t *heartbeat, uint64_t heartbeat_timeout_ms,
                     uint64_t heartbeat_grace_ms, DWORD host_pid, const wchar_t *ready_file,
                     const wchar_t *job_name, int *exit_code) {
  wchar_t cmdline[32768];
  cmdline[0] = 0;
  const wchar_t *app = NULL;
  wchar_t comspec[MAX_PATH_LEN];
  comspec[0] = 0;

  if (shell_mode) {
    DWORD n = GetEnvironmentVariableW(L"ComSpec", comspec, MAX_PATH_LEN);
    if (n == 0 || n >= MAX_PATH_LEN) wcscpy_s(comspec, MAX_PATH_LEN, L"C:\\Windows\\System32\\cmd.exe");
    app = comspec;
    wcscpy_s(cmdline, 32768, L"/d /s /c \"");
    // cmd /s strips exactly the outer pair of quotes. Keep the executable quoted
    // even when it has no spaces: `""C:\...\dsh.cmd" args"`.
    append_quoted(cmdline, 32768, command, 1);
    for (int i = 0; i < argc; ++i) {
      wcsncat(cmdline, L" ", 32768 - wcslen(cmdline) - 1);
      // For .cmd/.bat the caller's args are already shell-quoted, matching Node's
      // shell:true behavior. Do not double-escape embedded quotes.
      wcsncat(cmdline, args[i], 32768 - wcslen(cmdline) - 1);
    }
    wcsncat(cmdline, L"\"", 32768 - wcslen(cmdline) - 1);
  } else {
    app = command;
    append_quoted(cmdline, 32768, command, 1);
    for (int i = 0; i < argc; ++i) {
      wcsncat(cmdline, L" ", 32768 - wcslen(cmdline) - 1);
      append_quoted(cmdline, 32768, args[i], 0);
    }
  }

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

  BOOL ok = CreateProcessW(app, cmdline, NULL, NULL, TRUE,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, NULL, NULL, &si, &pi);
  if (!ok) {
    DWORD err = GetLastError();
    log_line_v(L"CreateProcessW failed: %lu cmd=%ls", (unsigned long)err, cmdline);
    write_ready_file(ready_file, GetCurrentProcessId(), 0, job_name, L"kill-on-close", L"create-process-failed");
    return 126;
  }

  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    DWORD err = GetLastError();
    log_line_v(L"AssignProcessToJobObject failed: %lu (job=%ls child=%lu)", (unsigned long)err, job_name, (unsigned long)pi.dwProcessId);
    TerminateProcess(pi.hProcess, 126);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    write_ready_file(ready_file, GetCurrentProcessId(), 0, job_name, L"kill-on-close", L"job-assign-failed");
    return 126;
  }

  if (ResumeThread(pi.hThread) == (DWORD)-1) {
    DWORD err = GetLastError();
    log_line_v(L"ResumeThread failed: %lu", (unsigned long)err);
    TerminateJobObject(job, 126);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    write_ready_file(ready_file, GetCurrentProcessId(), 0, job_name, L"kill-on-close", L"resume-failed");
    return 126;
  }
  CloseHandle(pi.hThread);

  log_line_v(L"job active: helper=%lu child=%lu job=%ls", (unsigned long)GetCurrentProcessId(),
             (unsigned long)pi.dwProcessId, job_name);
  write_ready_file(ready_file, GetCurrentProcessId(), pi.dwProcessId, job_name, L"kill-on-close", NULL);

  HANDLE host = NULL;
  if (host_pid > 0) {
    host = OpenProcess(SYNCHRONIZE, FALSE, host_pid);
    if (!host) log_line_v(L"OpenProcess(host=%lu) failed: %lu", (unsigned long)host_pid, (unsigned long)GetLastError());
  }

  uint64_t started = now_filetime_ms();
  int missing_reads = 0;
  int terminated = 0;
  DWORD child_code = 0;

  for (;;) {
    HANDLE waits[2];
    DWORD count = 0;
    waits[count++] = pi.hProcess;
    if (host) waits[count++] = host;
    DWORD wait = WaitForMultipleObjects(count, waits, FALSE, 5000);
    if (wait == WAIT_OBJECT_0) {
      GetExitCodeProcess(pi.hProcess, &child_code);
      log_line_v(L"child exited: %lu", (unsigned long)child_code);
      break;
    }
    if (host && wait == WAIT_OBJECT_0 + 1) {
      log_line_v(L"host exited; terminating job");
      TerminateJobObject(job, 124);
      terminated = 1;
      child_code = 124;
      break;
    }
    if (wait == WAIT_TIMEOUT) {
      int exists = 0;
      uint64_t mtime = file_mtime_ms(heartbeat, &exists);
      uint64_t now = now_filetime_ms();
      uint64_t age = exists && mtime < now ? now - mtime : 0;
      if (!exists) {
        missing_reads++;
        if (missing_reads > 1 && now - started > heartbeat_timeout_ms + heartbeat_grace_ms) {
          log_line_v(L"heartbeat missing beyond grace; terminating job");
          TerminateJobObject(job, 124);
          terminated = 1;
          child_code = 124;
          break;
        }
      } else if (age > heartbeat_timeout_ms + heartbeat_grace_ms) {
        log_line_v(L"heartbeat stale (%llu ms); terminating job", (unsigned long long)age);
        TerminateJobObject(job, 124);
        terminated = 1;
        child_code = 124;
        break;
      }
    }
  }

  if (terminated) {
    WaitForSingleObject(pi.hProcess, 3000);
    GetExitCodeProcess(pi.hProcess, &child_code);
    if (child_code == 0) child_code = 124;
  }
  CloseHandle(pi.hProcess);
  if (host) CloseHandle(host);
  if (exit_code) *exit_code = (int)child_code;
  return (int)child_code;
}

int wmain(int argc, wchar_t **argv) {
  InitializeCriticalSection(&g_log_lock);
  const wchar_t *heartbeat = NULL;
  const wchar_t *ready_file = NULL;
  const wchar_t *job_name = L"fang-job";
  uint64_t heartbeat_timeout_ms = 120000ULL;
  uint64_t heartbeat_grace_ms = 30000ULL;
  DWORD host_pid = 0;
  int shell_mode = 0;
  int split = -1;

  for (int i = 1; i < argc; ++i) {
    if (!wcscmp(argv[i], L"--")) { split = i + 1; break; }
    if (!wcscmp(argv[i], L"--heartbeat") && i + 1 < argc) heartbeat = argv[++i];
    else if (!wcscmp(argv[i], L"--ready-file") && i + 1 < argc) ready_file = argv[++i];
    else if (!wcscmp(argv[i], L"--job-name") && i + 1 < argc) job_name = argv[++i];
    else if (!wcscmp(argv[i], L"--host-pid") && i + 1 < argc) host_pid = (DWORD)wcstoul(argv[++i], NULL, 10);
    else if (!wcscmp(argv[i], L"--heartbeat-timeout-ms") && i + 1 < argc) heartbeat_timeout_ms = _wcstoui64(argv[++i], NULL, 10);
    else if (!wcscmp(argv[i], L"--heartbeat-grace-ms") && i + 1 < argc) heartbeat_grace_ms = _wcstoui64(argv[++i], NULL, 10);
    else if (!wcscmp(argv[i], L"--log") && i + 1 < argc) wcsncpy_s(g_log_path, MAX_PATH_LEN, argv[++i], _TRUNCATE);
    else if (!wcscmp(argv[i], L"--shell")) shell_mode = 1;
  }

  if (split < 0 || split >= argc) {
    log_simple(L"missing command after --");
    return 127;
  }

  wchar_t job_name_full[512];
  swprintf_s(job_name_full, 512, L"%ls-%lu", job_name, (unsigned long)GetCurrentProcessId());

  HANDLE job = CreateJobObjectW(NULL, job_name_full);
  if (!job) {
    log_line_v(L"CreateJobObjectW failed: %lu", (unsigned long)GetLastError());
    write_ready_file(ready_file, GetCurrentProcessId(), 0, job_name_full, L"kill-on-close", L"create-job-failed");
    return 126;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    DWORD err = GetLastError();
    log_line_v(L"SetInformationJobObject failed: %lu", (unsigned long)err);
    CloseHandle(job);
    write_ready_file(ready_file, GetCurrentProcessId(), 0, job_name_full, L"kill-on-close", L"job-limit-failed");
    return 126;
  }

  int code = 0;
  int rc = run_child(argv[split], &argv[split + 1], argc - split - 1, shell_mode,
                     job, heartbeat, heartbeat_timeout_ms, heartbeat_grace_ms, host_pid,
                     ready_file, job_name_full, &code);
  CloseHandle(job);
  log_line_v(L"helper exit %d (child=%d)", rc, code);
  return rc;
}
