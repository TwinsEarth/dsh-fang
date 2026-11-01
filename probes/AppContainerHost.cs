// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AppContainerHost
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int CreateAppContainerProfile(string name, string displayName, string description,
        IntPtr capabilities, uint capabilityCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int DeleteAppContainerProfile(string name);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetAppContainerFolderPath(string sidString, out IntPtr folderPath);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int DeriveAppContainerSidFromAppContainerName(string appContainerName, out IntPtr sid);

    /// <summary>Binds to an existing container (persistent worker identity; create/delete are NOT performed).</summary>
    public static string Attach(string name)
    {
        IntPtr sid;
        int hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr != 0) return "ATTACH-FAIL hr=0x" + hr.ToString("X8");
        _sid = sid;
        IntPtr str = IntPtr.Zero;
        string text = null;
        if (ConvertSidToStringSidW(sid, out str)) text = Marshal.PtrToStringUni(str);
        SidString = text;
        return "OK " + text;
    }

    /// <summary>Releases the SID only (does not delete the container profile). Pair with Attach.</summary>
    public static void ReleaseSid()
    {
        if (_sid != IntPtr.Zero) { try { FreeSid(_sid); } catch { } _sid = IntPtr.Zero; }
    }

    /// <summary>Derives the SID string from a container name (existing container; does not create one).</summary>
    public static string DeriveSid(string name)
    {
        IntPtr sid = IntPtr.Zero;
        int hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr != 0) return "DERIVE-FAIL hr=0x" + hr.ToString("X8");
        IntPtr str = IntPtr.Zero;
        string text = null;
        try
        {
            if (ConvertSidToStringSidW(sid, out str)) text = Marshal.PtrToStringUni(str);
        }
        finally
        {
            if (sid != IntPtr.Zero) FreeSid(sid);
        }
        if (!string.IsNullOrEmpty(text)) SidString = text;
        return text;
    }

    /// <summary>The container own folder (the container has full access to its own content here).</summary>
    public static string FolderPath()
    {
        if (string.IsNullOrEmpty(SidString)) return null;
        IntPtr p;
        int hr = GetAppContainerFolderPath(SidString, out p);
        if (hr != 0) return "GET-FOLDER-FAIL hr=0x" + hr.ToString("X8");
        try { return Marshal.PtrToStringUni(p); } finally { Marshal.FreeCoTaskMem(p); }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr sa, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr hObject, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr hFile, byte[] buffer, uint nBytes, out uint read, IntPtr overlapped);

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint HANDLE_FLAG_INHERIT = 0x00000001;

    /// <summary>
    /// Inherited-pipe experiment: host creates anonymous pipes, passes the write end as the
    /// child stdout/stderr, and keeps the read end to read back. Candidate worker->host channel.
    /// </summary>
    public static string LaunchCapture(string cmdline, string cwd, int timeoutMs, out string captured)
    {
        captured = null;
        if (_sid == IntPtr.Zero) return "NO-SID";

        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.lpSecurityDescriptor = IntPtr.Zero;
        sa.bInheritHandle = true;
        IntPtr saPtr = Marshal.AllocHGlobal(sa.nLength);
        Marshal.StructureToPtr(sa, saPtr, false);

        IntPtr readEnd = IntPtr.Zero, writeEnd = IntPtr.Zero;
        if (!CreatePipe(out readEnd, out writeEnd, saPtr, 0))
        {
            int e = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(saPtr);
            return "PIPE-FAIL err=" + e;
        }
        Marshal.FreeHGlobal(saPtr);
        // the read end must not be inherited by the child
        SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);

        IntPtr attrList = IntPtr.Zero;
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        attrList = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
        {
            int e = Marshal.GetLastWin32Error();
            CloseHandle(readEnd); CloseHandle(writeEnd); Marshal.FreeHGlobal(attrList);
            return "INIT-ATTR-FAIL err=" + e;
        }

        SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
        caps.AppContainerSid = _sid;
        int capsSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
        IntPtr capsPtr = Marshal.AllocHGlobal(capsSize);
        Marshal.StructureToPtr(caps, capsPtr, false);
        if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            capsPtr, (IntPtr)capsSize, IntPtr.Zero, IntPtr.Zero))
        {
            int e = Marshal.GetLastWin32Error();
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(capsPtr); Marshal.FreeHGlobal(attrList);
            CloseHandle(readEnd); CloseHandle(writeEnd);
            return "UPDATE-ATTR-FAIL err=" + e;
        }

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = GetStdHandle(-10);   // STD_INPUT_HANDLE
        si.StartupInfo.hStdOutput = writeEnd;
        si.StartupInfo.hStdError = writeEnd;
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero,
            true, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi);
        int createErr = Marshal.GetLastWin32Error();

        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(capsPtr); Marshal.FreeHGlobal(attrList);
        CloseHandle(writeEnd);   // the parent no longer needs the write end

        if (!ok)
        {
            CloseHandle(readEnd);
            return "CREATE-FAIL err=" + createErr;
        }

        // read the pipe until EOF (the child exit closes the write end)
        var sb = new StringBuilder();
        var buf = new byte[4096];
        uint got;
        IntPtr deadline = IntPtr.Zero;
        while (ReadFile(readEnd, buf, (uint)buf.Length, out got, IntPtr.Zero) && got > 0)
        {
            sb.Append(Encoding.UTF8.GetString(buf, 0, (int)got));
            if (sb.Length > 1024 * 1024) break;   // 1MB safety cap
        }
        WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
        uint code = 0;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(readEnd);
        captured = sb.ToString();
        return "OK pid=" + pi.dwProcessId + " exit=" + code + " bytes=" + captured.Length;
    }

    /// <summary>
    /// Duplex inherited pipes: host -> worker via stdin, worker -> host via stdout.
    /// Used by the worker communication protocol (requests on stdin, responses on stdout).
    /// </summary>
    public static string LaunchDuplex(string cmdline, string cwd, int timeoutMs, string stdinPayload, out string stdout)
    {
        stdout = null;
        if (_sid == IntPtr.Zero) return "NO-SID";

        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.lpSecurityDescriptor = IntPtr.Zero;
        sa.bInheritHandle = true;
        IntPtr saPtr = Marshal.AllocHGlobal(sa.nLength);
        Marshal.StructureToPtr(sa, saPtr, false);

        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero;    // host writes -> child reads
        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero;  // child writes -> host reads
        if (!CreatePipe(out inRead, out inWrite, saPtr, 0) || !CreatePipe(out outRead, out outWrite, saPtr, 0))
        {
            int e = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(saPtr);
            return "PIPE-FAIL err=" + e;
        }
        Marshal.FreeHGlobal(saPtr);
        // the parent end must not be inherited
        SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);

        IntPtr attrList = IntPtr.Zero, size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        attrList = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
        {
            int e = Marshal.GetLastWin32Error();
            CloseHandle(inRead); CloseHandle(inWrite); CloseHandle(outRead); CloseHandle(outWrite);
            Marshal.FreeHGlobal(attrList);
            return "INIT-ATTR-FAIL err=" + e;
        }
        SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
        caps.AppContainerSid = _sid;
        int capsSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
        IntPtr capsPtr = Marshal.AllocHGlobal(capsSize);
        Marshal.StructureToPtr(caps, capsPtr, false);
        if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            capsPtr, (IntPtr)capsSize, IntPtr.Zero, IntPtr.Zero))
        {
            int e = Marshal.GetLastWin32Error();
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(capsPtr); Marshal.FreeHGlobal(attrList);
            CloseHandle(inRead); CloseHandle(inWrite); CloseHandle(outRead); CloseHandle(outWrite);
            return "UPDATE-ATTR-FAIL err=" + e;
        }

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = inRead;
        si.StartupInfo.hStdOutput = outWrite;
        si.StartupInfo.hStdError = outWrite;
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero,
            true, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi);
        int createErr = Marshal.GetLastWin32Error();
        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(capsPtr); Marshal.FreeHGlobal(attrList);
        CloseHandle(inRead);    // owned by the child
        CloseHandle(outWrite);  // owned by the child

        if (!ok)
        {
            CloseHandle(inWrite); CloseHandle(outRead);
            return "CREATE-FAIL err=" + createErr;
        }

        // host -> worker: write the request and close the write end (child reads EOF)
        if (!string.IsNullOrEmpty(stdinPayload))
        {
            byte[] payload = Encoding.UTF8.GetBytes(stdinPayload);
            int written = 0;
            IntPtr nWritten = Marshal.AllocHGlobal(4);
            while (written < payload.Length)
            {
                byte[] chunk = new byte[Math.Min(4096, payload.Length - written)];
                Array.Copy(payload, written, chunk, 0, chunk.Length);
                if (!WriteFile(inWrite, chunk, (uint)chunk.Length, nWritten, IntPtr.Zero)) break;
                int w = Marshal.ReadInt32(nWritten);
                if (w <= 0) break;
                written += w;
            }
            Marshal.FreeHGlobal(nWritten);
        }
        CloseHandle(inWrite);

        // worker -> host: read until EOF
        var sb = new StringBuilder();
        var buf = new byte[4096];
        uint got;
        while (ReadFile(outRead, buf, (uint)buf.Length, out got, IntPtr.Zero) && got > 0)
        {
            sb.Append(Encoding.UTF8.GetString(buf, 0, (int)got));
            if (sb.Length > 1024 * 1024) break;
        }
        WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
        uint code = 0;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(outRead);
        stdout = sb.ToString();
        return "OK pid=" + pi.dwProcessId + " exit=" + code + " out=" + stdout.Length;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr hFile, byte[] buffer, uint nBytes, IntPtr written, IntPtr overlapped);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr prev, IntPtr ret);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSidToSidW(string sidString, out IntPtr sid);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = (IntPtr)0x00020009;

    public static string SidString;
    static IntPtr _sid = IntPtr.Zero;

    public static string Create(string name)
    {
        IntPtr sid;
        int hr = CreateAppContainerProfile(name, name, "probe", IntPtr.Zero, 0, out sid);
        if (hr != 0) return "CREATE-FAIL hr=0x" + hr.ToString("X8") + " err=" + Marshal.GetLastWin32Error();
        IntPtr s = IntPtr.Zero;
        string str = null;
        if (ConvertSidToStringSidW(sid, out s)) str = Marshal.PtrToStringUni(s);
        _sid = sid;
        SidString = str;
        return "OK " + str;
    }

    public static string Launch(string cmdline, string cwd, int timeoutMs)
    {
        if (_sid == IntPtr.Zero) return "NO-SID";
        return LaunchInternal(cmdline, cwd, timeoutMs, true, null);
    }

    /// <summary>
    /// Launch with network capabilities. capabilitySids, for example:
    ///   internetClient = S-1-15-3-1
    ///   internetClientServer = S-1-15-3-2
    ///   privateNetworkClientServer = S-1-15-3-3
    /// </summary>
    public static string LaunchWithCaps(string cmdline, string cwd, int timeoutMs, string[] capabilitySids)
    {
        if (_sid == IntPtr.Zero) return "NO-SID";
        return LaunchInternal(cmdline, cwd, timeoutMs, true, capabilitySids);
    }

    /// <summary>
    /// Control experiment: the same CreateProcess code, without AppContainer attributes.
    /// If it runs, P/Invoke and struct marshalling are correct and the AppContainer failure is policy/env;
    /// if it also fails, the sample code itself is buggy.
    /// </summary>
    public static string LaunchPlain(string cmdline, string cwd, int timeoutMs)
    {
        return LaunchInternal(cmdline, cwd, timeoutMs, false, null);
    }

    static string LaunchInternal(string cmdline, string cwd, int timeoutMs, bool useAppContainer, string[] capabilitySids)
    {
        IntPtr attrList = IntPtr.Zero;
        IntPtr capsPtr = IntPtr.Zero;

        if (useAppContainer)
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attrList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
            {
                int e0 = Marshal.GetLastWin32Error();
                Marshal.FreeHGlobal(attrList);
                return "INIT-ATTR-FAIL err=" + e0;
            }

            SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
            caps.AppContainerSid = _sid;
            caps.Capabilities = IntPtr.Zero;
            caps.CapabilityCount = 0;
            caps.Reserved = 0;

            // optional capability SIDs (e.g. internetClient = S-1-15-3-1)
            int capCount = (capabilitySids == null) ? 0 : capabilitySids.Length;
            if (capCount > 0)
            {
                IntPtr capArray = Marshal.AllocHGlobal(IntPtr.Size * capCount);
                for (int i = 0; i < capCount; i++)
                {
                    IntPtr capSid;
                    if (!ConvertStringSidToSidW(capabilitySids[i], out capSid))
                    {
                        int ec = Marshal.GetLastWin32Error();
                        Marshal.FreeHGlobal(capArray);
                        DeleteProcThreadAttributeList(attrList);
                        Marshal.FreeHGlobal(attrList);
                        return "CAP-SID-FAIL[" + capabilitySids[i] + "] err=" + ec;
                    }
                    Marshal.WriteIntPtr(capArray, i * IntPtr.Size, capSid);
                }
                caps.Capabilities = capArray;
                caps.CapabilityCount = (uint)capCount;
            }

            int capsSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
            capsPtr = Marshal.AllocHGlobal(capsSize);
            Marshal.StructureToPtr(caps, capsPtr, false);

            bool updated = UpdateProcThreadAttribute(attrList, 0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capsPtr, (IntPtr)capsSize, IntPtr.Zero, IntPtr.Zero);
            if (!updated)
            {
                int e1 = Marshal.GetLastWin32Error();
                DeleteProcThreadAttributeList(attrList);
                Marshal.FreeHGlobal(capsPtr);
                Marshal.FreeHGlobal(attrList);
                return "UPDATE-ATTR-FAIL err=" + e1;
            }
        }

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        uint flags = CREATE_NO_WINDOW | (useAppContainer ? EXTENDED_STARTUPINFO_PRESENT : 0u);
        bool ok = CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero,
            false, flags, IntPtr.Zero, cwd, ref si, out pi);
        int createErr = Marshal.GetLastWin32Error();

        if (attrList != IntPtr.Zero) DeleteProcThreadAttributeList(attrList);
        if (capsPtr != IntPtr.Zero) Marshal.FreeHGlobal(capsPtr);
        if (attrList != IntPtr.Zero) Marshal.FreeHGlobal(attrList);

        if (!ok) return "CREATE-FAIL err=" + createErr;

        WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
        uint code = 0;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return "OK pid=" + pi.dwProcessId + " exit=" + code;
    }

    public static void Cleanup(string name)
    {
        try { DeleteAppContainerProfile(name); } catch { }
        if (_sid != IntPtr.Zero) { try { FreeSid(_sid); } catch { } _sid = IntPtr.Zero; }
    }
}
