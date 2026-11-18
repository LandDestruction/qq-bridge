// UpdateVersion.cs —— 更新检查的纯逻辑：版本比较 + 更新源 JSON 解析。
//
// 为什么单独一个文件：这段逻辑必须能被真跑。scripts/test-desktop-host.mjs 会用
// csc 把本文件和一个临时 Main 一起编成控制台程序，直接验证
//   1.10.0 > 1.9.3、2.0.0-beta 与 2.0.0 同版、坏版本号返回 null（调用方跳过并记日志）。
// 所以这里不引 WinForms、不碰文件/网络，只吃字符串。
//
// C# 5（csc 4.8 上限）：不要写 $""、?.、nameof。
using System;
using System.Text.RegularExpressions;

namespace QdbDesktop
{
    // 更新源返回的 JSON：{version, url, notes?, sha256?, minVersion?}
    internal sealed class UpdateInfo
    {
        internal string Version;
        internal string Url;
        internal string Notes;
        internal string Sha256;
        internal string MinVersion;
    }

    internal static class UpdateVersion
    {
        // 语义化 x.y.z 逐段比：每段取前导数字（"10-beta" -> 10），缺失段按 0，构建元数据(+xxx)忽略。
        // 返回 1 / -1 / 0；任一侧解析不出数字段就返回 null —— 调用方按「不认这个版本号」跳过并记日志，
        // 绝不当成「有更新」去弹安装包。
        internal static int? Compare(string left, string right)
        {
            int[] a = Parse(left);
            int[] b = Parse(right);
            if (a == null || b == null) { return null; }
            int n = Math.Max(a.Length, b.Length);
            for (int i = 0; i < n; i++)
            {
                int x = i < a.Length ? a[i] : 0;
                int y = i < b.Length ? b[i] : 0;
                if (x > y) { return 1; }
                if (x < y) { return -1; }
            }
            return 0;
        }

        // "v1.10.0-beta+abc" -> {1,10,0}；空串 / 无数字段 / 空段（"1..2"）-> null。
        private static int[] Parse(string text)
        {
            if (text == null) { return null; }
            string s = text.Trim();
            if (s.Length == 0) { return null; }
            if (s[0] == 'v' || s[0] == 'V') { s = s.Substring(1).Trim(); }
            if (s.Length == 0) { return null; }
            // 先切构建元数据，再切预发布后缀；两段都不参与比较。
            int plus = s.IndexOf('+');
            if (plus >= 0) { s = s.Substring(0, plus); }
            int dash = s.IndexOf('-');
            if (dash >= 0) { s = s.Substring(0, dash); }
            string[] parts = s.Split('.');
            int[] nums = new int[parts.Length];
            for (int i = 0; i < parts.Length; i++)
            {
                Match m = Regex.Match(parts[i], "^[0-9]{1,9}");
                if (!m.Success) { return null; }
                nums[i] = int.Parse(m.Value);
            }
            return nums;
        }

        // 解析更新源 JSON。只认 http(s)、version/url 必须存在且 version 可解析，
        // 其余字段（notes/sha256/minVersion）可选。任何不合法都返回 false，让调用方安静跳过。
        internal static bool TryParse(string json, out UpdateInfo info)
        {
            info = null;
            if (string.IsNullOrEmpty(json)) { return false; }
            if (json.Length > 65536) { return false; }
            string version = Field(json, "version");
            string url = Field(json, "url");
            if (string.IsNullOrEmpty(version) || string.IsNullOrEmpty(url)) { return false; }
            if (Parse(version) == null) { return false; }
            if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) { return false; }
            UpdateInfo parsed = new UpdateInfo();
            parsed.Version = version.Trim();
            parsed.Url = url.Trim();
            parsed.Notes = Field(json, "notes");
            parsed.Sha256 = Field(json, "sha256");
            parsed.MinVersion = Field(json, "minVersion");
            info = parsed;
            return true;
        }

        // 极简 JSON 取值：只取顶层字符串字段，够更新源这种 5 字段的小对象用，不引 JSON 库。
        private static string Field(string json, string name)
        {
            Match m = Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) { return null; }
            string s = m.Groups[1].Value;
            s = s.Replace("\\\\", "\u0001").Replace("\\\"", "\"").Replace("\\n", "\n").Replace("\u0001", "\\");
            return s;
        }
    }
}
