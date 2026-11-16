using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class LocalPty
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const int PseudoConsoleAttribute = 0x00020016;
    private const uint Infinite = 0xffffffff;
    private const uint WaitFailed = 0xffffffff;
    private const uint MaxInputBytes = 4 * 1024 * 1024;
    private const int StandardInput = -10, StandardOutput = -11, StandardError = -12;

    private static int Main(string[] args)
    {
        using (var errors = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
        {
            errors.AutoFlush = true;
            try
            {
                if (args.Length != 5) throw new ArgumentException("LocalPty requires columns, rows, shell, directory and module path policy");
                short columns = short.Parse(args[0]);
                short rows = short.Parse(args[1]);
                return Run(new Coord(columns, rows), args[2], args[3], bool.Parse(args[4]), errors);
            }
            catch (EntryPointNotFoundException)
            {
                errors.WriteLine("ConPTY requires Windows 10 version 1809 or later");
            }
            catch (Exception error)
            {
                errors.WriteLine(error.Message);
            }
            return 1;
        }
    }

    private static int Run(Coord size, string shell, string directory, bool keepModulePath, TextWriter errors)
    {
        SafeFileHandle inputRead = null, inputWrite = null, outputRead = null, outputWrite = null;
        IntPtr console = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        Thread outputThread = null;
        FileStream terminalInput = null, terminalOutput = null;
        Exception inputError = null;
        var consoleLock = new object();
        var stopping = new ManualResetEvent(false);

        try
        {
            // Capture the parent's IPC pipes before creating the pseudoconsole or
            // starting its client. Console.OpenStandardInput looks up the current
            // standard handle each time it is called.
            var commandInput = Console.OpenStandardInput();
            var commandOutput = Console.OpenStandardOutput();
            // Give the client its console handles instead of the helper's
            // redirected standard handles. The helper still owns these pipes.
            ClearStandardHandle(StandardInput);
            ClearStandardHandle(StandardOutput);
            ClearStandardHandle(StandardError);
            if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
            if (!CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
            CheckConsoleResult(CreatePseudoConsole(size, inputRead, outputWrite, 0, out console));
            terminalInput = new FileStream(inputWrite, FileAccess.Write);
            terminalOutput = new FileStream(outputRead, FileAccess.Read);

            // Keep the output pipe draining during ClosePseudoConsole on older Windows releases.
            outputThread = new Thread(() =>
            {
                try { CopyOutput(terminalOutput, commandOutput, stopping); }
                catch (IOException) { }
                finally { stopping.Set(); }
            });
            outputThread.IsBackground = true;
            outputThread.Start();

            process = StartShell(console, shell, directory, keepModulePath);
            inputRead.Dispose();
            outputWrite.Dispose();
            errors.WriteLine("READY");

            var inputThread = new Thread(() =>
            {
                try
                {
                    ReadCommands(commandInput, terminalInput, nextSize =>
                    {
                        lock (consoleLock)
                        {
                            if (console != IntPtr.Zero) CheckConsoleResult(ResizePseudoConsole(console, nextSize));
                        }
                    });
                }
                catch (EndOfStreamException) { }
                catch (IOException error) { inputError = error; }
                catch (Exception error) { inputError = error; }
                finally { stopping.Set(); }
            });
            inputThread.IsBackground = true;
            inputThread.Start();

            var handles = new[] { process, stopping.SafeWaitHandle.DangerousGetHandle() };
            if (WaitForMultipleObjects(2, handles, false, Infinite) == WaitFailed) throw new Win32Exception();
            if (inputError != null) throw inputError;
            uint exitCode;
            if (WaitForSingleObject(process, 0) == 0)
            {
                if (!GetExitCodeProcess(process, out exitCode)) throw new Win32Exception();
                return unchecked((int)exitCode);
            }
            return 0;
        }
        finally
        {
            if (inputRead != null) inputRead.Dispose();
            if (outputWrite != null) outputWrite.Dispose();
            // If no reader was started, closing the pipe first also prevents a shutdown wait.
            if (outputThread == null && outputRead != null) outputRead.Dispose();
            lock (consoleLock)
            {
                if (console != IntPtr.Zero)
                {
                    ClosePseudoConsole(console);
                    console = IntPtr.Zero;
                }
            }
            if (process != IntPtr.Zero)
            {
                if (WaitForSingleObject(process, 3000) != 0) TerminateProcess(process, 1);
                CloseHandle(process);
            }
            if (outputThread != null) outputThread.Join();
            if (terminalInput != null) terminalInput.Dispose();
            if (terminalOutput != null) terminalOutput.Dispose();
            if (inputWrite != null) inputWrite.Dispose();
            if (outputRead != null) outputRead.Dispose();
            // The background input thread may still be waiting on the parent's stdin.
        }
    }

    private static void CopyOutput(Stream input, Stream output, ManualResetEvent stopping)
    {
        var buffer = new byte[16384];
        bool forward = true;
        for (int read; (read = input.Read(buffer, 0, buffer.Length)) != 0;)
        {
            if (!forward) continue;
            try
            {
                output.Write(buffer, 0, read);
                output.Flush();
            }
            catch (IOException)
            {
                stopping.Set();
                forward = false;
            }
        }
    }

    private static void ReadCommands(Stream input, Stream terminal, Action<Coord> resize)
    {
        using (var reader = new BinaryReader(input))
        {
            var bytes = new byte[16384];
            while (true)
            {
                byte operation = reader.ReadByte();
                uint length = reader.ReadUInt32();
                switch (operation)
                {
                    case 1:
                        if (length > MaxInputBytes) throw new InvalidDataException("Local PTY input is too large");
                        while (length > 0)
                        {
                            int read = reader.Read(bytes, 0, (int)Math.Min(length, (uint)bytes.Length));
                            if (read == 0) throw new EndOfStreamException();
                            terminal.Write(bytes, 0, read);
                            length -= (uint)read;
                        }
                        terminal.Flush();
                        break;
                    case 2:
                        if (length != 4) throw new InvalidDataException("Invalid local PTY resize frame");
                        resize(new Coord(reader.ReadInt16(), reader.ReadInt16()));
                        break;
                    case 3:
                        if (length != 0) throw new InvalidDataException("Invalid local PTY close frame");
                        return;
                    default:
                        throw new InvalidDataException("Invalid local PTY operation");
                }
            }
        }
    }

    private static IntPtr StartShell(IntPtr console, string shell, string directory, bool keepModulePath)
    {
        IntPtr bytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
        if (bytes == IntPtr.Zero) throw new Win32Exception();
        IntPtr list = Marshal.AllocHGlobal(bytes);
        bool initialized = false;
        try
        {
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref bytes)) throw new Win32Exception();
            initialized = true;
            if (!UpdateProcThreadAttribute(list, 0, new IntPtr(PseudoConsoleAttribute), console,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

            var startup = new StartupInfoEx();
            startup.Info.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Attributes = list;
            var executable = ShellPath(shell);
            if (!File.Exists(executable)) throw new FileNotFoundException("Shell executable not found: " + executable);
            if (string.IsNullOrEmpty(directory)) directory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("Working directory not found: " + directory);
            var command = new StringBuilder("\"" + executable + "\"");
            if (shell == "cmd") command.Append(" /d");
            if (shell == "powershell" || shell == "pwsh") command.Append(" -NoLogo");
            if (shell == "powershell" && !keepModulePath)
            {
                // Discard PowerShell 7's inherited module path when launching Windows PowerShell.
                var userModules = Environment.GetEnvironmentVariable("PSModulePath", EnvironmentVariableTarget.User);
                var machineModules = Environment.GetEnvironmentVariable("PSModulePath", EnvironmentVariableTarget.Machine);
                Environment.SetEnvironmentVariable("PSModulePath", userModules ?? machineModules);
            }
            ProcessInformation process;
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfoPresent,
                IntPtr.Zero, directory, ref startup, out process)) throw new Win32Exception();
            CloseHandle(process.Thread);
            return process.Process;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(list);
        }
    }

    private static string ShellPath(string shell)
    {
        var system = Environment.SystemDirectory;
        switch (shell)
        {
            case "powershell": return Path.Combine(system, "WindowsPowerShell", "v1.0", "powershell.exe");
            case "cmd": return Path.Combine(system, "cmd.exe");
            case "wsl": return Path.Combine(system, "wsl.exe");
            case "pwsh":
                var standard = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PowerShell", "7", "pwsh.exe");
                if (File.Exists(standard)) return standard;
                foreach (var entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
                {
                    var folder = entry.Trim().Trim('"');
                    if (folder.Length < 3 || folder[1] != ':' || (folder[2] != '\\' && folder[2] != '/')) continue;
                    var candidate = Path.Combine(folder, "pwsh.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                return standard;
            default: throw new ArgumentException("Unknown local shell: " + shell);
        }
    }

    private static void CheckConsoleResult(int result)
    {
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    private static void ClearStandardHandle(int id)
    {
        if (!SetStdHandle(id, IntPtr.Zero)) throw new Win32Exception();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetStdHandle(int id, IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short Columns;
        public short Rows;

        public Coord(short columns, short rows)
        {
            if (columns <= 0 || rows <= 0) throw new ArgumentOutOfRangeException("size");
            Columns = columns;
            Rows = rows;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo Info;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, uint size);

    [DllImport("kernel32.dll")]
    private static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);

    [DllImport("kernel32.dll")]
    private static extern int ResizePseudoConsole(IntPtr console, Coord size);

    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr console);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr bytes, IntPtr previous, IntPtr returnBytes);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint timeout);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
