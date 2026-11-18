// Brand.cs —— 品牌名的唯一定义处。
//
// 为什么单独一个文件：品牌名是「暂定」的（用户说过以后可能改），如果散落在窗体标题、
// 托盘 tooltip、数据目录、安装器快捷方式里，改名就得全仓库搜。这里收成常量，
// 其它 .cs 一律引用 Brand.*，scripts/test-desktop-host.mjs 有一条断言守住这件事。
namespace QdbDesktop
{
    internal static class Brand
    {
        // 展示名：窗口标题、托盘 tooltip、关于框
        internal const string Name = "QQ DeepSeek Bot";

        // 可执行文件名：构建脚本用它命名产物（测试会核对两者一致）
        internal const string ExeName = "QQDeepSeekBot.exe";

        // 版本号：关于框显示 vX.Y.Z
        internal const string Version = "1.0.0";

        // 数据目录名（%LOCALAPPDATA%\QQDeepSeekBot）：窗口位置、WebView2 user data
        internal const string AppDataDirName = "QQDeepSeekBot";

        // 法律声明：关于框与 README 都照抄这一句，别各写各的
        internal const string Trademark = "非腾讯 / 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）";
    }
}
