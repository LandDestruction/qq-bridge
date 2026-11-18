# WinRT OCR：Windows 自带 Windows.Media.Ocr，不需要装 tesseract。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/lib/ocr-image.ps1 -Path <图片>
# 输出：UTF-8 JSON 一行到 stdout。成功 {"ok":true,"langs":[...],"lines":[{"text","x","y"}]}，
#       失败 {"ok":false,"error":"..."}。坐标取每行 Line.Words 第一个词的 BoundingRect 左上角，供按行排序/拼接。
param(
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'
# 中文必须显式设 UTF8，否则 ConvertTo-Json 出来是 ANSI，Node 侧 JSON.parse 直接乱码/失败。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-OcrJson([hashtable]$payload) {
  Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
}

if (-not (Test-Path -LiteralPath $Path)) {
  Write-OcrJson @{ ok = $false; error = "找不到图片文件：$Path" }
  exit 0
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  # WinRT 类型在 PowerShell 里要先按 TypeSpec 显式加载，否则 [Windows.Storage.StorageFile] 会报「找不到类型」。
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  # WinRT 的 IAsyncOperation<T> 在 .NET 里没有同步等待入口，用 AsTask<T> 反射桥接。
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
  }

  $asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
    })[0]
  function AwaitAction($WinRtAction) {
    $netTask = $asTaskAction.Invoke($null, @($WinRtAction))
    $netTask.Wait(-1) | Out-Null
  }

  # GetFileFromPathAsync 只认绝对路径（相对路径会抛 AggregateException）
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  # 引擎选择顺序：ja（装了日文包最好，商品名常带假名）→ 用户配置语言 → en-US。
  $engine = $null
  foreach ($tag in @('ja', 'ja-JP')) {
    try {
      $lang = [Windows.Globalization.Language]::new($tag)
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    } catch { $engine = $null }
    if ($null -ne $engine) { break }
  }
  if ($null -eq $engine) {
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
  }
  if ($null -eq $engine) {
    try {
      $lang = [Windows.Globalization.Language]::new('en-US')
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    } catch { $engine = $null }
  }
  if ($null -eq $engine) {
    Write-OcrJson @{ ok = $false; error = '这台机器没有可用的 OCR 语言包' }
    exit 0
  }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  # 用静态表：实例上的 AvailableRecognizerLanguages 在 PS 里取出来是 null，静态属性才稳定。
  $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag } | Where-Object { $_ } | Sort-Object -Unique)
  $engineTag = ''
  try { $engineTag = $engine.RecognizerLanguage.LanguageTag } catch { $engineTag = '' }
  $lines = @()
  foreach ($line in $result.Lines) {
    $x = 0.0
    $y = 0.0
    # WinRT 的 IReadOnlyList 在 PS 里不能直接 .Count/.indexer（会变成成员枚举），先落成普通数组。
    $words = @($line.Words)
    if ($words.Count -gt 0) {
      $rect = $words[0].BoundingRect
      $x = [math]::Round([double]$rect.X, 1)
      $y = [math]::Round([double]$rect.Y, 1)
    }
    $lines += @{ text = $line.Text; x = $x; y = $y }
  }
  Write-OcrJson @{ ok = $true; engine = $engineTag; langs = $langs; lines = $lines }
  exit 0
} catch {
  $inner = $_.Exception
  while ($inner.InnerException) { $inner = $inner.InnerException }
  Write-OcrJson @{ ok = $false; error = "OCR 失败：$($inner.Message)" }
  exit 0
}
