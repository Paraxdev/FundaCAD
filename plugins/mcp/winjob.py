"""Making sure the geometry engine dies with us, on Windows.

The sidecar already handles this everywhere it can: Linux sets PR_SET_PDEATHSIG,
macOS polls getppid(), and its own docstring says Windows "is covered by the
Rust-side Job Object (KILL_ON_JOB_CLOSE)". That is true of the APP. It is not
true of anything else that spawns a sidecar, and this server is the second such
thing.

Without a job object the leak is real and it compounds. Each session spawns a
sidecar, which spawns a ProcessPoolExecutor worker holding a loaded OCCT. An MCP
host kills its servers with TerminateProcess, which runs no cleanup, so the
sidecar never reaps its pool; and terminating the sidecar leaves the worker
orphaned in turn. Measured while driving the server from a script: 53 python
processes left behind, at which point a fresh sidecar could no longer start its
own worker and every build failed with "the geometry engine could not start on
this computer" — an error about the machine, from a machine that was fine an
hour earlier.

A job object with KILL_ON_JOB_CLOSE fixes both ends at once. The handle is held
by this process; when this process dies, however it dies, Windows closes the
handle and kills everything in the job.

A no-op on every other platform, where the sidecar's own two mechanisms already
cover it.
"""

import sys

#: JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation
_EXTENDED_LIMIT_INFORMATION = 9
#: JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags
_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000


class ProcessJob:
    """A Windows job object that kills its members when this process exits.

    Every method is safe to call on any platform and on a machine where the
    calls fail: this is a cleanup guarantee, and failing to obtain one must
    never stop the server from running. `available` says whether it was
    actually obtained, so a caller can log the difference rather than assume."""

    def __init__(self):
        self._handle = None
        self._kernel32 = None
        if sys.platform != "win32":
            return
        try:
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)

            class IO_COUNTERS(ctypes.Structure):
                _fields_ = [("ReadOperationCount", ctypes.c_ulonglong),
                            ("WriteOperationCount", ctypes.c_ulonglong),
                            ("OtherOperationCount", ctypes.c_ulonglong),
                            ("ReadTransferCount", ctypes.c_ulonglong),
                            ("WriteTransferCount", ctypes.c_ulonglong),
                            ("OtherTransferCount", ctypes.c_ulonglong)]

            class BASIC_LIMIT(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                            ("PerJobUserTimeLimit", ctypes.c_longlong),
                            ("LimitFlags", wintypes.DWORD),
                            ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t),
                            ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
                            ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]

            class EXTENDED_LIMIT(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", BASIC_LIMIT),
                            ("IoInfo", IO_COUNTERS),
                            ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t),
                            ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]

            handle = k32.CreateJobObjectW(None, None)
            if not handle:
                return
            info = EXTENDED_LIMIT()
            info.BasicLimitInformation.LimitFlags = _LIMIT_KILL_ON_JOB_CLOSE
            ok = k32.SetInformationJobObject(
                handle, _EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(info), ctypes.sizeof(info))
            if not ok:
                k32.CloseHandle(handle)
                return
            self._handle = handle
            self._kernel32 = k32
        except Exception:
            self._handle = None
            self._kernel32 = None

    @property
    def available(self):
        return self._handle is not None

    def adopt(self, pid):
        """Put a process in the job. True if it is now covered.

        A process already in another job that does not allow nesting is refused
        by Windows, which is why this reports rather than raises: the server
        still works, it just has to fall back to killing the tree by hand."""
        if self._handle is None or not pid:
            return False
        try:
            import ctypes

            PROCESS_SET_QUOTA = 0x0100
            PROCESS_TERMINATE = 0x0001
            proc = self._kernel32.OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, int(pid))
            if not proc:
                return False
            try:
                return bool(self._kernel32.AssignProcessToJobObject(self._handle, proc))
            finally:
                self._kernel32.CloseHandle(proc)
        except Exception:
            return False

    def close(self):
        """Close the handle, which kills everything in the job."""
        if self._handle is None:
            return
        try:
            self._kernel32.CloseHandle(self._handle)
        except Exception:
            pass
        self._handle = None


def kill_tree(pid):
    """Kill a process and its children, for the case where no job could be had.

    taskkill rather than an enumeration of our own: the child here is a Python
    process whose own children are a multiprocessing pool, and walking that
    tree correctly is exactly what taskkill /T already does."""
    if sys.platform != "win32" or not pid:
        return False
    import subprocess

    try:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(int(pid))],
                       capture_output=True, timeout=30)
        return True
    except Exception:
        return False
