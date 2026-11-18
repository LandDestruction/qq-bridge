// QQ DeepSeek Bot 占位客户端（stub）——只用于把 W2 的安装/卸载链路跑通。
// 真正的 WebView2 宿主由 w6 的 T20 提供，产物路径固定 dist\desktop\QQDeepSeekBot.exe；
// T20 落地后直接用真 exe 覆盖同路径，安装器代码与包结构都不需要改。
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class StubClient
{
    const string NotAffiliated = "非腾讯 / 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）";

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            string logDir = Path.Combine(baseDir, "logs");
            Directory.CreateDirectory(logDir);
            File.AppendAllText(Path.Combine(logDir, "client-start.log"),
                DateTime.Now.ToString("o") + " stub client started, basedir=" + baseDir + "\r\n",
                new UTF8Encoding(false));
        }
        catch (Exception ex)
        {
            // 启动日志是验收证据，写失败时至少弹到窗口里，不静默
            MessageBox.Show("写启动日志失败：" + ex.Message, "QQ DeepSeek Bot (stub)");
        }

        Form f = new Form();
        f.Text = "QQ DeepSeek Bot（stub 客户端）";
        f.ClientSize = new Size(560, 260);
        f.StartPosition = FormStartPosition.CenterScreen;

        Label title = new Label();
        title.Text = "QQ DeepSeek Bot";
        title.Font = new Font("Segoe UI", 18F, FontStyle.Bold);
        title.SetBounds(24, 20, 500, 40);
        f.Controls.Add(title);

        Label body = new Label();
        body.Text = "这是 W2 安装链路的占位客户端（stub）。\r\n" +
                    "真正的 WebView2 宿主由 w6 T20 提供，产物固定为 dist\\desktop\\QQDeepSeekBot.exe。\r\n\r\n" +
                    "启动日志：" + Path.Combine(baseDir, "logs", "client-start.log");
        body.SetBounds(24, 70, 510, 110);
        f.Controls.Add(body);

        Label note = new Label();
        note.Text = NotAffiliated;
        note.ForeColor = Color.DimGray;
        note.SetBounds(24, 210, 510, 30);
        f.Controls.Add(note);

        Application.Run(f);
    }
}
