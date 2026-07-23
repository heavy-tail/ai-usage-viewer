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
        private const int StdOutputHandle = -11;
        private const int StdErrorHandle = -12;
        private const uint FileTypePipe = 0x0003;
        private const uint SynchronizeProcess = 0x00100000;
        private const uint Infinite = 0xFFFFFFFF;
        private const uint GenericAll = 0x10000000;
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint HandleFlagInherit = 0x00000001;
        private const uint CreateNoWindow = 0x08000000;
        private const uint StartfUseShowWindow = 0x00000001;
        private const uint StartfUseStdHandles = 0x00000100;
        private const short SwHide = 0;
        private const int ExitUsage = 64;
        private const int ExitSetup = 70;
        private const int ExitLaunch = 71;
        private const uint LeaseClosedExitCode = 72;

        // This is deliberately the only live handle to the inner job. It is
        // non-inheritable and intentionally remains open until this process
        // exits, at which point KILL_ON_JOB_CLOSE terminates every descendant.
        private static IntPtr jobHandle = IntPtr.Zero;
        private static IntPtr ownerProcessHandle = IntPtr.Zero;
        // Hidden background launches inherit this desktop handle. Any window a
        // provider creates is therefore isolated from the user's input desktop
        // from process creation onward instead of being hidden after it flashes.
        private static IntPtr hiddenDesktopHandle = IntPtr.Zero;
        private static string hiddenDesktopName;
        private static int shutdownRequested;

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            public bool InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int Size;
            public string Reserved;
            public string Desktop;
            public string Title;
            public uint X;
            public uint Y;
            public uint XSize;
            public uint YSize;
            public uint XCountChars;
            public uint YCountChars;
            public uint FillAttribute;
            public uint Flags;
            public short ShowWindow;
            public short Reserved2Size;
            public IntPtr Reserved2;
            public IntPtr StandardInput;
            public IntPtr StandardOutput;
            public IntPtr StandardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process;
            public IntPtr Thread;
            public uint ProcessId;
            public uint ThreadId;
        }

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

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(
            IntPtr handle,
            uint milliseconds);

        [DllImport("kernel32.dll", EntryPoint = "CreateFileW",
            CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SecurityAttributes securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(
            IntPtr handle,
            uint mask,
            uint flags);

        [DllImport("kernel32.dll", EntryPoint = "CreateProcessW",
            CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(
            IntPtr process,
            out uint exitCode);

        [DllImport("user32.dll", EntryPoint = "CreateDesktopW",
            CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateDesktop(
            string desktop,
            string device,
            IntPtr deviceMode,
            uint flags,
            uint desiredAccess,
            ref SecurityAttributes securityAttributes);

        public static int Main(string[] args)
        {
            bool interactive = args != null && args.Length > 0 &&
                String.Equals(args[0], "--interactive", StringComparison.Ordinal);
            bool piped = args != null && args.Length > 0 &&
                String.Equals(args[0], "--pipe", StringComparison.Ordinal);
            bool hidden = args != null && args.Length > 0 &&
                String.Equals(args[0], "--hidden", StringComparison.Ordinal);
            bool ownerScoped = interactive || piped;
            int commandIndex = ownerScoped ? 2 : hidden ? 1 : 0;
            if (args == null || args.Length < commandIndex + 2)
            {
                return Fail("Usage Viewer job host received invalid arguments.", ExitUsage);
            }

            if (ownerScoped)
            {
                int ownerProcessId;
                if (!Int32.TryParse(args[1], out ownerProcessId) || ownerProcessId <= 0)
                {
                    return Fail("Usage Viewer job host owner is invalid.", ExitUsage);
                }
                ownerProcessHandle = OpenProcess(
                    SynchronizeProcess,
                    false,
                    ownerProcessId);
                if (ownerProcessHandle == IntPtr.Zero)
                {
                    return Fail("Usage Viewer job host owner is unavailable.", ExitSetup);
                }
            }

            string command;
            string workingDirectory;
            try
            {
                if (!Path.IsPathRooted(args[commandIndex]))
                {
                    return Fail("Usage Viewer job host requires an absolute command.", ExitUsage);
                }

                command = Path.GetFullPath(args[commandIndex]);
                workingDirectory = Path.GetFullPath(args[commandIndex + 1]);
                if (!File.Exists(command) || !Directory.Exists(workingDirectory))
                {
                    return Fail("Usage Viewer job host configuration is unavailable.", ExitUsage);
                }
            }
            catch
            {
                return Fail("Usage Viewer job host configuration is invalid.", ExitUsage);
            }

            // Stdin belongs to the Node parent, not AGY. Requiring a live pipe
            // prevents an accidentally detached invocation from starting AGY
            // without an owner capable of revoking the lease.
            if (!ownerScoped && !HasLiveParentLease())
            {
                return Fail("Usage Viewer job host requires a live parent lease.", ExitSetup);
            }

            if (hidden && !CreateHiddenDesktop())
            {
                return Fail(
                    "Usage Viewer job host could not establish an isolated desktop.",
                    ExitSetup);
            }

            if (!CreateAndJoinJob())
            {
                return Fail("Usage Viewer job host could not establish containment.", ExitSetup);
            }

            var leaseThread = new Thread(
                ownerScoped ? (ThreadStart)WatchOwnerProcess : WatchParentLease);
            leaseThread.IsBackground = true;
            leaseThread.Name = "usage-viewer-parent-lease";
            leaseThread.Start();

            try
            {
                if (hidden)
                {
                    return RunHiddenCommand(
                        command,
                        workingDirectory,
                        args,
                        commandIndex + 2);
                }

                var startInfo = new ProcessStartInfo();
                startInfo.FileName = command;
                startInfo.WorkingDirectory = workingDirectory;
                startInfo.Arguments = BuildArgumentString(args, commandIndex + 2);
                startInfo.UseShellExecute = false;
                // Interactive children must inherit the helper's ConPTY. The
                // CREATE_NO_WINDOW flag disconnects a child from that pseudo
                // console, so reserve it for the non-interactive AGY RPC path.
                startInfo.CreateNoWindow = !interactive;
                startInfo.WindowStyle = interactive
                    ? ProcessWindowStyle.Normal
                    : ProcessWindowStyle.Hidden;
                startInfo.ErrorDialog = false;

                // The helper's stdin remains the liveness lease. AGY receives a
                // separate redirected pipe which is closed immediately.
                startInfo.RedirectStandardInput = piped || !ownerScoped;
                startInfo.RedirectStandardOutput = piped;
                startInfo.RedirectStandardError = piped;

                using (var child = new Process())
                {
                    child.StartInfo = startInfo;
                    if (!child.Start())
                    {
                        return Fail("AGY job host could not start the command.", ExitLaunch);
                    }

                    Thread outputPump = null;
                    Thread errorPump = null;
                    if (piped)
                    {
                        StartPipePump(
                            Console.OpenStandardInput(),
                            child.StandardInput.BaseStream,
                            true,
                            "usage-viewer-pipe-input");
                        outputPump = StartPipePump(
                            child.StandardOutput.BaseStream,
                            Console.OpenStandardOutput(),
                            false,
                            "usage-viewer-pipe-output");
                        errorPump = StartPipePump(
                            child.StandardError.BaseStream,
                            Console.OpenStandardError(),
                            false,
                            "usage-viewer-pipe-error");
                    }
                    else if (!ownerScoped)
                    {
                        child.StandardInput.Close();
                    }
                    child.WaitForExit();
                    if (outputPump != null) outputPump.Join(1000);
                    if (errorPump != null) errorPump.Join(1000);
                    return child.ExitCode;
                }
            }
            catch
            {
                // Returning tears this process down. The sole job handle then
                // closes and Windows kills any partially launched descendants.
                return Fail("Usage Viewer job host command failed.", ExitLaunch);
            }
        }

        private static void WatchOwnerProcess()
        {
            try
            {
                WaitForSingleObject(ownerProcessHandle, Infinite);
            }
            catch
            {
                // Losing the owner watch must fail closed and revoke the job.
            }
            RevokeJobLease();
        }

        private static Thread StartPipePump(
            Stream source,
            Stream destination,
            bool closeDestination,
            string name)
        {
            var thread = new Thread(() =>
            {
                try
                {
                    // Anonymous Windows pipes can wait for the requested read
                    // size before completing. A one-byte pump keeps interactive
                    // newline protocols responsive before either side closes.
                    var buffer = new byte[1];
                    int count;
                    while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        destination.Write(buffer, 0, count);
                        destination.Flush();
                    }
                }
                catch
                {
                    // EOF, process exit, and job revocation can all close a
                    // pipe concurrently. The process result remains decisive.
                }
                finally
                {
                    if (closeDestination)
                    {
                        try
                        {
                            destination.Close();
                        }
                        catch
                        {
                            // The child may have already closed its input.
                        }
                    }
                }
            });
            thread.IsBackground = true;
            thread.Name = name;
            thread.Start();
            return thread;
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

        private static bool CreateHiddenDesktop()
        {
            var security = new SecurityAttributes();
            security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            security.SecurityDescriptor = IntPtr.Zero;
            security.InheritHandle = false;
            hiddenDesktopName = "UsageViewer-" + Process.GetCurrentProcess().Id +
                "-" + Guid.NewGuid().ToString("N");
            hiddenDesktopHandle = CreateDesktop(
                hiddenDesktopName,
                null,
                IntPtr.Zero,
                0,
                GenericAll,
                ref security);
            return hiddenDesktopHandle != IntPtr.Zero;
        }

        private static int RunHiddenCommand(
            string command,
            string workingDirectory,
            string[] args,
            int argumentStart)
        {
            IntPtr nullInput = IntPtr.Zero;
            var processInformation = new ProcessInformation();
            try
            {
                var inheritable = new SecurityAttributes();
                inheritable.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                inheritable.SecurityDescriptor = IntPtr.Zero;
                inheritable.InheritHandle = true;
                nullInput = CreateFile(
                    "NUL",
                    GenericRead,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    OpenExisting,
                    FileAttributeNormal,
                    IntPtr.Zero);
                IntPtr standardOutput = GetStdHandle(StdOutputHandle);
                IntPtr standardError = GetStdHandle(StdErrorHandle);
                if (nullInput == new IntPtr(-1) ||
                    standardOutput == IntPtr.Zero ||
                    standardOutput == new IntPtr(-1) ||
                    standardError == IntPtr.Zero ||
                    standardError == new IntPtr(-1) ||
                    !SetHandleInformation(
                        standardOutput,
                        HandleFlagInherit,
                        HandleFlagInherit) ||
                    !SetHandleInformation(
                        standardError,
                        HandleFlagInherit,
                        HandleFlagInherit))
                {
                    throw new InvalidOperationException(
                        "Hidden command standard handles are unavailable.");
                }

                var startupInfo = new StartupInfo();
                startupInfo.Size = Marshal.SizeOf(typeof(StartupInfo));
                startupInfo.Desktop = hiddenDesktopName;
                startupInfo.Flags = StartfUseShowWindow | StartfUseStdHandles;
                startupInfo.ShowWindow = SwHide;
                startupInfo.StandardInput = nullInput;
                startupInfo.StandardOutput = standardOutput;
                startupInfo.StandardError = standardError;
                var commandLine = new StringBuilder();
                commandLine.Append(QuoteWindowsArgument(command));
                string arguments = BuildArgumentString(args, argumentStart);
                if (arguments.Length > 0)
                {
                    commandLine.Append(' ');
                    commandLine.Append(arguments);
                }

                if (!CreateProcess(
                        command,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        CreateNoWindow,
                        IntPtr.Zero,
                        workingDirectory,
                        ref startupInfo,
                        out processInformation))
                {
                    throw new InvalidOperationException(
                        "Hidden provider process creation failed.");
                }
                CloseHandle(processInformation.Thread);
                processInformation.Thread = IntPtr.Zero;
                if (WaitForSingleObject(processInformation.Process, Infinite) ==
                    0xFFFFFFFF)
                {
                    throw new InvalidOperationException(
                        "Hidden provider process wait failed.");
                }
                uint exitCode;
                if (!GetExitCodeProcess(processInformation.Process, out exitCode))
                {
                    throw new InvalidOperationException(
                        "Hidden provider exit status is unavailable.");
                }
                return unchecked((int)exitCode);
            }
            finally
            {
                if (processInformation.Thread != IntPtr.Zero)
                {
                    CloseHandle(processInformation.Thread);
                }
                if (processInformation.Process != IntPtr.Zero)
                {
                    CloseHandle(processInformation.Process);
                }
                if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1))
                {
                    CloseHandle(nullInput);
                }
            }
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

            RevokeJobLease();
        }

        private static void RevokeJobLease()
        {
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
