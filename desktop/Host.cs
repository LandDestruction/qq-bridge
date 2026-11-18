// Host.cs —— 桌面外壳：把桥接控制台的 /client 页面装进一个独立 exe。
//
// 形态：.NET Framework 4.8 + WinForms + WebView2。选它是因为本机只有 .NET 3.1 SDK
// （没有 net8 桌面运行时），而 csc.exe 4.8 能直接编出单文件 exe，不引入 MSBuild 依赖。
// 语言版本固定 C# 5（csc 4.8 的上限）：不要用字符串插值、?.、nameof、自动属性初始化器。
//
// 硬约束（都能在 scripts/test-desktop-host.mjs 里找到对应断言）：
//   1) 控制台令牌只在内存里拼 URL，绝不进标题、日志、异常文案（Scrub 会再擦一遍）；
//   2) 窗口不白屏：先显示骨架页，NavigationCompleted 成功后才露出 WebView；
//   3) 服务没起来就显示可读错误页（端口 + 错误码 + 重试）；壳会**托管**桥接进程（P0-2）：
//      启动/停止/重启/守护都在这里，但只动自己记录过 PID 的进程，绝不按镜像名杀 node；
//   4) 只写 <root>\\logs\\*（stdout/守护日志）与 %LOCALAPPDATA%\\<品牌>\\window.json，
//      不写 config.json / state（记忆库与令牌归桥接自己管）；
//   5) 开机自启是可选开关（默认关）：用户勾选才写 HKCU\\...\\Run，随时可取消。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QdbDesktop
{
    // ── 命令行 ────────────────────────────────────────────────────────────────
    internal sealed class Options
    {
        internal string Root;      // --root <dir>：仓库根（安装器写进快捷方式参数）
        internal string Url;       // --url <url>：调试用，直接给完整地址（绕过 root/令牌拼装）
        internal bool DevTools;    // --devtools：开 F12；默认关
        internal bool Quit;        // --quit：通知已运行实例退出（安装器/更新脚本用）
        internal bool Autostart;   // --autostart：Windows 登录拉起时直接进托盘，不弹窗
        internal bool CheckUpdate; // --check-update：只查一次更新源并退出（给脚本/联调用，不开窗口）

        // 未知参数一律忽略不报错：安装器的快捷方式常带 --no-sandbox 之类的历史开关。
        internal static Options Parse(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--root" && i + 1 < args.Length) { o.Root = args[++i]; }
                else if (a == "--url" && i + 1 < args.Length) { o.Url = args[++i]; }
                else if (a == "--devtools") { o.DevTools = true; }
                else if (a == "--quit") { o.Quit = true; }
                else if (a == "--autostart") { o.Autostart = true; }
                else if (a == "--check-update") { o.CheckUpdate = true; }
            }
            return o;
        }
    }

    // ── 路径与配置（只读） ─────────────────────────────────────────────────────
    internal sealed class AppPaths
    {
        internal const int DefaultConsolePort = 3100;

        internal readonly string Root;
        internal readonly string TokenPath;
        internal readonly string ConfigPath;
        internal readonly string WindowStatePath;
        internal readonly string WebViewDataDir;
        internal readonly string UpdateLogPath;

        internal AppPaths(string givenRoot)
        {
            Root = ResolveRoot(givenRoot);
            TokenPath = Path.Combine(Root, "state", "console-token");
            ConfigPath = Path.Combine(Root, "config.json");
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dataDir = Path.Combine(localAppData, Brand.AppDataDirName);
            // 便携/受控环境：某些机器（或杀软/受控账号）不允许往 %LOCALAPPDATA% 写，
            // 允许用 QQDESKTOP_DATA_DIR 指到可写目录；默认仍是 %LOCALAPPDATA%\<品牌>。
            string overrideDir = Environment.GetEnvironmentVariable("QQDESKTOP_DATA_DIR");
            if (!string.IsNullOrEmpty(overrideDir)) { dataDir = overrideDir; }
            WindowStatePath = Path.Combine(dataDir, "window.json");
            WebViewDataDir = Path.Combine(dataDir, "webview2");
            UpdateLogPath = Path.Combine(Root, "logs", "desktop-update.log");
        }

        // root 的取法：--root > 从 exe 目录往上找 src/bridge.js > exe 目录。
        // 开发时 exe 在 dist/desktop/，往上两级就是仓库根；安装后由安装器显式传 --root。
        private static string ResolveRoot(string givenRoot)
        {
            if (!string.IsNullOrEmpty(givenRoot))
            {
                try { return Path.GetFullPath(givenRoot); }
                catch (Exception) { return givenRoot; }
            }
            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            string probe = dir;
            for (int i = 0; i < 5 && !string.IsNullOrEmpty(probe); i++)
            {
                if (File.Exists(Path.Combine(probe, "src", "bridge.js"))) { return probe; }
                DirectoryInfo parent = Directory.GetParent(probe);
                probe = parent == null ? null : parent.FullName;
            }
            return dir;
        }

        // 端口只读 config.json 里的 consolePort（不写、不热加载、不改）。读失败就按默认 3100。
        // 刻意不引 JSON 库：只为取一个整数，正则足够，也省掉 System.Web.Extensions 依赖。
        internal int ResolvePort()
        {
            try
            {
                if (!File.Exists(ConfigPath)) { return DefaultConsolePort; }
                string text = File.ReadAllText(ConfigPath, Encoding.UTF8);
                Match m = Regex.Match(text, "\"consolePort\"\\s*:\\s*(\\d+)");
                if (m.Success)
                {
                    int port;
                    if (int.TryParse(m.Groups[1].Value, out port) && port > 0 && port < 65536) { return port; }
                }
            }
            catch (Exception) { /* 配置坏了不该让壳起不来，按默认端口继续 */ }
            return DefaultConsolePort;
        }

        // 面板常驻进程（console-host）的端口：console.hostPort，默认控制台端口 + 1。
        // 壳优先连它：桥接重启时页面不会跟着没，只会显示「机器人已下线」。
        internal int ResolveConsoleHostPort()
        {
            try
            {
                if (File.Exists(ConfigPath))
                {
                    string text = File.ReadAllText(ConfigPath, Encoding.UTF8);
                    Match m = Regex.Match(text, "\"hostPort\"\\s*:\\s*(\\d+)");
                    if (m.Success)
                    {
                        int port;
                        if (int.TryParse(m.Groups[1].Value, out port) && port > 0 && port < 65536) { return port; }
                    }
                }
            }
            catch (Exception) { /* 读坏就按默认 */ }
            return ResolvePort() + 1;
        }

        // 令牌只读一次，读不到返回 null（调用方显示错误页，而不是拼一个没令牌的地址白屏）。
        internal string ReadToken()
        {
            try
            {
                if (!File.Exists(TokenPath)) { return null; }
                string token = File.ReadAllText(TokenPath, Encoding.UTF8).Trim();
                return token.Length == 0 ? null : token;
            }
            catch (Exception) { return null; }
        }

        // 更新源：config.json 的 desktop.updateUrl。空 = 关闭检查（默认不发任何网络请求）。
        // 口径同 ResolvePort：只读、不写、不热加载；读坏就当没配，绝不让壳起不来。
        internal string ResolveUpdateUrl()
        {
            try
            {
                if (!File.Exists(ConfigPath)) { return ""; }
                string text = File.ReadAllText(ConfigPath, Encoding.UTF8);
                Match m = Regex.Match(text, "\"updateUrl\"\\s*:\\s*\"([^\"]*)\"");
                if (m.Success) { return m.Groups[1].Value.Trim(); }
            }
            catch (Exception) { /* 配置坏了 = 关闭更新检查 */ }
            return "";
        }

        // 当前版本：安装目录里 scripts/installer/version.txt（安装包按它命名，发布时一起升）
        // 优先；读不到退回 Brand.Version。更新检查只拿它和远端版本比。
        internal string CurrentVersion()
        {
            try
            {
                string p = Path.Combine(Root, "scripts", "installer", "version.txt");
                if (File.Exists(p))
                {
                    string v = File.ReadAllText(p, Encoding.UTF8).Trim();
                    if (v.Length > 0) { return v; }
                }
            }
            catch (Exception) { /* 读不到就退回编译期版本 */ }
            return Brand.Version;
        }
    }

    // ── 入口：单实例 + 激活 ────────────────────────────────────────────────────
    internal static class Program
    {
        // Local\ 前缀：同一登录会话内互斥即可，不跨用户（跨用户同时开两个壳也没危害）。
        private const string MutexName = "Local\\" + Brand.AppDataDirName + ".single-instance";
        internal const string ActivateEventName = "Local\\" + Brand.AppDataDirName + ".activate";
        // 安装器/更新脚本要能关掉正在运行的壳（否则替换 exe 会被占用）：
        // <Brand.ExeName> --quit 通知已运行实例走和托盘「退出」完全相同的 ExitApplication()。
        internal const string QuitEventName = "Local\\" + Brand.AppDataDirName + ".quit";

        [STAThread]
        private static void Main(string[] args)
        {
            Options opt = Options.Parse(args);

            // 联调/发布自检用：只读一次更新源、比对版本，写日志并用退出码回答，不创建窗口。
            // 0 = 已是最新，1 = 有更新，2 = 读不到更新源（未配置 / 网络错 / 清单不合法）。
            if (opt.CheckUpdate) { Environment.Exit(HostForm.RunUpdateCheck(opt)); return; }

            bool isFirstInstance;
            Mutex mutex = new Mutex(true, MutexName, out isFirstInstance);
            if (!isFirstInstance)
            {
                // 二次启动：--quit 让已有实例退出；否则叫醒已有窗口然后退出，绝不出现第二个托盘图标。
                if (opt.Quit) { SignalExistingInstance(QuitEventName); }
                else { SignalExistingInstance(ActivateEventName); }
                return;
            }

            HostForm.CleanWebView2(false); // 上次被强杀留下的 WebView2 树（宿主进程已不在）先收掉
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += OnThreadException;
            try
            {
                Application.Run(new HostForm(opt));
            }
            finally
            {
                // 持有 mutex 直到进程真正退出，避免退出过程中的二次启动开出第二个窗口。
                GC.KeepAlive(mutex);
            }
        }

        private static void SignalExistingInstance(string eventName)
        {
            try
            {
                using (EventWaitHandle handle = EventWaitHandle.OpenExisting(eventName))
                {
                    handle.Set();
                }
            }
            catch (Exception)
            {
                // 老窗口正好在退出（事件已销毁）：那这次启动本该失败，静默退出即可。
            }
        }

        // 兜底：未捕获异常只报类型与擦过的消息，绝不把带 token 的 URL 甩到对话框里。
        private static void OnThreadException(object sender, ThreadExceptionEventArgs e)
        {
            string message = e.Exception == null ? "未知错误" : Scrub(e.Exception.Message);
            MessageBox.Show(message, Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        // 把 token=... 之类的查询串从任何要显示/落盘的文本里擦掉。
        internal static string Scrub(string text)
        {
            if (string.IsNullOrEmpty(text)) { return text; }
            return Regex.Replace(text, "(token|access_token|console-token)=[^&\\s\"']+", "$1=<已隐去>", RegexOptions.IgnoreCase);
        }
    }

    // ── 桥接进程托管（P0-2）──────────────────────────────────────────────────
    // 为什么放在桌面壳里：安装器只在装完那一刻起一次桥接；用户重启电脑、桥接崩溃后
    // 就没人拉了，双击图标只会看到「桥接没有响应」。
    //   启动：优先 <root>\node.exe（没有就退回 PATH 的 node.exe）起 src\bridge.js，cwd=root，
    //         stdout/stderr 追加到 <root>\logs\bridge-stdout.log，不阻塞 UI；
    //   停止：只 taskkill 自己记录过的 PID（/T 连带它拉起的子进程），绝不按镜像名杀 node；
    //   守护：自己起的进程意外退出 → 5 秒后重拉，最多 3 次/小时，超限停手并写清原因；
    //   只写 <root>\logs\*（stdout/守护日志）；不写 config.json / state；
    //   令牌只在内存里拼 URL，绝不经 BridgeLog 落盘（测试有断言）。
    internal static class BridgeLog
    {
        // 只记 pid / 事件 / 退出码。调用方绝不把令牌传进来（Scrub 是第二道保险）。
        internal static void Write(string logPath, string text)
        {
            try
            {
                string dir = Path.GetDirectoryName(logPath);
                if (!string.IsNullOrEmpty(dir)) { Directory.CreateDirectory(dir); }
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + Program.Scrub(text) + Environment.NewLine;
                File.AppendAllText(logPath, line, new UTF8Encoding(false));
            }
            catch (Exception)
            {
                // 日志写不进不是故障（杀软锁文件/权限）：绝不能因此影响桥接启停。
            }
        }
    }

    // 开机自启：HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写一条
    // `"<exe>" --root "<root>"`。默认关，只有用户在托盘勾选或安装器完成页勾选/带 /autostart 才写。
    internal static class Autostart
    {
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        // 值名用品牌数据目录名：改名只需改 Brand.cs，注册表值名跟着走。
        internal static string ValueName
        {
            get { return Brand.AppDataDirName; }
        }

        internal static bool IsEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath))
                {
                    return key != null && key.GetValue(ValueName) != null;
                }
            }
            catch (Exception)
            {
                // 注册表读不了就当成没开：壳不写它，状态显示「未启用」。
                return false;
            }
        }

        internal static bool Set(bool enabled, string exePath, string root)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (key == null) { return false; }
                    if (enabled)
                    {
                        // 带 --autostart：登录拉起时直接进托盘，别把窗口怼到用户脸上。
                        string command = "\"" + exePath + "\" --root \"" + root + "\" --autostart";
                        key.SetValue(ValueName, command, RegistryValueKind.String);
                    }
                    else
                    {
                        key.DeleteValue(ValueName, false);
                    }
                }
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    // 只读探活 GET /api/status?token=<state\console-token>：200 且正文含 "mode" 即 API 就绪。
    // 令牌只在内存里拼 URL；失败原因不落盘（异常文案可能带 URL，交给 Scrub 只在 UI 显示）。
    // 面板常驻进程探活：GET /console-host/health 回 JSON 里带 "console-host" 就算在跑。
    internal static class ConsoleHostProbe
    {
        internal static bool IsUp(int port)
        {
            if (port <= 0) { return false; }
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/console-host/health");
                request.Proxy = null;
                request.Timeout = 1200;
                request.ReadWriteTimeout = 1200;
                request.KeepAlive = false;
                request.AllowAutoRedirect = false;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if ((int)response.StatusCode != 200) { return false; }
                    using (Stream stream = response.GetResponseStream())
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        return reader.ReadToEnd().IndexOf("\"console-host\"", StringComparison.Ordinal) >= 0;
                    }
                }
            }
            catch (Exception) { return false; }
        }
    }

    internal static class BridgeProbe
    {
        internal static bool IsReady(int port, string token)
        {
            if (port <= 0 || string.IsNullOrEmpty(token)) { return false; }
            try
            {
                string url = "http://127.0.0.1:" + port + "/api/status?token=" + Uri.EscapeDataString(token);
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Proxy = null;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.KeepAlive = false;
                request.AllowAutoRedirect = false;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if ((int)response.StatusCode != 200) { return false; }
                    using (Stream stream = response.GetResponseStream())
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        return body.IndexOf("\"mode\"", StringComparison.Ordinal) >= 0;
                    }
                }
            }
            catch (Exception)
            {
                // 还没起来 / 401 / 端口不通 —— 都算未就绪，由调用方决定重试节奏。
                return false;
            }
        }

        // 端口上有没有人在 listen。用来区分「还没起」和「别人占了 3100」——
        // 后者守护怎么重启都是 EADDRINUSE，只会白等 30 秒再报超时。
        internal static bool IsPortBusy(int port)
        {
            if (port <= 0) { return false; }
            try
            {
                using (System.Net.Sockets.TcpClient client = new System.Net.Sockets.TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(600)) { return false; }
                    client.EndConnect(ar);
                    return true;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    // 桥接进程的启停与守护。全部状态在 UI 线程读写（Tick/Start/Stop），仅首次启动的
    // 等待线程会调 IsRunning/Start，所以内部用 lock 兜住。
    internal sealed class BridgeGuard
    {
        internal const int RestartDelayMs = 5000;       // 意外退出后延迟多久重拉
        internal const int MaxAutoRestartsPerHour = 3;  // 超过就停手（防崩溃循环刷日志）
        internal const int ReadyTimeoutMs = 30000;      // 启动后等 /api/status 的上限
        internal const int GuardIntervalMs = 2000;      // UI 定时器周期

        private readonly AppPaths paths;
        private readonly object sync = new object();
        private readonly List<DateTime> autoRestarts = new List<DateTime>();
        private Process proc;
        private bool userStopped;
        private bool gaveUp;
        private DateTime pendingRestartAt = DateTime.MinValue;
        private string lastNote = "";

        internal BridgeGuard(AppPaths paths)
        {
            this.paths = paths;
        }

        internal string GuardLogPath
        {
            get { return Path.Combine(paths.Root, "logs", "bridge-guard.log"); }
        }

        internal string StdoutLogPath
        {
            get { return Path.Combine(paths.Root, "logs", "bridge-stdout.log"); }
        }

        internal bool IsRunning
        {
            get
            {
                lock (sync)
                {
                    return proc != null && !HasExitedSafe(proc);
                }
            }
        }

        internal int Pid
        {
            get
            {
                lock (sync)
                {
                    if (proc == null || HasExitedSafe(proc)) { return 0; }
                    try { return proc.Id; } catch (Exception) { return 0; }
                }
            }
        }

        internal bool UserStopped { get { lock (sync) { return userStopped; } } }
        internal bool GaveUp { get { lock (sync) { return gaveUp; } } }
        internal string LastNote { get { lock (sync) { return lastNote; } } }

        // 自带 node.exe 优先（安装目录内置）；没有就退回 PATH 的 node.exe（开发机）。
        private static string ResolveNode(AppPaths paths)
        {
            string bundled = Path.Combine(paths.Root, "node.exe");
            return File.Exists(bundled) ? bundled : "node.exe";
        }

        internal bool Start()
        {
            lock (sync)
            {
                if (proc != null && !HasExitedSafe(proc)) { return true; }
                string entry = Path.Combine(paths.Root, "src", "bridge.js");
                if (!File.Exists(entry))
                {
                    lastNote = "找不到入口 " + entry;
                    BridgeLog.Write(GuardLogPath, "start failed: entry missing " + entry);
                    return false;
                }
                string node = ResolveNode(paths);
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(StdoutLogPath));
                    // 用 cmd /c 把 node 的 stdout/stderr 直接重定向进文件：
                    // 壳退出后桥接继续跑，也不会因为父进程关掉管道而 EPIPE。
                    // 外层一对引号是 cmd 的规矩（命令以引号开头时必须再包一层）。
                    string args = "/c \"\"" + node + "\" \"" + entry + "\" >> \"" + StdoutLogPath + "\" 2>&1\"";
                    ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", args);
                    psi.WorkingDirectory = paths.Root;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process started = Process.Start(psi);
                    if (started == null)
                    {
                        lastNote = "Process.Start 返回空";
                        BridgeLog.Write(GuardLogPath, "start failed: Process.Start returned null");
                        return false;
                    }
                    proc = started;
                    userStopped = false;
                    gaveUp = false;
                    pendingRestartAt = DateTime.MinValue;
                    lastNote = "已启动（PID " + started.Id + "）";
                    BridgeLog.Write(GuardLogPath, "start pid=" + started.Id + " entry=src/bridge.js node=" + node);
                    return true;
                }
                catch (Exception ex)
                {
                    proc = null;
                    lastNote = "启动失败：" + Program.Scrub(ex.Message);
                    BridgeLog.Write(GuardLogPath, "start failed: " + ex.GetType().Name + " " + Program.Scrub(ex.Message));
                    return false;
                }
            }
        }

        // 只杀自己记录过的 PID：/T 连带它拉起的子进程（cmd 下的 node），绝不按镜像名杀 node。
        private static void KillTree(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process killer = Process.Start(psi))
                {
                    if (killer != null) { killer.WaitForExit(5000); }
                }
            }
            catch (Exception)
            {
                // 已经退出 / 没权限 / 找不到 taskkill：进程是否还在由 Tick 再确认。
            }
        }

        internal void Stop()
        {
            Process victim;
            int pid = 0;
            lock (sync)
            {
                userStopped = true;
                gaveUp = false;
                pendingRestartAt = DateTime.MinValue;
                victim = proc;
                proc = null;
                if (victim != null && !HasExitedSafe(victim))
                {
                    try { pid = victim.Id; } catch (Exception) { pid = 0; }
                }
            }
            if (pid > 0) { KillTree(pid); }
            if (victim != null) { try { victim.Dispose(); } catch (Exception) { } }
            if (pid > 0) { BridgeLog.Write(GuardLogPath, "stop pid=" + pid); }
            lock (sync) { lastNote = pid > 0 ? "已手动停止" : "已是停止状态"; }
        }

        internal bool Restart()
        {
            Stop();
            // 给 taskkill 一点时间释放 3100 端口，否则新进程会 EADDRINUSE。
            Thread.Sleep(300);
            return Start();
        }

        // UI 定时器每 GuardIntervalMs 调一次。返回 true 表示本次执行了「自动重拉」。
        internal bool Tick()
        {
            bool restarted;
            lock (sync)
            {
                if (userStopped || gaveUp) { return false; }
                if (proc != null)
                {
                    if (!HasExitedSafe(proc)) { pendingRestartAt = DateTime.MinValue; return false; }
                    int exitCode = 0;
                    try { exitCode = proc.ExitCode; } catch (Exception) { }
                    BridgeLog.Write(GuardLogPath, "exited pid=" + SafePid(proc) + " code=" + exitCode);
                    try { proc.Dispose(); } catch (Exception) { }
                    proc = null;
                    pendingRestartAt = DateTime.Now.AddMilliseconds(RestartDelayMs);
                    lastNote = "桥接退出了（退出码 " + exitCode + "），" + (RestartDelayMs / 1000) + " 秒后自动重拉";
                    return false;
                }
                if (pendingRestartAt == DateTime.MinValue || DateTime.Now < pendingRestartAt) { return false; }
                PruneAutoRestarts();
                if (autoRestarts.Count >= MaxAutoRestartsPerHour)
                {
                    gaveUp = true;
                    lastNote = "1 小时内已自动重拉 " + MaxAutoRestartsPerHour + " 次仍退出，停止自动拉起（见 logs\\bridge-guard.log）";
                    BridgeLog.Write(GuardLogPath, "watchdog gave up after " + autoRestarts.Count + " restarts in 1h");
                    return false;
                }
                autoRestarts.Add(DateTime.Now);
                pendingRestartAt = DateTime.MinValue;
                restarted = true;
            }
            if (restarted)
            {
                Start();
                BridgeLog.Write(GuardLogPath, "watchdog restart");
            }
            return restarted;
        }

        // 调用方必须已经持有 sync。
        private void PruneAutoRestarts()
        {
            DateTime cutoff = DateTime.Now.AddHours(-1);
            int drop = 0;
            while (drop < autoRestarts.Count && autoRestarts[drop] < cutoff) { drop++; }
            if (drop > 0) { autoRestarts.RemoveRange(0, drop); }
        }

        private static bool HasExitedSafe(Process p)
        {
            try { return p.HasExited; }
            catch (Exception) { return true; }
        }

        private static int SafePid(Process p)
        {
            try { return p.Id; } catch (Exception) { return 0; }
        }
    }

    // ── 主窗体 ────────────────────────────────────────────────────────────────
    internal sealed class HostForm : Form
    {
        private readonly Options opt;
        private readonly AppPaths paths;
        private readonly EventWaitHandle activateEvent;
        private EventWaitHandle quitEvent;
        private readonly Thread activateThread;

        private WebView2 webView;
        private Panel skeleton;
        private Panel errorPanel;
        private NotifyIcon tray;
        private bool exiting;

        // P0-2：桥接托管。guard 只认自己起过的 PID；timer 每 2 秒看一次进程在不在、API 通不通。
        private readonly BridgeGuard guard;
        private System.Windows.Forms.Timer guardTimer;
        private ToolStripMenuItem statusItem;
        private ToolStripMenuItem startItem;
        private ToolStripMenuItem stopItem;
        private ToolStripMenuItem restartItem;
        private ToolStripMenuItem autostartItem;
        private string statusText = "正在检查桥接…";
        private bool probeBusy;
        private bool startupCheckStarted;

        // 6B 更新检查：启动后每 6 小时探一次更新源；发现新版只提示，用户点确认才下载安装。
        private ToolStripMenuItem updateItem;
        private System.Windows.Forms.Timer updateTimer;
        private bool updateBusy;
        private UpdateInfo pendingUpdate;
        private const int UpdateCheckIntervalMs = 6 * 60 * 60 * 1000;

        internal HostForm(Options options)
        {
            opt = options;
            paths = new AppPaths(opt.Root);
            guard = new BridgeGuard(paths);

            Text = Brand.Name;
            // 窗口/任务栏图标必须显式给：WinForms 的 Form 不设 Icon 时会拿 IDI_APPLICATION 兜底，
            // 于是 exe 里明明嵌着 brand.ico，任务栏和 Alt+Tab 里还是那个红黄蓝方块。
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            // 最小 360×560（逻辑像素）：360 是 client.html 的窄屏断点，用户明确要「真窗口能到 360」。
            // WinForms 的 MinimumSize 吃物理像素，所以按 DPI 折算（150% → 540×840，200% → 720×1120）。
            MinimumSize = MinSizeForDpi(96);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(0xFA, 0xF7, 0xFB);
            AutoScaleMode = AutoScaleMode.Dpi;
            DoubleBuffered = true;
            RestoreBoundsFromDisk();

            BuildUi();
            BuildTray();
            StartGuardTimer();
            StartActivationListener(out activateThread, out activateEvent);
            // 打开就先看桥接在不在：在就直接加载；不在就拉起来再加载（重启电脑后双击图标不再只看到错误页）。
            Shown += delegate
            {
                OnShown();
                // --autostart：登录时由 Run 键拉起，只需要托盘常驻 + 桥接在跑，不要抢焦点弹窗。
                if (opt.Autostart)
                {
                    BeginInvoke(new Action(delegate { Hide(); }));
                }
            };
        }

        // ── 界面骨架 ──────────────────────────────────────────────────────────
        private void BuildUi()
        {
            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            // 骨架页同色：WebView2 初始化那一瞬是它自己的白底，先染成粉白减少闪白。
            webView.DefaultBackgroundColor = Color.FromArgb(0xFA, 0xF7, 0xFB);
            Controls.Add(webView);

            skeleton = new Panel();
            skeleton.Dock = DockStyle.Fill;
            skeleton.BackColor = Color.FromArgb(0xFA, 0xF7, 0xFB);

            Label title = new Label();
            title.Text = Brand.Name;
            title.Font = new Font("Segoe UI", 18F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(0xC2, 0x18, 0x5B);
            title.AutoSize = true;
            title.Location = new Point(40, 40);
            skeleton.Controls.Add(title);

            Label hint = new Label();
            hint.Name = "skeletonHint";
            hint.Text = "正在连接桥接…";
            hint.Font = new Font("Microsoft YaHei UI", 10F);
            hint.ForeColor = Color.FromArgb(0x5A, 0x4A, 0x52);
            hint.AutoSize = true;
            hint.Location = new Point(42, 88);
            skeleton.Controls.Add(hint);

            Controls.Add(skeleton);
            skeleton.BringToFront();
        }

        private Label SkeletonHint()
        {
            foreach (Control c in skeleton.Controls)
            {
                if (c.Name == "skeletonHint") { return c as Label; }
            }
            return null;
        }

        // ── 托盘 ──────────────────────────────────────────────────────────────
        private void BuildTray()
        {
            tray = new NotifyIcon();
            // 用 exe 里嵌的品牌图标（/win32icon 打进 exe）；取不到才退回系统默认图标。
            tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            tray.Text = Brand.Name;
            tray.Visible = true;

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("打开", null, delegate { ShowAndActivate(); });

            // 状态行（不可点）：桥接在不在、PID、/api/status 通不通。
            statusItem = new ToolStripMenuItem("桥接：检查中…");
            statusItem.Enabled = false;
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());

            startItem = new ToolStripMenuItem("启动桥接", null, delegate { StartBridgeFromUi(); });
            restartItem = new ToolStripMenuItem("重启桥接", null, delegate { RestartBridgeFromUi(); });
            stopItem = new ToolStripMenuItem("停止桥接", null, delegate { StopBridgeFromUi(); });
            menu.Items.Add(startItem);
            menu.Items.Add(restartItem);
            menu.Items.Add(stopItem);
            menu.Items.Add(new ToolStripSeparator());

            // 开机自启：默认关，勾选才写 HKCU\...\Run；再点一次就是取消。
            autostartItem = new ToolStripMenuItem("开机自启（可选）");
            autostartItem.Checked = Autostart.IsEnabled();
            autostartItem.Click += delegate { ToggleAutostart(); };
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());

            // 更新检查：默认禁用文案；探到新版才变成「有新版本 vX.Y.Z（点击更新）」。
            updateItem = new ToolStripMenuItem("检查更新");
            updateItem.Enabled = false;
            updateItem.Click += delegate { ConfirmUpdate(); };
            menu.Items.Add(updateItem);
            menu.Items.Add(new ToolStripSeparator());

            menu.Items.Add("关于", null, delegate { ShowAbout(); });
            menu.Items.Add("退出", null, delegate { ExitApplication(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { ShowAndActivate(); };
            UpdateStatusUi();
        }

        // ── 更新检查 / 一键更新（6B） ─────────────────────────────────────────
        // 更新源 = config.json 的 desktop.updateUrl；空 = 关闭检查（默认一个包都不发）。
        // 只在 WebView 就绪后开始：更新检查不该跟首屏抢网络和 UI 线程。
        private void StartUpdateCheckTimer()
        {
            if (updateTimer != null) { return; }
            updateTimer = new System.Windows.Forms.Timer();
            updateTimer.Interval = UpdateCheckIntervalMs;
            updateTimer.Tick += delegate { CheckForUpdateAsync(); };
            updateTimer.Start();
            CheckForUpdateAsync(); // 启动先探一次，别等 6 小时
        }

        // 后台线程探更新源；失败只记日志，不打扰用户（网络抖动不该天天弹窗）。
        private void CheckForUpdateAsync()
        {
            if (exiting || updateBusy) { return; }
            string url = paths.ResolveUpdateUrl();
            if (string.IsNullOrEmpty(url)) { return; } // 没配更新源 = 关闭检查
            updateBusy = true;
            string current = paths.CurrentVersion();
            Thread t = new Thread(delegate ()
            {
                UpdateInfo info = null;
                string failure = null;
                try { info = FetchUpdate(url); }
                catch (Exception ex) { failure = Program.Scrub(ex.Message); }
                if (info == null)
                {
                    BridgeLog.Write(paths.UpdateLogPath, "update check: " + (failure == null ? "no usable manifest" : "failed: " + failure));
                    Post(delegate { updateBusy = false; });
                    return;
                }
                int? cmp = UpdateVersion.Compare(info.Version, current);
                if (cmp == null)
                {
                    // 远端给了一个不认识的版本号：跳过并记日志，绝不当成「有更新」。
                    BridgeLog.Write(paths.UpdateLogPath, "update check: unparsable remote version '" + info.Version + "'");
                    Post(delegate { updateBusy = false; });
                    return;
                }
                BridgeLog.Write(paths.UpdateLogPath, "update check: remote=" + info.Version + " local=" + current + " cmp=" + cmp.Value);
                Post(delegate
                {
                    updateBusy = false;
                    if (cmp.Value > 0) { ShowUpdateAvailable(info); }
                    else { updateItem.Text = "已是最新版本 v" + current; updateItem.Enabled = false; }
                });
            });
            t.IsBackground = true;
            t.Start();
        }

        // --check-update 的实现：复用窗口里那套 FetchUpdate / UpdateVersion.Compare，
        // 保证「脚本自检」和「托盘真实检查」走的是同一段逻辑。
        internal static int RunUpdateCheck(Options opt)
        {
            AppPaths paths = new AppPaths(opt.Root);
            string url = paths.ResolveUpdateUrl();
            if (string.IsNullOrEmpty(url))
            {
                BridgeLog.Write(paths.UpdateLogPath, "update-check: 未配置 desktop.updateUrl（更新检查关闭）");
                return 2;
            }
            string current = paths.CurrentVersion();
            UpdateInfo info = null;
            string failure = null;
            try { info = FetchUpdate(url); }
            catch (Exception ex) { failure = ex.Message; }
            if (info == null)
            {
                BridgeLog.Write(paths.UpdateLogPath, "update-check: 读取更新源失败 " + (failure == null ? "（清单不可用）" : failure) + " url=" + url);
                return 2;
            }
            int? cmp = UpdateVersion.Compare(info.Version, current);
            BridgeLog.Write(paths.UpdateLogPath, "update-check: remote=" + info.Version + " local=" + current
                + " cmp=" + (cmp.HasValue ? cmp.Value.ToString() : "?") + " url=" + info.Url);
            if (!cmp.HasValue) { return 2; }
            return cmp.Value > 0 ? 1 : 0;
        }

        // GET 更新源（10 秒超时、64KB 上限、绕系统代理，和 /api/status 探活同口径）。
        private static UpdateInfo FetchUpdate(string url)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = 10000;
            req.ReadWriteTimeout = 10000;
            req.Proxy = null;
            req.UserAgent = "qqdeepseekbot-desktop-update";
            string body;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            {
                if (resp.StatusCode != HttpStatusCode.OK) { return null; }
                using (Stream s = resp.GetResponseStream())
                using (StreamReader reader = new StreamReader(s, Encoding.UTF8))
                {
                    StringBuilder sb = new StringBuilder();
                    char[] buf = new char[4096];
                    int n;
                    while ((n = reader.Read(buf, 0, buf.Length)) > 0)
                    {
                        sb.Append(buf, 0, n);
                        if (sb.Length > 65536) { return null; }
                    }
                    body = sb.ToString();
                }
            }
            UpdateInfo info;
            if (!UpdateVersion.TryParse(body, out info)) { return null; }
            return info;
        }

        // 只在托盘里提示「有新版本 vX.Y.Z（点击更新）」——绝不自动静默安装。
        private void ShowUpdateAvailable(UpdateInfo info)
        {
            pendingUpdate = info;
            updateItem.Text = "有新版本 v" + info.Version + "（点击更新）";
            updateItem.Enabled = true;
            try
            {
                tray.BalloonTipTitle = Brand.Name + " 有新版本";
                tray.BalloonTipText = "v" + info.Version + " 已发布，点托盘菜单「" + updateItem.Text + "」更新。";
                tray.ShowBalloonTip(4000);
            }
            catch (Exception) { }
        }

        // 二次确认：说清会关机器人重装、state/config 保留；用户点「否」就什么都不做。
        private void ConfirmUpdate()
        {
            UpdateInfo info = pendingUpdate;
            if (info == null || exiting) { return; }
            string msg = "发现新版本 v" + info.Version + "。" + Environment.NewLine + Environment.NewLine
                + "更新会关闭当前机器人，然后运行安装包重装。" + Environment.NewLine
                + "state/ 记忆库与 config.json 会保留。" + Environment.NewLine + Environment.NewLine
                + "现在更新吗？";
            if (MessageBox.Show(this, msg, Brand.Name + " 更新", MessageBoxButtons.YesNo, MessageBoxIcon.Information) != DialogResult.Yes) { return; }
            StartUpdate(info);
        }

        // 用户确认后：后台下载 -> 校验 sha256（有就给）-> 启动安装包 -> 壳退出等安装器接管。
        private void StartUpdate(UpdateInfo info)
        {
            if (updateBusy) { return; }
            updateBusy = true;
            updateItem.Enabled = false;
            SetStatus("正在下载更新 v" + info.Version + "…");
            BridgeLog.Write(paths.UpdateLogPath, "update start v" + info.Version + " url=" + (info.Url.Length > 200 ? info.Url.Substring(0, 200) : info.Url));
            Thread t = new Thread(delegate ()
            {
                string setup = null;
                string failure = null;
                try { setup = DownloadUpdate(info); }
                catch (Exception ex) { failure = Program.Scrub(ex.Message); }
                if (setup == null)
                {
                    Post(delegate { UpdateFailed(failure == null ? "下载失败" : failure); });
                    return;
                }
                Post(delegate { LaunchSetup(setup, info); });
            });
            t.IsBackground = true;
            t.Start();
        }

        // 下载到 %TEMP%（不写 state/config），有 sha256 就校验；任何失败都删掉半截文件。
        private string DownloadUpdate(UpdateInfo info)
        {
            string temp = Path.Combine(Path.GetTempPath(), Brand.AppDataDirName + "-update-v" + info.Version + ".exe");
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(info.Url);
            req.Method = "GET";
            req.Timeout = 120000;
            req.ReadWriteTimeout = 120000;
            req.Proxy = null;
            req.UserAgent = "qqdeepseekbot-desktop-update";
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            {
                if (resp.StatusCode != HttpStatusCode.OK) { throw new Exception("HTTP " + (int)resp.StatusCode); }
                if (resp.ContentLength > 300L * 1024 * 1024) { throw new Exception("安装包过大（" + resp.ContentLength + " B）"); }
                using (Stream s = resp.GetResponseStream())
                using (FileStream fs = new FileStream(temp, FileMode.Create, FileAccess.Write))
                {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0) { fs.Write(buf, 0, n); }
                }
            }
            if (!string.IsNullOrEmpty(info.Sha256))
            {
                string actual = Sha256Of(temp);
                if (!string.Equals(actual, info.Sha256.Trim(), StringComparison.OrdinalIgnoreCase))
                {
                    TryDelete(temp);
                    throw new Exception("sha256 校验不通过（期望 " + info.Sha256 + "，实际 " + actual + "）");
                }
            }
            return temp;
        }

        private static string Sha256Of(string file)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] hash = sha.ComputeHash(fs);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++) { sb.Append(hash[i].ToString("x2")); }
                return sb.ToString();
            }
        }

        private static void TryDelete(string file)
        {
            try { if (File.Exists(file)) { File.Delete(file); } } catch (Exception) { }
        }

        // 用户已点过二次确认才会走到这里：用安装器自带的 /S（静默）参数拉起 Setup.exe，
        // 然后壳自己退出，让安装器替换文件（安装器会先结束安装目录下本程序的旧进程）。
        private void LaunchSetup(string setup, UpdateInfo info)
        {
            try
            {
                BridgeLog.Write(paths.UpdateLogPath, "launch setup " + setup + " (silent /S)");
                ProcessStartInfo psi = new ProcessStartInfo(setup, "/S");
                psi.UseShellExecute = false;
                psi.WorkingDirectory = Path.GetDirectoryName(setup);
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                TryDelete(setup);
                UpdateFailed("安装包启动失败：" + Program.Scrub(ex.Message));
                return;
            }
            BridgeLog.Write(paths.UpdateLogPath, "host exit for update v" + info.Version);
            ExitApplication();
        }

        // 失败在托盘里说清楚（网络 / 校验 / 权限），并把托盘项恢复成可再点。
        private void UpdateFailed(string reason)
        {
            updateBusy = false;
            if (pendingUpdate != null)
            {
                updateItem.Text = "有新版本 v" + pendingUpdate.Version + "（点击更新）";
                updateItem.Enabled = true;
            }
            SetStatus("更新失败：" + reason);
            BridgeLog.Write(paths.UpdateLogPath, "update failed: " + reason);
            try
            {
                tray.BalloonTipTitle = Brand.Name + " 更新失败";
                tray.BalloonTipText = reason;
                tray.ShowBalloonTip(5000);
            }
            catch (Exception) { }
        }

        // 后台线程 -> UI 线程的统一入口；窗口正在销毁时静默丢弃，不抛。
        private void Post(MethodInvoker action)
        {
            try
            {
                if (exiting) { return; }
                BeginInvoke(action);
            }
            catch (Exception) { }
        }

        // ── 桥接托管：状态、启动、停止、重启、守护 ────────────────────────────
        private void StartGuardTimer()
        {
            guardTimer = new System.Windows.Forms.Timer();
            guardTimer.Interval = BridgeGuard.GuardIntervalMs;
            guardTimer.Tick += delegate { OnGuardTick(); };
            guardTimer.Start();
        }

        // 首屏：后台线程探活/拉起，绝不在 UI 线程里 sleep（否则窗口会「未响应」）。
        private void OnShown()
        {
            if (startupCheckStarted) { return; }
            startupCheckStarted = true;
            Thread t = new Thread(delegate ()
            {
                try { EnsureBridgeReady(); }
                catch (Exception ex)
                {
                    string note = Program.Scrub(ex.Message);
                    SetStatus("桥接检查失败：" + note);
                    BeginInvoke((MethodInvoker)delegate
                    {
                        ShowError("桥接没有起来", "桌面壳尝试自动拉起桥接时出错：" + note + Environment.NewLine
                            + "启动日志：" + guard.StdoutLogPath, "自动启动失败");
                    });
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        private void EnsureBridgeReady()
        {
            int port = paths.ResolvePort();
            if (BridgeProbe.IsReady(port, paths.ReadToken())) { MarkReady(); return; }

            // T30：3100 上已经有一个桥接（多半是开发目录的实例或旧版本客户端），但它的控制台令牌
            // 和本机 state 不一致 —— 这种情况下守护重启只会 EADDRINUSE，直接给可操作的提示。
            if (BridgeProbe.IsPortBusy(port))
            {
                SetStatus("端口 " + port + " 已被占用");
                BeginInvoke((MethodInvoker)delegate
                {
                    ShowError("端口 " + port + " 已被占用",
                        "本机已经有一个桥接实例在 " + port + " 上运行，但它用的控制台令牌和这个窗口不一致。" + Environment.NewLine
                        + "常见原因：同时开着开发目录的桥接，或旧版本客户端留下的实例。" + Environment.NewLine
                        + "处理办法：关掉另一个桥接后点「重试」；或者用同一个 --root 启动本窗口（安装器写的快捷方式已带该参数）。",
                        "端口被占用（EADDRINUSE）");
                });
                return;
            }

            SetStatus("正在启动桥接…");
            if (!guard.IsRunning && !guard.Start())
            {
                SetStatus("启动失败：" + guard.LastNote);
                BeginInvoke((MethodInvoker)delegate
                {
                    ShowError("桥接没有起来", "桌面壳尝试启动桥接失败：" + guard.LastNote + Environment.NewLine
                        + "启动日志：" + guard.StdoutLogPath + Environment.NewLine
                        + "确认 --root 指向安装目录，且目录里有 node.exe 与 src\\bridge.js。", "启动失败");
                });
                return;
            }
            WaitReadyAndLoad(port);
        }

        // 轮询 /api/status 直到就绪或超时（ReadyTimeoutMs）。成功才加载界面。
        private void WaitReadyAndLoad(int port)
        {
            DateTime deadline = DateTime.Now.AddMilliseconds(BridgeGuard.ReadyTimeoutMs);
            while (DateTime.Now < deadline)
            {
                if (exiting) { return; }
                Thread.Sleep(500);
                if (BridgeProbe.IsReady(port, paths.ReadToken())) { MarkReady(); return; }
                if (guard.GaveUp) { break; }
            }
            SetStatus("桥接启动超时（" + (BridgeGuard.ReadyTimeoutMs / 1000) + " 秒）");
            BeginInvoke((MethodInvoker)delegate { ShowStartupTimeout(); });
        }

        private void ShowStartupTimeout()
        {
            string detail = (BridgeGuard.ReadyTimeoutMs / 1000) + " 秒内 /api/status 没有响应。" + Environment.NewLine
                + "端口：" + paths.ResolvePort() + Environment.NewLine
                + "启动日志：" + guard.StdoutLogPath + Environment.NewLine
                + "守护日志：" + guard.GuardLogPath + Environment.NewLine
                + "常见原因：端口被别的进程占用、node.exe 不在 --root 目录、config.json 写坏。";
            ShowError("桥接没有起来（启动超时）", detail, "启动超时");
        }

        // UI 线程调用：置状态文字（后台线程调也安全）。
        private void SetStatus(string text)
        {
            if (exiting) { return; }
            MethodInvoker apply = delegate { statusText = text; UpdateStatusUi(); };
            try
            {
                if (InvokeRequired) { BeginInvoke(apply); }
                else { apply(); }
            }
            catch (Exception)
            {
                // 窗口正在销毁：状态写不进去不是错误。
            }
        }

        private void MarkReady()
        {
            SetStatus("运行中（PID " + guard.Pid + "）");
            try { BeginInvoke((MethodInvoker)delegate { UpdateStatusUi(); StartUpdateCheckTimer(); InitWebViewAsync(); }); }
            catch (Exception) { }
        }

        // 每 2 秒：看进程在不在（不在就按守护规则重拉），再异步探一次 /api/status 刷新状态。
        private void OnGuardTick()
        {
            if (exiting) { return; }
            if (guard.Tick()) { SetStatus("桥接意外退出，已自动重拉…"); }
            if (probeBusy) { return; }
            probeBusy = true;
            Thread t = new Thread(delegate ()
            {
                bool ready = false;
                try { ready = BridgeProbe.IsReady(paths.ResolvePort(), paths.ReadToken()); }
                catch (Exception) { ready = false; }
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        probeBusy = false;
                        RefreshStatusFromProbe(ready);
                    });
                }
                catch (Exception)
                {
                    try { BeginInvoke((MethodInvoker)delegate { probeBusy = false; }); } catch (Exception) { }
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        private void RefreshStatusFromProbe(bool ready)
        {
            if (exiting) { return; }
            int pid = guard.Pid;
            if (guard.GaveUp)
            {
                statusText = "自动拉起已放弃（" + guard.LastNote + "）";
            }
            else if (ready)
            {
                statusText = pid > 0 ? "运行中（PID " + pid + "）" : "运行中（外部进程）";
            }
            else if (guard.UserStopped)
            {
                statusText = "已手动停止";
            }
            else if (guard.IsRunning)
            {
                statusText = "已启动，等待 API 就绪…";
            }
            else
            {
                statusText = "未运行（可从托盘启动）";
            }
            UpdateStatusUi();
        }

        private void UpdateStatusUi()
        {
            if (statusItem != null) { statusItem.Text = "桥接：" + statusText; }
            bool running = guard.IsRunning;
            if (startItem != null) { startItem.Enabled = !running; }
            if (stopItem != null) { stopItem.Enabled = running || guard.UserStopped; }
            if (autostartItem != null)
            {
                bool enabled = Autostart.IsEnabled();
                if (autostartItem.Checked != enabled) { autostartItem.Checked = enabled; }
            }
            if (tray != null)
            {
                string tip = Brand.Name + " · " + statusText;
                // NotifyIcon.Text 上限 63 字符，超了会抛异常。
                if (tip.Length > 63) { tip = tip.Substring(0, 63); }
                tray.Text = tip;
            }
        }

        private void StartBridgeFromUi()
        {
            SetStatus("正在启动桥接…");
            if (!guard.Start())
            {
                SetStatus("启动失败：" + guard.LastNote);
                return;
            }
            int port = paths.ResolvePort();
            Thread t = new Thread(delegate () { WaitReadyAndLoad(port); });
            t.IsBackground = true;
            t.Start();
        }

        private void StopBridgeFromUi()
        {
            guard.Stop();
            SetStatus(guard.LastNote);
            UpdateStatusUi();
        }

        private void RestartBridgeFromUi()
        {
            SetStatus("正在重启桥接…");
            HideError();
            skeleton.Visible = true;
            skeleton.BringToFront();
            bool restarted = guard.Restart();
            if (!restarted) { SetStatus("重启失败：" + guard.LastNote); return; }
            int port = paths.ResolvePort();
            Thread t = new Thread(delegate () { WaitReadyAndLoad(port); });
            t.IsBackground = true;
            t.Start();
        }

        private void ToggleAutostart()
        {
            bool want = autostartItem != null && autostartItem.Checked;
            bool ok = Autostart.Set(want, Application.ExecutablePath, paths.Root);
            bool now = ok && Autostart.IsEnabled();
            if (autostartItem != null) { autostartItem.Checked = now; }
            if (!ok)
            {
                MessageBox.Show("写开机自启注册表失败（HKCU\\...\\Run）。" + Environment.NewLine
                    + "可以手动把本程序快捷方式放进 shell:startup 文件夹。", Brand.Name,
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            BridgeLog.Write(guard.GuardLogPath, "autostart=" + (now ? "on" : "off"));
            SetStatus(statusText + (now ? " · 已开自启" : ""));
        }

        private void ShowAbout()
        {
            string text = Brand.Name + " v" + Brand.Version + Environment.NewLine + Environment.NewLine
                + Brand.Trademark + Environment.NewLine + Environment.NewLine
                + "控制台端口：" + paths.ResolvePort();
            MessageBox.Show(text, "关于 " + Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // ── 单实例激活：等第二个进程的事件，收到就前置窗口 ─────────────────────
        private void StartActivationListener(out Thread thread, out EventWaitHandle handle)
        {
            thread = null;
            handle = null;
            EventWaitHandle ev = null;
            EventWaitHandle quit = null;
            try
            {
                ev = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ActivateEventName);
                quit = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            }
            catch (Exception)
            {
                return; // 事件建不起来只影响「二次启动能否前置」，不影响主功能
            }
            Thread t = new Thread(delegate ()
            {
                WaitHandle[] waits = new WaitHandle[] { ev, quit };
                while (!exiting)
                {
                    int which;
                    try { which = WaitHandle.WaitAny(waits, 500); }
                    catch (Exception) { return; } // 退出时事件被 Dispose，不是错误
                    if (which == WaitHandle.WaitTimeout) { continue; }
                    if (exiting) { return; }
                    if (which == 1)
                    {
                        // --quit：和托盘「退出」走同一个方法，保证清理路径只有一条。
                        try { BeginInvoke((MethodInvoker)delegate { ExitApplication(); }); }
                        catch (Exception) { return; }
                        return;
                    }
                    try { BeginInvoke((MethodInvoker)delegate { ShowAndActivate(); }); }
                    catch (Exception) { return; }
                }
            });
            t.IsBackground = true;
            t.Start();
            thread = t;
            handle = ev;
            quitEvent = quit;
        }

        private void ShowAndActivate()
        {
            if (exiting) { return; }
            if (!Visible) { Show(); }
            if (WindowState == FormWindowState.Minimized) { WindowState = FormWindowState.Normal; }
            // 托盘里 Show 出来的窗口不一定抢得到前台（Windows 的前台锁）：
            // SW_RESTORE → AttachThreadInput 到前台线程 → BringWindowToTop + SetForegroundWindow，
            // 抢不到就 FlashWindowEx 让任务栏按钮闪两下，至少用户能看见「已经叫起来了」。
            try
            {
                IntPtr h = Handle;
                ShowWindow(h, 9 /*SW_RESTORE*/);
                uint fore = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
                uint mine = GetCurrentThreadId();
                bool attached = false;
                if (fore != 0 && fore != mine) { attached = AttachThreadInput(fore, mine, true); }
                BringWindowToTop(h);
                SetForegroundWindow(h);
                if (attached) { AttachThreadInput(fore, mine, false); }
                Activate();
                FLASHWINFO fi = new FLASHWINFO();
                fi.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
                fi.hwnd = h;
                fi.dwFlags = 0x00000002 | 0x00000003; // FLASHW_TRAY | FLASHW_ALL
                fi.uCount = 2;
                fi.dwTimeout = 0;
                FlashWindowEx(ref fi);
            }
            catch (Exception)
            {
                Activate();
                BringToFront();
            }
        }

        // ── WebView2 ──────────────────────────────────────────────────────────
        private async void InitWebViewAsync()
        {
            HideError();
            string token = paths.ReadToken();

            if (string.IsNullOrEmpty(opt.Url) && string.IsNullOrEmpty(token))
            {
                ShowError("读不到控制台令牌",
                    "没找到 " + Path.Combine("state", "console-token") + "。" + Environment.NewLine
                    + "桌面壳已尝试自动拉起桥接（日志：" + guard.StdoutLogPath + "）。" + Environment.NewLine
                    + "也可以托盘右键「启动桥接」；仍不行就检查 --root 是否指向正确的安装目录。",
                    "令牌文件缺失");
                return;
            }

            string runtimeVersion = null;
            try { runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (Exception) { runtimeVersion = null; }
            if (string.IsNullOrEmpty(runtimeVersion))
            {
                ShowRuntimeMissing();
                return;
            }

            string target = BuildTargetUrl(token);
            try
            {
                Directory.CreateDirectory(paths.WebViewDataDir);
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, paths.WebViewDataDir, null);
                await webView.EnsureCoreWebView2Async(env);

                CoreWebView2 core = webView.CoreWebView2;
                core.Settings.AreDevToolsEnabled = opt.DevTools;
                // 右键菜单常开：用户要「右键 → 刷新界面」；以前只在 DevTools 模式开，
                // 非开发模式下连刷新都没有，页面卡住只能关窗口重开。
                core.Settings.AreDefaultContextMenusEnabled = true;
                core.Settings.AreBrowserAcceleratorKeysEnabled = opt.DevTools;
                core.ContextMenuRequested += OnContextMenuRequested;
                core.Settings.IsStatusBarEnabled = false;
                core.NewWindowRequested += OnNewWindowRequested;
                webView.NavigationCompleted += OnNavigationCompleted;

                // 刷新快捷键：F5 / Ctrl+R / Ctrl+F5（强制）。AcceleratorKeys 在非 DevTools 下是关的，
                // 所以在页面文档里自己拦一次，顺手给工具栏留个 window.qdbReload 钩子。
                await core.AddScriptToExecuteOnDocumentCreatedAsync(
                    "(function(){"
                    + "window.qdbReload=function(){try{location.reload()}catch(e){}};"
                    + "document.addEventListener('keydown',function(e){"
                    + "var k=(e.key||'').toLowerCase();"
                    + "if(e.key==='F5'||(e.ctrlKey&&k==='r')){e.preventDefault();window.qdbReload();}"
                    + "},true);"
                    + "})();");

                SetSkeletonText("正在加载界面…");
                webView.Source = new Uri(target);
            }
            catch (Exception ex)
            {
                ShowError("界面初始化失败",
                    "WebView2 没能启动：" + Program.Scrub(ex.Message),
                    ex.GetType().Name);
            }
        }

        // 目标地址：--url 优先；否则 http://127.0.0.1:<port>/client?token=<tok>。
        // 令牌只在这个方法里拼进 URL，不落任何其他字符串。
        private string BuildTargetUrl(string token)
        {
            if (!string.IsNullOrEmpty(opt.Url)) { return opt.Url; }
            // console-host 在跑就用它（桥接挂了页面也活得下来）；老装法没有这个进程时退回桥接端口。
            int hostPort = paths.ResolveConsoleHostPort();
            int port = ConsoleHostProbe.IsUp(hostPort) ? hostPort : paths.ResolvePort();
            return "http://127.0.0.1:" + port + "/client?token=" + Uri.EscapeDataString(token);
        }

        // 给人看的地址（永远去掉查询串，免得令牌上屏/进截图）。
        private string DisplayUrl()
        {
            if (!string.IsNullOrEmpty(opt.Url))
            {
                try
                {
                    Uri u = new Uri(opt.Url);
                    return u.GetLeftPart(UriPartial.Path);
                }
                catch (Exception) { return "（--url 指定的地址）"; }
            }
            int hostPort = paths.ResolveConsoleHostPort();
            int port = ConsoleHostProbe.IsUp(hostPort) ? hostPort : paths.ResolvePort();
            return "http://127.0.0.1:" + port + "/client";
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                ShowContent();
                return;
            }
            string code = e.WebErrorStatus.ToString();
            string detail = "加载 " + DisplayUrl() + " 失败。" + Environment.NewLine
                + "如果是「连接被拒绝」，说明桥接没有在运行：先启动桥接（或安装器里的启动项），再点「重试」。";
            // 导航失败：这是「桥接没起来 / 页面 404」而不是「没装运行时」，所以不给运行时下载链接。
            ShowError("桥接没有响应（" + code + "）", detail, "错误码：" + code);
        }

        // 新窗口一律拦下：这是一层壳，不该长出第二个浏览器窗口（T16 的页面也不依赖 window.open）。
                // 右键菜单：在系统默认菜单前面插一条「刷新界面」，DevTools 模式再追加开发者工具。
        private void OnContextMenuRequested(object sender, CoreWebView2ContextMenuRequestedEventArgs e)
        {
            try
            {
                CoreWebView2 core = webView.CoreWebView2;
                if (core == null) return;
                CoreWebView2ContextMenuItem reload = core.Environment.CreateContextMenuItem(
                    "刷新界面 (F5)", null, CoreWebView2ContextMenuItemKind.Command);
                reload.CustomItemSelected += delegate(object s2, object e2)
                {
                    try { core.Reload(); } catch (Exception) { }
                };
                e.MenuItems.Insert(0, reload);
                try
                {
                    CoreWebView2ContextMenuItem sep = core.Environment.CreateContextMenuItem(
                        "", null, CoreWebView2ContextMenuItemKind.Separator);
                    e.MenuItems.Insert(1, sep);
                }
                catch (Exception) { }
                if (opt.DevTools)
                {
                    CoreWebView2ContextMenuItem dev = core.Environment.CreateContextMenuItem(
                        "开发者工具", null, CoreWebView2ContextMenuItemKind.Command);
                    dev.CustomItemSelected += delegate(object s2, object e2)
                    {
                        try { core.OpenDevToolsWindow(); } catch (Exception) { }
                    };
                    e.MenuItems.Add(dev);
                }
            }
            catch (Exception) { }
        }

private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
        }

        private void Retry()
        {
            HideError();
            skeleton.Visible = true;
            skeleton.BringToFront();
            if (!BridgeProbe.IsReady(paths.ResolvePort(), paths.ReadToken()) && !guard.IsRunning)
            {
                // 重试 = 「给我弄好」：桥接没在跑就先拉起来，而不是再报一次连接被拒绝。
                StartBridgeFromUi();
                return;
            }
            if (webView == null || webView.CoreWebView2 == null)
            {
                InitWebViewAsync();
                return;
            }
            string token = paths.ReadToken();
            if (string.IsNullOrEmpty(opt.Url) && string.IsNullOrEmpty(token))
            {
                ShowError("读不到控制台令牌", "没找到 state/console-token，先启动桥接再重试。", "令牌文件缺失");
                return;
            }
            SetSkeletonText("正在重新连接…");
            try { webView.Source = new Uri(BuildTargetUrl(token)); }
            catch (Exception ex) { ShowError("地址无效", Program.Scrub(ex.Message), "重试失败"); }
        }

        private void ShowContent()
        {
            skeleton.Visible = false;
            errorPanel.Visible = false;
        }

        private void SetSkeletonText(string text)
        {
            Label hint = SkeletonHint();
            if (hint != null) { hint.Text = text; }
        }

        // ── 错误页（纯 WinForms，不依赖 WebView2：运行时缺失时它也得能显示） ──────
        private void ShowError(string title, string detail, string code)
        {
            ShowError(title, detail, code, false);
        }

        private void ShowError(string title, string detail, string code, bool offerDownload)
        {
            if (errorPanel != null) { Controls.Remove(errorPanel); errorPanel.Dispose(); }

            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.BackColor = Color.FromArgb(0xFA, 0xF7, 0xFB);
            panel.AutoScroll = true;

            // 流式布局 + 标签按面板宽度换行：窗口能拖到 360 宽，固定坐标/固定宽度的排版会横向溢出。
            // 内容整体居中（T31：原来顶在左上角，看着像没排版）。
            FlowLayoutPanel flow = new FlowLayoutPanel();
            flow.FlowDirection = FlowDirection.TopDown;
            flow.WrapContents = false;
            flow.AutoSize = true;
            flow.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            flow.Padding = new Padding(0, 0, 0, 0);
            flow.Anchor = AnchorStyles.None;

            TableLayoutPanel centering = new TableLayoutPanel();
            centering.Dock = DockStyle.Fill;
            centering.ColumnCount = 1;
            centering.RowCount = 1;
            centering.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            centering.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            centering.Controls.Add(flow, 0, 0);
            panel.Controls.Add(centering);

            Label headline = MakeErrorLabel(title, 15F, true, Color.FromArgb(0xC2, 0x18, 0x5B));
            Label body = MakeErrorLabel(detail, 10F, false, Color.FromArgb(0x44, 0x38, 0x3E));
            Label codeLabel = MakeErrorLabel(code, 9F, false, Color.FromArgb(0x8A, 0x7A, 0x82));
            codeLabel.Font = new Font("Consolas", 9F);
            Label target = MakeErrorLabel("探测到的地址：" + DisplayUrl(), 9F, false, Color.FromArgb(0x8A, 0x7A, 0x82));
            target.Font = new Font("Consolas", 9F);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.AutoSize = true;
            buttons.WrapContents = true;
            buttons.Margin = new Padding(0, 10, 0, 0);

            Button retry = new Button();
            retry.Text = "重试";
            retry.Size = new Size(96, 34);
            retry.Margin = new Padding(0, 0, 8, 0);
            retry.Click += delegate { Retry(); };
            buttons.Controls.Add(retry);

            Button started = new Button();
            started.Text = "我已启动";
            started.Size = new Size(110, 34);
            started.Click += delegate { Retry(); };
            buttons.Controls.Add(started);

            // 壳自己托管进程，所以错误页也能直接重拉一次（比让用户去开命令行强）。
            Button relaunch = new Button();
            relaunch.Text = "重启桥接";
            relaunch.Size = new Size(110, 34);
            relaunch.Margin = new Padding(8, 0, 0, 0);
            relaunch.Click += delegate { RestartBridgeFromUi(); };
            buttons.Controls.Add(relaunch);

            flow.Controls.Add(headline);
            flow.Controls.Add(body);
            flow.Controls.Add(codeLabel);
            flow.Controls.Add(target);
            flow.Controls.Add(buttons);

            if (offerDownload || title.IndexOf("WebView2", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                LinkLabel link = new LinkLabel();
                link.Text = "下载 WebView2 运行时（微软官方 Evergreen 安装包）";
                link.Font = new Font("Microsoft YaHei UI", 9F);
                link.AutoSize = true;
                link.Margin = new Padding(0, 8, 0, 0);
                link.LinkClicked += delegate
                {
                    try { Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703"); }
                    catch (Exception) { /* 没默认浏览器时静默，地址已经写在链接文字里 */ }
                };
                flow.Controls.Add(link);
            }

            // 标签最大宽度跟着面板走（减去左右 padding），窄窗时自动折行，不横向溢出。
            EventHandler relayout = delegate { RelayoutErrorLabels(flow, panel); };
            panel.Resize += relayout;
            RelayoutErrorLabels(flow, panel);

            errorPanel = panel;
            Controls.Add(panel);
            panel.BringToFront();
            skeleton.Visible = false;
        }

        private static Label MakeErrorLabel(string text, float size, bool bold, Color color)
        {
            Label label = new Label();
            label.Text = text;
            label.Font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular);
            label.ForeColor = color;
            label.AutoSize = true;
            label.Margin = new Padding(0, 0, 0, 8);
            return label;
        }

        // AutoSize 的 Label 只会在 MaximumSize 内换行：宽度跟着面板宽度重算，窄窗（360）也不会被裁掉。
        private static void RelayoutErrorLabels(FlowLayoutPanel flow, Panel panel)
        {
            int maxWidth = Math.Max(200, panel.ClientSize.Width - 64);
            flow.MaximumSize = new Size(maxWidth, 0);
            foreach (Control c in flow.Controls)
            {
                Label label = c as Label;
                if (label != null && label.AutoSize) { label.MaximumSize = new Size(maxWidth, 0); }
            }
        }

        private void ShowRuntimeMissing()
        {
            ShowError("没装 WebView2 运行时",
                "这个窗口要靠 Microsoft Edge WebView2 运行时来显示界面，本机没检测到。" + Environment.NewLine
                + "装一次就行（装完不用重装本程序），装好后点「重试」。",
                "运行时未检测到", true);
        }

        private void HideError()
        {
            if (errorPanel != null) { errorPanel.Visible = false; }
        }

        // ── 窗口位置记忆 ──────────────────────────────────────────────────────
        private void RestoreBoundsFromDisk()
        {
            try
            {
                if (!File.Exists(paths.WindowStatePath)) { Size = new Size(1024, 700); return; }
                string text = File.ReadAllText(paths.WindowStatePath, Encoding.UTF8);
                int x = IntField(text, "x"), y = IntField(text, "y");
                int w = IntField(text, "w"), h = IntField(text, "h");
                // 旧版本可能存过比新下限更小的尺寸（例如手改过 window.json，或 1024 时代的小窗）：
                // 夹到最小值，别把窗口恢复成 200px 宽然后卡在不可用状态。
                w = Math.Max(w, MinimumSize.Width);
                h = Math.Max(h, MinimumSize.Height);
                Rectangle bounds = new Rectangle(x, y, w, h);
                if (!IsOnAnyScreen(bounds)) { Size = new Size(w, h); return; } // 显示器换了：位置丢弃，尺寸保留
                StartPosition = FormStartPosition.Manual;
                Bounds = bounds;
                if (Regex.IsMatch(text, "\"maximized\"\\s*:\\s*true")) { WindowState = FormWindowState.Maximized; }
            }
            catch (Exception)
            {
                // 坏文件不炸：退回默认尺寸。
                Size = new Size(1024, 700);
            }
        }

        private static int IntField(string text, string name)
        {
            Match m = Regex.Match(text, "\"" + name + "\"\\s*:\\s*(-?\\d+)");
            int value;
            return m.Success && int.TryParse(m.Groups[1].Value, out value) ? value : 0;
        }

        private static bool IsOnAnyScreen(Rectangle bounds)
        {
            foreach (Screen screen in Screen.AllScreens)
            {
                if (screen.WorkingArea.IntersectsWith(bounds)) { return true; }
            }
            return false;
        }

        private void SaveBoundsToDisk()
        {
            try
            {
                Rectangle b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                bool maximized = WindowState == FormWindowState.Maximized;
                string json = "{\"x\":" + b.X + ",\"y\":" + b.Y + ",\"w\":" + b.Width + ",\"h\":" + b.Height
                    + ",\"maximized\":" + (maximized ? "true" : "false") + "}";
                Directory.CreateDirectory(Path.GetDirectoryName(paths.WindowStatePath));
                File.WriteAllText(paths.WindowStatePath, json, new UTF8Encoding(false));
            }
            catch (Exception)
            {
                // 位置记不住不是故障，静默即可（这里刻意不弹框）。
            }
        }

        // ── 启停 ──────────────────────────────────────────────────────────────
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            _dpi = DeviceDpi;
            ApplyMinimumSize();
            ApplyLightTitleBar();
        }

        // 当前生效的 DPI（96=100%）。为什么自己记：csc 编出来的 exe 没有 app.config 里的
        // <System.Windows.Forms.ApplicationConfigurationSection DpiAwareness="PerMonitorV2">，
        // .NET Framework 的 WinForms 在这种配置下**不会**把 WM_DPICHANGED 当缩放事件处理，
        // DeviceDpi 也不更新。我们在 WndProc 里自己认这条消息，保证 150%/200% 下折算正确。
        private int _dpi = 96;

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x02E0 /* WM_DPICHANGED */)
            {
                int dpi = (int)(m.WParam.ToInt64() & 0xFFFF);
                if (dpi > 0) { _dpi = dpi; ApplyMinimumSize(); }
            }
            base.WndProc(ref m);
        }

        // 逻辑最小尺寸 360×560。为什么是这两个数：
        //   宽 360 = client.html 的窄屏断点（用户拍板「要可以到 360」），再窄页面就横向挤爆；
        //   高 560 = 一张卡片高度 + 顶栏，且 1366×768 + 任务栏还放得下。
        // WinForms 的 MinimumSize 是**物理像素**，所以必须按当前 DPI 折算：
        // 否则 150% 缩放下窗口被卡在 540 物理像素，用户看起来"还是拖不窄"。
        internal static Size MinSizeForDpi(int dpi)
        {
            if (dpi <= 0) { dpi = 96; }
            int w = (int)Math.Round(360.0 * dpi / 96.0);
            int h = (int)Math.Round(560.0 * dpi / 96.0);
            return new Size(w, h);
        }

        private void ApplyMinimumSize()
        {
            MinimumSize = MinSizeForDpi(_dpi > 0 ? _dpi : DeviceDpi);
        }

        // 跨屏拖动 / 改系统缩放（WinForms 愿意处理时）也会走到这里：重新折算并把窗口抬到新下限。
        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            if (e.DeviceDpiNew > 0) { _dpi = e.DeviceDpiNew; }
            ApplyMinimumSize();
            if (Width < MinimumSize.Width || Height < MinimumSize.Height)
            {
                Size = new Size(Math.Max(Width, MinimumSize.Width), Math.Max(Height, MinimumSize.Height));
            }
        }

        // 浅色标题栏：Win10 只认 DWMWA_USE_IMMERSIVE_DARK_MODE=0；Win11(22000+) 还能染标题栏/文字颜色。
        // 全部包在 try 里 —— 系统不支持就用默认，绝不让它影响启动。
        private void ApplyLightTitleBar()
        {
            try
            {
                int light = 0;
                DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref light, sizeof(int));
                if (Environment.OSVersion.Version.Major >= 10 && Environment.OSVersion.Version.Build >= 22000)
                {
                    int caption = 0x00FBF7FA; // COLORREF 是 BGR：粉白 #FAF7FB
                    int textColor = 0x00201A1A;
                    DwmSetWindowAttribute(Handle, 35 /* DWMWA_CAPTION_COLOR */, ref caption, sizeof(int));
                    DwmSetWindowAttribute(Handle, 36 /* DWMWA_TEXT_COLOR */, ref textColor, sizeof(int));
                }
            }
            catch (Exception) { /* 老系统没有 dwmapi 的这个属性 */ }
        }


        // ── 前置窗口 / 清孤儿 WebView2 ────────────────────────────────────────
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

        [StructLayout(LayoutKind.Sequential)]
        private struct FLASHWINFO
        {
            public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct PROCESSENTRY32
        {
            public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
            public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
            public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)] private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)] private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr hObject);

        private static Dictionary<uint, string> _snapNames;

        // 所有 msedgewebview2 都是我们自己的 WebView2 运行时（user-data-dir 在本应用的 AppData 目录）。
        // 用 Toolhelp 快照建 pid→ppid，沿父链往上走：
        //   · 走进当前进程 = 自己的树；
        //   · 父 pid 在快照里查不到（宿主已死）= 孤儿树。
        // 只 kill 自己/孤儿的根，子进程随根一起退，避免误伤别的 WebView2 应用（它们父链是活着的）。
        internal static void CleanWebView2(bool mine)
        {
            try
            {
                IntPtr snap = CreateToolhelp32Snapshot(0x00000002 /*TH32CS_SNAPPROCESS*/, 0);
                if (snap == IntPtr.Zero || snap == new IntPtr(-1)) { return; }
                Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
                Dictionary<uint, string> names = new Dictionary<uint, string>();
                try
                {
                    PROCESSENTRY32 pe = new PROCESSENTRY32();
                    pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                    if (Process32First(snap, ref pe))
                    {
                        do
                        {
                            parents[pe.th32ProcessID] = pe.th32ParentProcessID;
                            names[pe.th32ProcessID] = pe.szExeFile == null ? "" : pe.szExeFile;
                        } while (Process32Next(snap, ref pe));
                    }
                }
                finally { CloseHandle(snap); }
                _snapNames = names;

                uint me = (uint)Process.GetCurrentProcess().Id;
                List<uint> victims = new List<uint>();
                foreach (KeyValuePair<uint, uint> kv in parents)
                {
                    string name;
                    if (!names.TryGetValue(kv.Key, out name)) { continue; }
                    if (!string.Equals(name, "msedgewebview2.exe", StringComparison.OrdinalIgnoreCase)) { continue; }
                    bool isMine = false; bool orphan = false;
                    uint cur = kv.Key; int guard = 0;
                    while (guard++ < 32)
                    {
                        uint ppid;
                        if (!parents.TryGetValue(cur, out ppid) || ppid == 0) { orphan = true; break; }
                        if (ppid == me) { isMine = true; break; }
                        if (!parents.ContainsKey(ppid)) { orphan = true; break; }
                        cur = ppid;
                    }
                    if (mine ? isMine : orphan) { victims.Add(kv.Key); }
                }
                for (int i = 0; i < victims.Count; i++)
                {
                    try
                    {
                        Process victim = Process.GetProcessById((int)victims[i]);
                        victim.Kill(); // 静态上下文拿不到 AppPaths，这里不写日志；数量可从进程列表核对
                    }
                    catch (Exception) { }
                }
            }
            catch (Exception) { }
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // 点关闭 = 收进托盘（用户明确「关闭窗口 = 最小化到托盘」）。
            if (!exiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                SaveBoundsToDisk();
                Hide();
                if (tray != null)
                {
                    tray.BalloonTipTitle = Brand.Name;
                    tray.BalloonTipText = "还在后台运行，双击托盘图标可以再打开。";
                    tray.ShowBalloonTip(2000);
                }
                return;
            }
            SaveBoundsToDisk();
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            Cleanup();
            base.OnFormClosed(e);
        }

        private void ExitApplication()
        {
            if (exiting) { return; }
            exiting = true;
            SaveBoundsToDisk();
            Close();
            Application.Exit();
        }

        // 退出顺序：先停守护定时器，再拆 WebView2，再拆托盘，最后让窗体消失。
        // WebView2 的子进程（msedgewebview2.exe）由它自己的浏览器进程托管，Dispose 后会自行退出；
        // 这里不做任何 Process.Kill，免得误杀别的 WebView2 应用。
        // 桥接进程**故意留着**：壳只是界面，关掉窗口不该把 QQ 机器人一起停（要停请点托盘「停止桥接」）。
        private void Cleanup()
        {
            try { if (guardTimer != null) { guardTimer.Stop(); guardTimer.Dispose(); } } catch (Exception) { }
            try { if (updateTimer != null) { updateTimer.Stop(); updateTimer.Dispose(); } } catch (Exception) { }
            try { if (webView != null) { webView.Dispose(); } } catch (Exception) { }
            CleanWebView2(true); // Dispose 只关本进程的控制器，浏览器进程要显式收掉，否则留成孤儿
            try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch (Exception) { }
            try { if (activateEvent != null) { activateEvent.Close(); } } catch (Exception) { }
            try { if (quitEvent != null) { quitEvent.Close(); } } catch (Exception) { }
            try { BridgeLog.Write(guard.GuardLogPath, "host exit (bridge left running, pid=" + guard.Pid + ")"); } catch (Exception) { }
        }
    }
}
