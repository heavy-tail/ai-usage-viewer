using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace UsageViewer
{
    internal static class AgyJobHost
    {
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;
        private const int StdInputHandle = -10;
        private const uint FileTypePipe = 0x0003;
        private const int ExitUsage = 64;
        private const int ExitSetup = 70;
        private const int ExitLaunch = 71;
        private const uint LeaseClosedExitCode = 72;

        // This is deliberately the only live handle to the inner job. It is
        // non-inheritable and intentionally remains open until this process
        // exits, at which point KILL_ON_JOB_CLOSE terminates every descendant.
        private static IntPtr jobHandle = IntPtr.Zero;
        private static int shutdownRequested;

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW",
            CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(
            IntPtr jobAttributes,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            ref ExtendedLimitInformation information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(
            IntPtr job,
            IntPtr process);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(
            IntPtr job,
            uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll")]
        private static extern uint GetFileType(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PeekNamedPipe(
            IntPtr pipe,
            IntPtr buffer,
            uint bufferSize,
            IntPtr bytesRead,
            IntPtr bytesAvailable,
            IntPtr bytesLeftThisMessage);

        public static int Main(string[] args)
        {
            if (args == null || args.Length < 2)
            {
                return Fail("AGY job host received invalid arguments.", ExitUsage);
            }

            string command;
            string workingDirectory;
            try
            {
                if (!Path.IsPathRooted(args[0]))
                {
                    return Fail("AGY job host requires an absolute command.", ExitUsage);
                }

                command = Path.GetFullPath(args[0]);
                workingDirectory = Path.GetFullPath(args[1]);
                if (!File.Exists(command) || !Directory.Exists(workingDirectory))
                {
                    return Fail("AGY job host configuration is unavailable.", ExitUsage);
                }
            }
            catch
            {
                return Fail("AGY job host configuration is invalid.", ExitUsage);
            }

            // Stdin belongs to the Node parent, not AGY. Requiring a live pipe
            // prevents an accidentally detached invocation from starting AGY
            // without an owner capable of revoking the lease.
            if (!HasLiveParentLease())
            {
                return Fail("AGY job host requires a live parent lease.", ExitSetup);
            }

            if (!CreateAndJoinJob())
            {
                return Fail("AGY job host could not establish containment.", ExitSetup);
            }

            var leaseThread = new Thread(WatchParentLease);
            leaseThread.IsBackground = true;
            leaseThread.Name = "usage-viewer-parent-lease";
            leaseThread.Start();

            try
            {
                var startInfo = new ProcessStartInfo();
                startInfo.FileName = command;
                startInfo.WorkingDirectory = workingDirectory;
                startInfo.Arguments = BuildArgumentString(args, 2);
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.ErrorDialog = false;

                // The helper's stdin remains the liveness lease. AGY receives a
                // separate redirected pipe which is closed immediately.
                startInfo.RedirectStandardInput = true;
                startInfo.RedirectStandardOutput = false;
                startInfo.RedirectStandardError = false;

                using (var child = new Process())
                {
                    child.StartInfo = startInfo;
                    if (!child.Start())
                    {
                        return Fail("AGY job host could not start the command.", ExitLaunch);
                    }

                    child.StandardInput.Close();
                    child.WaitForExit();
                    return child.ExitCode;
                }
            }
            catch
            {
                // Returning tears this process down. The sole job handle then
                // closes and Windows kills any partially launched descendants.
                return Fail("AGY job host command failed.", ExitLaunch);
            }
        }

        private static bool HasLiveParentLease()
        {
            IntPtr input = GetStdHandle(StdInputHandle);
            if (input == IntPtr.Zero || input == new IntPtr(-1))
            {
                return false;
            }

            if (GetFileType(input) != FileTypePipe)
            {
                return false;
            }

            // A zero-byte peek is non-blocking. It succeeds while the parent's
            // write end is live and fails after that end has already closed.
            return PeekNamedPipe(
                input,
                IntPtr.Zero,
                0,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero);
        }

        private static bool CreateAndJoinJob()
        {
            IntPtr candidate = CreateJobObject(IntPtr.Zero, null);
            if (candidate == IntPtr.Zero)
            {
                return false;
            }

            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags =
                JobObjectLimitKillOnJobClose;

            uint size = checked((uint)Marshal.SizeOf(
                typeof(ExtendedLimitInformation)));
            if (!SetInformationJobObject(
                    candidate,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    size))
            {
                CloseHandle(candidate);
                return false;
            }

            // The helper joins before Process.Start. Normal CreateProcess
            // descendants therefore inherit this immediate no-breakaway job at
            // creation time; there is no post-spawn PID or assignment race.
            if (!AssignProcessToJobObject(candidate, GetCurrentProcess()))
            {
                CloseHandle(candidate);
                return false;
            }

            jobHandle = candidate;
            return true;
        }

        private static void WatchParentLease()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                var buffer = new byte[1];
                while (input.Read(buffer, 0, buffer.Length) > 0)
                {
                    // The channel carries no commands. Any bytes are ignored;
                    // only EOF revokes the lease.
                }
            }
            catch
            {
                // A broken or unreadable lease is equivalent to parent exit.
            }

            if (Interlocked.Exchange(ref shutdownRequested, 1) != 0)
            {
                return;
            }

            IntPtr activeJob = jobHandle;
            if (activeJob != IntPtr.Zero)
            {
                // This job includes the helper itself, so success normally ends
                // this process inside the call. If termination is denied, the
                // fallback process exit closes the sole job handle instead.
                TerminateJobObject(activeJob, LeaseClosedExitCode);
            }

            Environment.Exit(checked((int)LeaseClosedExitCode));
        }

        private static string BuildArgumentString(string[] args, int start)
        {
            var commandLine = new StringBuilder();
            for (int index = start; index < args.Length; index++)
            {
                if (commandLine.Length > 0)
                {
                    commandLine.Append(' ');
                }
                commandLine.Append(QuoteWindowsArgument(args[index]));
            }
            return commandLine.ToString();
        }

        private static string QuoteWindowsArgument(string argument)
        {
            if (argument == null)
            {
                argument = String.Empty;
            }

            bool needsQuotes = argument.Length == 0;
            for (int index = 0; index < argument.Length && !needsQuotes; index++)
            {
                char value = argument[index];
                needsQuotes = Char.IsWhiteSpace(value) || value == '"';
            }
            if (!needsQuotes)
            {
                return argument;
            }

            var quoted = new StringBuilder(argument.Length + 2);
            quoted.Append('"');
            int backslashes = 0;
            for (int index = 0; index < argument.Length; index++)
            {
                char value = argument[index];
                if (value == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (value == '"')
                {
                    AppendBackslashes(quoted, checked(backslashes * 2 + 1));
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }

                AppendBackslashes(quoted, backslashes);
                backslashes = 0;
                quoted.Append(value);
            }

            // Backslashes immediately before the closing quote must be doubled
            // so the Windows argv parser does not escape that quote.
            AppendBackslashes(quoted, checked(backslashes * 2));
            quoted.Append('"');
            return quoted.ToString();
        }

        private static void AppendBackslashes(StringBuilder target, int count)
        {
            for (int index = 0; index < count; index++)
            {
                target.Append('\\');
            }
        }

        private static int Fail(string message, int exitCode)
        {
            try
            {
                Console.Error.WriteLine(message);
            }
            catch
            {
                // Error reporting must never replace the controlled exit path.
            }
            return exitCode;
        }
    }
}
