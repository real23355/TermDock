using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Launcher
{
    private const string AppId = "TermDock.Desktop";
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    private static void Main(string[] args)
    {
        SetCurrentProcessExplicitAppUserModelID(AppId);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 1 && args[0] == "--register-start-menu")
        {
            try
            {
                StartMenuShortcut.Register(Application.ExecutablePath, AppId);
                MessageBox.Show("已创建 TermDock 开始菜单快捷方式。", "TermDock");
            }
            catch (Exception error) { MessageBox.Show(error.Message, "TermDock", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            return;
        }
        string profile = Environment.GetEnvironmentVariable("TERMDOCK_DATA_DIR");
        string dataFolder = string.IsNullOrWhiteSpace(profile)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TermDock")
            : Path.GetFullPath(profile);
        string cacheFolder = string.IsNullOrWhiteSpace(profile)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TermDock")
            : Path.Combine(dataFolder, "cache");
        string profileKey;
        using (var sha = SHA256.Create())
            profileKey = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(dataFolder.ToUpperInvariant()))).Replace("-", "");
        bool first;
        using (var mutex = new Mutex(true, @"Local\TermDock.WebView2." + profileKey, out first))
        {
            if (!first) return;
            Application.Run(new TerminalWindow(dataFolder, cacheFolder));
            mutex.ReleaseMutex();
        }
    }
}

internal sealed class TerminalWindow : Form
{
    private const string Page = "https://termdock.local/index.html";
    private readonly string appFolder = AppDomain.CurrentDomain.BaseDirectory;
    private readonly string dataFolder;
    private readonly string cacheFolder;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(16, 19, 25) };
    private readonly BlockingCollection<string> toWorker = new BlockingCollection<string>();
    private readonly HashSet<int> logRequests = new HashSet<int>();
    private Process worker;
    private Task startup;
    private string workerError;
    private bool closing;
    private bool closed;

    public TerminalWindow(string dataFolder, string cacheFolder)
    {
        this.dataFolder = dataFolder;
        this.cacheFolder = cacheFolder;
        Text = "TermDock";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(1360, 860);
        MinimumSize = new Size(850, 540);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(16, 19, 25);
        Controls.Add(view);
        Shown += (sender, args) => { startup = StartAsync(); };
        FormClosing += CloseAsync;
    }

    private async Task StartAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(cacheFolder, "WebView2"));
            if (closing) return;
            await view.EnsureCoreWebView2Async(environment);
            if (closing) return;
            var core = view.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping("termdock.local", Path.Combine(appFolder, "ui"), CoreWebView2HostResourceAccessKind.Deny);
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.NavigationStarting += (sender, args) => { args.Cancel = args.Uri != Page; };
            core.FrameNavigationStarting += (sender, args) => { args.Cancel = true; };
            core.NewWindowRequested += (sender, args) => { args.Handled = true; };
            core.PermissionRequested += (sender, args) => { args.State = CoreWebView2PermissionState.Deny; };
            core.DownloadStarting += (sender, args) => { args.Cancel = true; };
            core.WebMessageReceived += OnWebMessage;
            var runtime = await Task.Run(() => PrepareRuntime());
            if (closing) return;
            StartWorker(runtime);
            core.Navigate(Page);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (closing) return;
            var answer = MessageBox.Show(this, "此电脑缺少 Microsoft Edge WebView2 Runtime。是否打开微软下载页面？",
                "TermDock", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (answer == DialogResult.Yes) Process.Start("https://developer.microsoft.com/microsoft-edge/webview2/#download");
            BeginInvoke(new Action(Close));
        }
        catch (Exception error)
        {
            if (closing) return;
            MessageBox.Show(this, error.Message, "TermDock 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            BeginInvoke(new Action(Close));
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.TrimEnd(Path.DirectorySeparatorChar) + "\"";
    }

    private static bool MatchesHash(string path, string expected)
    {
        if (!File.Exists(path)) return false;
        using (var stream = File.OpenRead(path))
        using (var sha = SHA256.Create())
        {
            return string.Equals(BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", ""), expected, StringComparison.OrdinalIgnoreCase);
        }
    }

    private string PrepareRuntime()
    {
        string hash = File.ReadAllText(Path.Combine(appFolder, "runtime.sha256")).Trim();
        if (hash.Length != 64 || !System.Text.RegularExpressions.Regex.IsMatch(hash, "\\A[0-9a-fA-F]{64}\\z"))
            throw new InvalidDataException("后台运行时校验文件无效");
        string root = Path.Combine(cacheFolder, "runtime");
        string directory = Path.Combine(root, hash.ToLowerInvariant());
        string executable = Path.Combine(directory, "node.exe");
        if (MatchesHash(executable, hash)) return executable;
        Directory.CreateDirectory(directory);
        string staging = Path.Combine(root, Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(staging);
        try
        {
            var tarPath = Path.Combine(Environment.SystemDirectory, "tar.exe");
            var archive = Path.Combine(appFolder, "runtime.7z");
            using (var tar = Process.Start(new ProcessStartInfo(tarPath, "-xf " + Quote(archive) + " -C " + Quote(staging))
            {
                CreateNoWindow = true,
                UseShellExecute = false
            }))
            {
                tar.WaitForExit();
                if (tar.ExitCode != 0) throw new IOException("无法解压后台运行时");
            }
            var extracted = Path.Combine(staging, "node.exe");
            if (!MatchesHash(extracted, hash)) throw new InvalidDataException("后台运行时校验失败");
            if (File.Exists(executable)) File.Replace(extracted, executable, null);
            else File.Move(extracted, executable);
            return executable;
        }
        finally { Directory.Delete(staging, true); }
    }

    private void StartWorker(string executable)
    {
        var info = new ProcessStartInfo(executable, Quote(Path.Combine(appFolder, "backend", "worker.cjs")) + " " + Quote(dataFolder))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            WorkingDirectory = appFolder
        };
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        info.EnvironmentVariables.Remove("NODE_PATH");
        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (sender, args) =>
        {
            if (args.Data != null) PostToUi(() => OnWorkerReply(args.Data));
        };
        process.ErrorDataReceived += (sender, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data) && workerError == null) workerError = args.Data;
        };
        process.Exited += (sender, args) =>
        {
            PostToUi(() => Post(new { kind = "closed", error = workerError ?? "TermDock 后台已退出" }));
        };
        process.Start();
        worker = process;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        Task.Run(() =>
        {
            try
            {
                using (var writer = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    foreach (var line in toWorker.GetConsumingEnumerable()) writer.WriteLine(line);
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        });
    }

    private void PostToUi(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(action); }
        catch (InvalidOperationException) { }
    }

    private void Post(object packet)
    {
        if (!closing && view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsJson(json.Serialize(packet));
    }

    private void Reply(int id, object value) { Post(new { kind = "reply", id = id, ok = true, value = value }); }
    private void Reject(int id, string error) { Post(new { kind = "reply", id = id, ok = false, error = error }); }

    private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (closing || args.Source != Page || args.WebMessageAsJson.Length > json.MaxJsonLength) return;
        int id = 0;
        try
        {
            var packet = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson);
            string kind = packet["kind"] as string;
            if (kind == "notify")
            {
                if (worker != null && !worker.HasExited) toWorker.Add(args.WebMessageAsJson);
                return;
            }
            if (kind != "request") return;
            id = (int)packet["id"];
            string name = packet["name"] as string;
            switch (name)
            {
                case "dropped-paths":
                    var files = args.AdditionalObjects.Select(item =>
                        item is CoreWebView2File ? ((CoreWebView2File)item).Path :
                        item is FileInfo ? ((FileInfo)item).FullName : null).Where(path => path != null).ToArray();
                    Reply(id, files);
                    return;
                case "copy":
                    var values = (System.Collections.IList)packet["args"];
                    var text = values[0] as string;
                    if (text == null || text.Length > 4 * 1024 * 1024) throw new ArgumentException("剪贴板文本无效");
                    if (text.Length > 0) Clipboard.SetText(text);
                    else Clipboard.Clear();
                    Reply(id, null);
                    return;
                case "paste":
                    string pasted = Clipboard.GetText();
                    Reply(id, pasted.Substring(0, Math.Min(pasted.Length, 512 * 1024)));
                    return;
                case "pick-key":
                    using (var key = new OpenFileDialog { Title = "选择 SSH 私钥文件", CheckFileExists = true })
                        Reply(id, key.ShowDialog(this) == DialogResult.OK ? key.FileName : null);
                    return;
                case "pick-log-directory":
                    using (var folder = new FolderBrowserDialog { Description = "选择串口日志目录", ShowNewFolderButton = true })
                        Reply(id, folder.ShowDialog(this) == DialogResult.OK ? folder.SelectedPath : null);
                    return;
                case "pick-transfer-path":
                    var transferArgs = (System.Collections.IList)packet["args"];
                    if ((string)transferArgs[0] == "upload")
                    {
                        using (var file = new OpenFileDialog { Title = "选择上传文件", CheckFileExists = true })
                            Reply(id, file.ShowDialog(this) == DialogResult.OK ? file.FileName : null);
                    }
                    else if ((string)transferArgs[0] == "download")
                    {
                        using (var file = new SaveFileDialog { Title = "保存下载文件", OverwritePrompt = false })
                            Reply(id, file.ShowDialog(this) == DialogResult.OK ? file.FileName : null);
                    }
                    else throw new ArgumentException("文件选择操作无效");
                    return;
            }
            if (worker == null || worker.HasExited) throw new IOException(workerError ?? "TermDock 后台已退出");
            if (name == "show-logs") logRequests.Add(id);
            toWorker.Add(args.WebMessageAsJson);
        }
        catch (Exception error) { if (id > 0) Reject(id, error.Message); }
    }

    private void OnWorkerReply(string line)
    {
        if (closing || view.CoreWebView2 == null) return;
        if (logRequests.Count > 0 && line.StartsWith("{\"kind\":\"reply\",", StringComparison.Ordinal))
        {
            var packet = json.Deserialize<Dictionary<string, object>>(line);
            int id = (int)packet["id"];
            if (logRequests.Remove(id) && (bool)packet["ok"])
            {
                try
                {
                    Process.Start(new ProcessStartInfo((string)packet["value"]) { UseShellExecute = true });
                    Reply(id, null);
                }
                catch (Exception error) { Reject(id, error.Message); }
                return;
            }
        }
        view.CoreWebView2.PostWebMessageAsJson(line);
    }

    private async void CloseAsync(object sender, FormClosingEventArgs args)
    {
        if (closed) return;
        args.Cancel = true;
        if (closing) return;
        closing = true;
        if (startup != null) await startup;
        if (worker != null && !worker.HasExited) toWorker.Add("{\"kind\":\"quit\"}");
        toWorker.CompleteAdding();
        if (worker != null)
        {
            await Task.Run(() =>
            {
                if (!worker.WaitForExit(10000)) worker.Kill();
                worker.WaitForExit();
                worker.Dispose();
            });
        }
        closed = true;
        Close();
    }
}
