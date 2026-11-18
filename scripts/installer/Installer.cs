// QQ DeepSeek Bot 安装器（路线 B：Windows 自带 csc 编译的单文件安装包）。
//
// 为什么不选 Inno/NSIS/7z：本机 iscc / makensis / 7z 全都没有，装它们要联网；
// csc + System.IO.Compression 是系统自带（.NET Framework 4.x），产物是单 exe、
// 离线可装、可复现，也不需要签名工具链。详见 docs/installer-plan.md。
//
// 一个 exe 三种模式：
//   双击                 → 交互安装（欢迎页 → 安装 → 完成页，完成页可勾选开机自启）
//   /S [/D=<目录>]       → 静默安装（供脚本/验收用；不弹窗；默认不写 Run 键，要 /autostart）
//   /uninstall [/S]      → 卸载（确认页 → 停进程 → 删快捷方式/自启/Run 键/注册表/目录）
//
// 命名契约（用户定稿，全窗口统一）：品牌 QQ DeepSeek Bot，exe QQDeepSeekBot.exe，
// 目录 %LOCALAPPDATA%\QQDeepSeekBot，卸载键 HKCU\...\Uninstall\QQDeepSeekBot。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Installer
{
    const string ProductName = "QQ DeepSeek Bot";
    const string ExeName = "QQDeepSeekBot.exe";
    const string UninstallExeName = "Uninstall.exe";
    const string ShortcutName = "QQ DeepSeek Bot.lnk";
    const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\QQDeepSeekBot";
    const string NotAffiliated = "非腾讯 / 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）";
    const string MarkerName = ".installed.json";
    const string LogName = "QQDeepSeekBot-install.log";

    // 开机自启：写 HKCU Run（不需要管理员），卸载时必须清掉。
    // 默认不写：交互安装由完成页勾选框决定，静默安装要显式 /autostart。
    const string AutostartKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string AutostartValueName = "QQDeepSeekBot";

    // WebView2 运行时：Evergreen 运行时在 EdgeUpdate\Clients 下登记 pv（32/64 位各一处，HKLM/HKCU 都要看）
    const string WebView2KeyWow = @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const string WebView2Key = @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const string WebView2Url = "https://developer.microsoft.com/microsoft-edge/webview2/";

    static string _logPath;

    // ── 入口 ────────────────────────────────────────────────────────────────
    [STAThread]
    static int Main(string[] args)
    {
        bool silent = HasFlag(args, "/S") || HasFlag(args, "/silent");
        bool uninstall = HasFlag(args, "/uninstall");
        bool force = HasFlag(args, "/force");
        bool noLaunch = HasFlag(args, "/nolaunch");
        bool autoStart = HasFlag(args, "/autostart");
        string dir = ArgValue(args, "/D=");
        string portArg = ArgValue(args, "/port=");
        string ownerArg = ArgValue(args, "/owner=");

        _logPath = Path.Combine(Path.GetTempPath(), LogName);
        Log("==== " + (uninstall ? "uninstall" : "install") + " start, args=" + string.Join(" ", args));

        try
        {
            if (uninstall) return DoUninstall(silent, dir);
            return DoInstall(silent, dir, force, noLaunch, portArg, ownerArg, autoStart);
        }
        catch (Exception ex)
        {
            Log("FATAL " + ex.GetType().Name + ": " + ex.Message);
            Log(ex.StackTrace);
            if (!silent) MessageBox.Show("安装/卸载失败：\r\n" + ex.Message + "\r\n\r\n日志：" + _logPath,
                ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 4;
        }
    }

    // ── 安装 ────────────────────────────────────────────────────────────────
    static int DoInstall(bool silent, string dirArg, bool force, bool noLaunch, string portArg, string ownerArg, bool autoStart)
    {
        string dir = string.IsNullOrEmpty(dirArg)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QQDeepSeekBot")
            : Path.GetFullPath(dirArg);

        string wv = DetectWebView2();
        Log("install dir=" + dir + " webview2=" + (wv == null ? "MISSING" : wv));

        if (!silent)
        {
            using (InstallForm f = new InstallForm(dir, wv))
            {
                if (f.ShowDialog() != DialogResult.OK) { Log("user cancelled at welcome page"); return 0; }
                dir = f.InstallDir;
            }
        }

        // WebView2 缺失：明确提示 + 官方下载入口，绝不静默失败
        if (wv == null)
        {
            Log("webview2 missing -> abort (exit 3)");
            if (!silent)
            {
                DialogResult r = MessageBox.Show(
                    "没有检测到 Microsoft Edge WebView2 运行时。\r\n\r\n" +
                    "QQ DeepSeek Bot 的客户端窗口基于 WebView2，缺少它无法启动。\r\n" +
                    "请先安装运行时（免费，约 2 MB）：\r\n" + WebView2Url + "\r\n\r\n" +
                    "是否现在打开下载页？",
                    ProductName + " · 缺少 WebView2 运行时", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes) SafeOpen(WebView2Url);
            }
            return 3;
        }

        string error;
        string warning;
        if (!InstallSteps(dir, force, portArg, ownerArg, out error, out warning))
        {
            Log("install FAILED: " + error);
            if (!silent) MessageBox.Show("安装失败：" + error + "\r\n\r\n日志：" + _logPath, ProductName,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 4;
        }

        Log("install OK");
        // 桥接没起来不算安装失败（文件都落好了），但必须让用户看见原因，不能静默
        if (warning != null && !silent)
        {
            MessageBox.Show(warning, ProductName + " · 需要手动处理", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        if (!silent)
        {
            using (DoneForm f = new DoneForm(dir, NotAffiliated, autoStart))
            {
                f.ShowDialog();
                // 完成页勾选框是最终决定：勾了写 Run 键；取消勾选/本来没勾则清掉（别留旧键）
                if (f.AutoStart) { if (!WriteAutostart(dir)) Log("WARN autostart not written"); }
                else RemoveAutostart();
                if (f.LaunchNow) SafeStart(Path.Combine(dir, ExeName), dir);
            }
        }
        else
        {
            // 静默安装默认不碰 Run 键，避免脚本批量装时偷偷开机自启
            if (autoStart) { if (!WriteAutostart(dir)) Log("WARN autostart not written"); }
            else Log("autostart: off (default; pass /autostart to enable)");
            if (!noLaunch) Log("silent mode: not auto-launching (pass /nolaunch to silence this note)");
        }
        return 0;
    }

    static bool InstallSteps(string dir, bool force, string portArg, string ownerArg, out string error, out string warning)
    {
        error = null;
        warning = null;
        try
        {
            Log("step 1/8 create dir");
            Directory.CreateDirectory(dir);

            // 升级/重装时，正在运行的桥接 node.exe 会锁住安装目录里的文件（尤其 node.exe 本体），
            // 直接覆盖会失败。先停掉「从本目录启动的进程」再解压。
            Log("step 1.5/8 stop processes running from install dir");
            StopOwnProcesses(dir);

            Log("step 2/8 extract payload");
            ExtractPayload(dir, force);

            Log("step 3/8 config.json");
            string tpl = Path.Combine(dir, "config.template.json");
            string cfg = Path.Combine(dir, "config.json");
            if (File.Exists(tpl))
            {
                if (!File.Exists(cfg))
                {
                    File.Copy(tpl, cfg);
                    Log("config.json created from template");
                    if (!string.IsNullOrEmpty(portArg))
                    {
                        int port;
                        if (int.TryParse(portArg, out port) && port > 0 && port < 65536)
                        {
                            // 只改写新生成的配置：给测试/共存留一个可参数化的端口
                            string text = File.ReadAllText(cfg, Encoding.UTF8);
                            text = Regex.Replace(text, "\"consolePort\"\\s*:\\s*\\d+", "\"consolePort\": " + port);
                            File.WriteAllText(cfg, text, new UTF8Encoding(false));
                            Log("consolePort overridden to " + port);
                        }
                        else Log("WARN ignoring bad /port= value: " + portArg);
                    }
                    if (!string.IsNullOrEmpty(ownerArg))
                    {
                        long owner;
                        if (long.TryParse(ownerArg, out owner) && owner > 0)
                        {
                            string text2 = File.ReadAllText(cfg, Encoding.UTF8);
                            text2 = Regex.Replace(text2, "\"ownerQQ\"\\s*:\\s*\"[^\"]*\"", "\"ownerQQ\": " + owner);
                            File.WriteAllText(cfg, text2, new UTF8Encoding(false));
                            Log("ownerQQ overridden by /owner=");
                        }
                        else Log("WARN ignoring bad /owner= value: " + ownerArg);
                    }
                }
                else Log("config.json kept (idempotent re-install, user edits preserved)");
            }
            else Log("WARN config.template.json missing in payload");

            Log("step 4/8 marker");
            string ver = ReadVersion();
            File.WriteAllText(Path.Combine(dir, MarkerName),
                "{\"product\":\"" + ProductName + "\",\"version\":\"" + ver + "\",\"installedAt\":\"" +
                DateTime.Now.ToString("o") + "\"}", new UTF8Encoding(false));

            Log("step 5/8 Uninstall.exe");
            string self = Assembly.GetExecutingAssembly().Location;
            string unins = Path.Combine(dir, UninstallExeName);
            if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(unins), StringComparison.OrdinalIgnoreCase))
                File.Copy(self, unins, true);

            Log("step 6/8 shortcuts");
            string exe = Path.Combine(dir, ExeName);
            // w6 的 T20 宿主需要 --root <安装目录> 才知道去哪找 src/bridge.js；
            // 写进快捷方式参数，用户双击就不用手动带参数。
            string linkArgs = "--root \"" + dir + "\"";
            CreateShortcut(Path.Combine(DesktopDir(), ShortcutName), exe, dir, linkArgs);
            CreateShortcut(Path.Combine(ProgramsDir(), ShortcutName), exe, dir, linkArgs);

            Log("step 7/8 uninstall registry (HKCU)");
            WriteUninstallKey(dir, exe, ver);

            Log("step 8/8 post-install (PowerShell)");
            int pi = RunPostInstall(dir);
            if (pi != 0)
            {
                warning = "桥接没有自动起来（post-install 退出码 " + pi + "）。\r\n\r\n" +
                          "文件已全部装好，可以稍后手动启动：双击安装目录里的 start.bat，\r\n" +
                          "或命令行执行 node.exe src\\bridge.js。\r\n\r\n" +
                          "原因写在：" + Path.Combine(dir, @"logs\post-install.log");
            }
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            Log("step failed: " + ex);
            return false;
        }
    }

    static void ExtractPayload(string dir, bool force)
    {
        Assembly asm = Assembly.GetExecutingAssembly();
        using (Stream s = asm.GetManifestResourceStream("payload.zip"))
        {
            if (s == null) throw new InvalidOperationException("安装包损坏：内嵌载荷 payload.zip 不存在");
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                int n = 0;
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    // 目录条目（"assets/" 或 .NET Framework 写出来的 "assets\"）必须
                    // 只建目录，交给 ExtractToFile 会 DirectoryNotFoundException。
                    string raw = e.FullName;
                    if (raw.EndsWith("/") || raw.EndsWith("\\") || e.Name.Length == 0)
                    {
                        string dirRel = raw.TrimEnd('/', '\\').Replace('/', Path.DirectorySeparatorChar);
                        if (dirRel.Length > 0) Directory.CreateDirectory(Path.Combine(dir, dirRel));
                        continue;
                    }
                    string rel = raw.Replace('/', Path.DirectorySeparatorChar);
                    string dest = Path.Combine(dir, rel);
                    // 幂等：配置文件只在不存在时落地，二次安装不覆盖用户改过的值
                    if (!force && string.Equals(rel, "config.json", StringComparison.OrdinalIgnoreCase) && File.Exists(dest))
                    { Log("keep existing " + rel); continue; }
                    string parent = Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    e.ExtractToFile(dest, true);
                    n++;
                }
                Log("extracted " + n + " files");
            }
        }
    }

    static void WriteUninstallKey(string dir, string exe, string ver)
    {
        long size = 0;
        try
        {
            foreach (FileInfo f in new DirectoryInfo(dir).GetFiles("*", SearchOption.AllDirectories)) size += f.Length;
        }
        catch (Exception ex) { Log("WARN size calc: " + ex.Message); }

        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKeyPath))
        {
            k.SetValue("DisplayName", ProductName);
            k.SetValue("DisplayVersion", ver);
            k.SetValue("Publisher", ProductName);
            k.SetValue("DisplayIcon", exe + ",0");
            k.SetValue("InstallLocation", dir);
            k.SetValue("UninstallString", "\"" + Path.Combine(dir, UninstallExeName) + "\" /uninstall");
            k.SetValue("QuietUninstallString", "\"" + Path.Combine(dir, UninstallExeName) + "\" /uninstall /S");
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, size / 1024), RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
        Log("registry key written: HKCU\\" + UninstallKeyPath);
    }

    // ── 开机自启（可选，默认关）──────────────────────────────────────────────
    // 值与桌面壳的 Autostart 约定一致：命令带 --root <安装目录>，壳才知道去哪找 src/bridge.js。
    static bool WriteAutostart(string dir)
    {
        try
        {
            string exe = Path.Combine(dir, ExeName);
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(AutostartKeyPath))
            {
                k.SetValue(AutostartValueName, "\"" + exe + "\" --root \"" + dir + "\" --autostart");
            }
            Log("autostart: on (HKCU\\" + AutostartKeyPath + "\\" + AutostartValueName + ")");
            return true;
        }
        catch (Exception ex) { Log("WARN autostart write: " + ex.Message); return false; }
    }

    static bool RemoveAutostart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(AutostartKeyPath, true))
            {
                if (k == null) { Log("autostart: key absent"); return true; }
                k.DeleteValue(AutostartValueName, false);
            }
            Log("autostart: off");
            return true;
        }
        catch (Exception ex) { Log("WARN autostart remove: " + ex.Message); return false; }
    }

    static int RunPostInstall(string dir)
    {
        string ps1 = Path.Combine(dir, Path.Combine("ops", "post-install.ps1"));
        if (!File.Exists(ps1)) { Log("no ops/post-install.ps1 in payload, skip"); return 0; }
        string outLog = Path.Combine(dir, Path.Combine("logs", "post-install-console.log"));
        try
        {
            // 不用管道读子进程输出：post-install 会拉起常驻的 node.exe，子进程继承管道写端后
            // ReadToEnd 永远等不到 EOF（安装器看起来"卡住"）。改成 cmd 重定向到文件，只等进程退出。
            Directory.CreateDirectory(Path.GetDirectoryName(outLog));
            string cmdLine = "/c \"\"powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"" + ps1 +
                             "\" > \"" + outLog + "\" 2>&1\"";
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmdLine)
            { WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true };
            using (Process p = Process.Start(psi))
            {
                if (!p.WaitForExit(180000)) { p.Kill(); Log("WARN post-install timeout"); return 5; }
                Log("post-install exit=" + p.ExitCode);
                try
                {
                    // 桥接 node 继承了控制台日志的句柄并一直持有，用 File.ReadAllText 会撞
                    // "正由另一进程使用"。这里用 FileShare.ReadWrite 读，失败也不影响安装。
                    string text = "";
                    using (FileStream fs = new FileStream(outLog, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                    { text = sr.ReadToEnd(); }
                    if (text.Trim().Length > 0) Log("post-install out: " + text.Trim());
                }
                catch (Exception ex) { Log("WARN read post-install output: " + ex.Message); }
                if (p.ExitCode != 0) Log("WARN post-install non-zero (installed files are fine, bridge start failed)");
                return p.ExitCode;
            }
        }
        catch (Exception ex) { Log("WARN post-install: " + ex.Message); return 6; }
    }

    // ── 卸载 ────────────────────────────────────────────────────────────────
    static int DoUninstall(bool silent, string dirArg)
    {
        string dir = !string.IsNullOrEmpty(dirArg) ? Path.GetFullPath(dirArg) : FindInstallDir();
        Log("uninstall dir=" + dir);
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
        {
            Log("install dir not found -> nothing to do");
            if (!silent) MessageBox.Show("找不到安装目录，可能已经卸载。", ProductName);
            return 0;
        }

        if (!silent)
        {
            DialogResult r = MessageBox.Show(
                "确定卸载 " + ProductName + "？\r\n\r\n" +
                "将停止它启动的进程，删除桌面/开始菜单快捷方式、HKCU 卸载项与安装目录：\r\n" + dir +
                "\r\n\r\n" + NotAffiliated,
                ProductName + " · 卸载确认", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) { Log("user cancelled at uninstall confirm"); return 0; }
        }

        int failed = 0;
        if (!StopOwnProcesses(dir)) failed++;
        if (!RemoveAutostart()) failed++;
        if (!RemoveShortcuts()) failed++;
        if (!RemoveUninstallKey()) failed++;
        if (!DeleteDirDeferred(dir)) failed++;

        if (failed > 0) Log("uninstall finished with " + failed + " problem(s)");
        else Log("uninstall OK");
        if (!silent && failed == 0) MessageBox.Show("已卸载。\r\n\r\n" + NotAffiliated, ProductName);
        return failed == 0 ? 0 : 5;
    }

    static string FindInstallDir()
    {
        try
        {
            string own = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (!string.IsNullOrEmpty(own) && File.Exists(Path.Combine(own, ExeName))) return own;
        }
        catch (Exception ex) { Log("WARN own dir: " + ex.Message); }
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UninstallKeyPath))
                if (k != null) return k.GetValue("InstallLocation") as string;
        }
        catch (Exception ex) { Log("WARN registry dir: " + ex.Message); }
        return null;
    }

    static bool StopOwnProcesses(string dir)
    {
        bool ok = true;
        foreach (Process p in Process.GetProcesses())
        {
            try
            {
                if (p.Id == Process.GetCurrentProcess().Id) continue;
                string path = p.MainModule.FileName;
                if (path != null && path.StartsWith(dir, StringComparison.OrdinalIgnoreCase))
                {
                    Log("stop pid=" + p.Id + " " + path);
                    p.Kill();
                    p.WaitForExit(5000);
                }
            }
            catch (Exception ex) { Log("WARN inspect pid=" + p.Id + ": " + ex.GetType().Name); }
        }
        return ok;
    }

    static bool RemoveShortcuts()
    {
        bool ok = true;
        string[] paths = new string[]
        {
            Path.Combine(DesktopDir(), ShortcutName),
            Path.Combine(ProgramsDir(), ShortcutName)
        };
        foreach (string p in paths)
        {
            try
            {
                if (File.Exists(p)) { File.Delete(p); Log("removed " + p); }
                else Log("shortcut absent: " + p);
            }
            catch (Exception ex) { ok = false; Log("FAIL remove " + p + ": " + ex.Message); }
        }
        return ok;
    }

    static bool RemoveUninstallKey()
    {
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKeyPath, false);
            Log("removed HKCU\\" + UninstallKeyPath);
            return true;
        }
        catch (Exception ex) { Log("FAIL registry delete: " + ex.Message); return false; }
    }

    // 自己就在安装目录里，Windows 不允许删正在运行的 exe —— 交给一个延迟 cmd：
    // 等本进程退出（ping 3 次 ≈ 2s）后 rmdir /s /q 整个目录。
    static bool DeleteDirDeferred(string dir)
    {
        try
        {
            string cmd = "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + dir + "\"";
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmd)
            { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
            Process.Start(psi);
            Log("scheduled directory removal: " + dir);
            return true;
        }
        catch (Exception ex) { Log("FAIL schedule rmdir: " + ex.Message); return false; }
    }

    // ── 环境探测 ────────────────────────────────────────────────────────────
    static string DetectWebView2()
    {
        string pv = ReadPv(Registry.LocalMachine, WebView2KeyWow)
                 ?? ReadPv(Registry.LocalMachine, WebView2Key)
                 ?? ReadPv(Registry.CurrentUser, WebView2KeyWow)
                 ?? ReadPv(Registry.CurrentUser, WebView2Key);
        if (pv == "0.0.0.0") return null;   // 官方约定：0.0.0.0 表示"已安装但无运行时"
        return pv;
    }

    static string ReadPv(RegistryKey root, string path)
    {
        try
        {
            using (RegistryKey k = root.OpenSubKey(path))
            {
                if (k == null) return null;
                string pv = k.GetValue("pv") as string;
                return string.IsNullOrEmpty(pv) ? null : pv;
            }
        }
        catch (Exception ex) { Log("WARN webview2 probe " + path + ": " + ex.Message); return null; }
    }

    static string DesktopDir()
    {
        return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
    }

    static string ProgramsDir()
    {
        return Environment.GetFolderPath(Environment.SpecialFolder.Programs);
    }

    // ── 快捷方式（WScript.Shell，避免额外引用 COM interop 程序集）────────────
    static void CreateShortcut(string lnkPath, string target, string workDir, string arguments)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        if (t == null) throw new InvalidOperationException("WScript.Shell 不可用");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
        lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
        lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { arguments ?? "" });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { ProductName });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        Log("shortcut -> " + lnkPath + " => " + target);
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    static string ReadVersion()
    {
        try
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("version.txt"))
            {
                if (s == null) return "0.0.0";
                using (StreamReader r = new StreamReader(s)) return r.ReadToEnd().Trim();
            }
        }
        catch (Exception ex) { Log("WARN version: " + ex.Message); return "0.0.0"; }
    }

    static bool HasFlag(string[] args, string flag)
    {
        foreach (string a in args)
            if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    static string ArgValue(string[] args, string prefix)
    {
        foreach (string a in args)
            if (a.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                string v = a.Substring(prefix.Length).Trim();
                if (v.Length >= 2 && v[0] == '"' && v[v.Length - 1] == '"') v = v.Substring(1, v.Length - 2);
                return v;
            }
        return null;
    }

    static void SafeOpen(string url)
    {
        try { Process.Start(url); } catch (Exception ex) { Log("WARN open url: " + ex.Message); }
    }

    static void SafeStart(string exe, string workDir)
    {
        try
        {
            if (!File.Exists(exe)) { Log("WARN client exe missing: " + exe); return; }
            ProcessStartInfo psi = new ProcessStartInfo(exe) { WorkingDirectory = workDir, UseShellExecute = true };
            Process.Start(psi);
            Log("launched " + exe);
        }
        catch (Exception ex) { Log("WARN launch: " + ex.Message); }
    }

    static void Log(string msg)
    {
        try
        {
            string line = DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n";
            File.AppendAllText(_logPath, line, new UTF8Encoding(false));
        }
        catch { /* 日志写不进也不能让安装器崩，日志本身是辅助信息 */ }
    }
}

// ── 欢迎 / 完成页（极简 WinForms，不引第三方 UI 库）────────────────────────
class InstallForm : Form
{
    public string InstallDir;
    readonly TextBox _txt;

    public InstallForm(string dir, string webView2)
    {
        InstallDir = dir;
        Text = "QQ DeepSeek Bot 安装";
        ClientSize = new Size(560, 300);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;

        Controls.Add(new Label { Text = "QQ DeepSeek Bot", Font = new Font("Segoe UI", 16F, FontStyle.Bold), Left = 20, Top = 16, Width = 500 });
        Controls.Add(new Label { Text = "把 QQ 机器人的桥接、控制台、DSH 预设与客户端窗口装到本机。", Left = 20, Top = 56, Width = 520 });

        Controls.Add(new Label { Text = "安装目录：", Left = 20, Top = 96, Width = 90 });
        _txt = new TextBox { Text = dir, Left = 110, Top = 92, Width = 420 };
        Controls.Add(_txt);

        string wvText = webView2 == null
            ? "WebView2 运行时：未检测到（安装器会提示下载）"
            : "WebView2 运行时：已就绪 " + webView2;
        Controls.Add(new Label { Text = wvText, Left = 20, Top = 132, Width = 520,
            ForeColor = webView2 == null ? Color.Firebrick : Color.ForestGreen });

        Controls.Add(new Label { Text = "非腾讯 / 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）",
            Left = 20, Top = 200, Width = 520, ForeColor = Color.DimGray });

        Button ok = new Button { Text = "安装", Left = 360, Top = 246, Width = 80, DialogResult = DialogResult.OK };
        Button cancel = new Button { Text = "取消", Left = 450, Top = 246, Width = 80, DialogResult = DialogResult.Cancel };
        Controls.Add(ok); Controls.Add(cancel);
        AcceptButton = ok; CancelButton = cancel;

        ok.Click += delegate { InstallDir = _txt.Text.Trim(); };
    }
}

class DoneForm : Form
{
    public bool LaunchNow;
    public bool AutoStart;

    public DoneForm(string dir, string notAffiliated, bool autoStart)
    {
        Text = "QQ DeepSeek Bot 安装完成";
        ClientSize = new Size(560, 380);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;

        Controls.Add(new Label { Text = "安装完成", Font = new Font("Segoe UI", 16F, FontStyle.Bold), Left = 20, Top = 16, Width = 500 });
        Controls.Add(new Label { Text = "安装到：" + dir + "\r\n桌面与开始菜单快捷方式已创建，目标就是客户端 exe 本身。",
            Left = 20, Top = 62, Width = 520, Height = 60 });
        // 本项目是「QQ ↔ DSH 桥接」：没有 DSH 时窗口能开、但连不上大脑。
        // 这句必须写在完成页，不能让用户装完一脸问号。
        Controls.Add(new Label { Text = "前置依赖：DeepSeek Harness（DSH）与一个 QQ 网关（SnowLuma/OneBot）。\r\n" +
            "没装或没启动 DSH 时，客户端会显示「DSH 未连接」——那不是装坏了。",
            Left = 20, Top = 136, Width = 520, Height = 44, ForeColor = Color.DarkSlateBlue });

        // 可选开关，不强制：勾了写 HKCU Run 键，登录后自动开壳（壳会自己拉起桥接）
        CheckBox autostart = new CheckBox
        {
            Text = "开机自动启动（登录后自动打开客户端；取消勾选也能从托盘/快捷方式手动启动）",
            Left = 20, Top = 192, Width = 520, Height = 24, Checked = autoStart
        };
        Controls.Add(autostart);
        AutoStart = autoStart;

        Controls.Add(new Label { Text = notAffiliated, Left = 20, Top = 226, Width = 520, ForeColor = Color.DimGray });

        Button run = new Button { Text = "启动", Left = 360, Top = 296, Width = 80, DialogResult = DialogResult.Yes };
        Button close = new Button { Text = "关闭", Left = 450, Top = 296, Width = 80, DialogResult = DialogResult.No };
        Controls.Add(run); Controls.Add(close);
        run.Click += delegate { LaunchNow = true; AutoStart = autostart.Checked; };
        close.Click += delegate { AutoStart = autostart.Checked; };
        AcceptButton = run; CancelButton = close;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // 点右上角 X 也得记住勾选框状态，否则「取消勾选」会被静默忽略
        foreach (Control c in Controls)
        {
            CheckBox cb = c as CheckBox;
            if (cb != null) AutoStart = cb.Checked;
        }
        base.OnFormClosing(e);
    }
}
