# GPT-SoVITS api_v2 keepalive: if 9880 answers, exit; otherwise start it hidden.
$ErrorActionPreference = 'SilentlyContinue'
$open = $false
try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 9880); $open = $c.Connected; $c.Close() } catch { }
if ($open) { Write-Output 'gsv already running'; exit 0 }
$root = '<本机路径>\GPT-SoVITS'
$py = '<本机路径>\venv310\Scripts\python.exe'
if (-not (Test-Path $py) -or -not (Test-Path (Join-Path $root 'api_v2.py'))) { Write-Output 'gsv not installed, skip'; exit 0 }
Start-Process -FilePath $py -ArgumentList 'api_v2.py','-a','127.0.0.1','-p','9880','-c','GPT_SoVITS/configs/tts_infer.yaml' -WorkingDirectory $root -WindowStyle Hidden
Write-Output 'gsv started'
