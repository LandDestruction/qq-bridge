@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
rem stdout/stderr are appended to a FILE, never left on a pipe. If the reader of a pipe
rem disappears (hidden window closed, parent cmd killed) the next console.log throws EPIPE,
rem which surfaces as uncaughtException and kills the bridge -- observed 2026-10-24 02:39.
rem A file handle cannot break that way.
if not exist logs mkdir logs
rem 先起「面板常驻进程」：它只发页面 + 反代 /api，桥接挂了它也照常活着，
rem 这样用户看到的是「机器人已下线」而不是整个面板失联。已经在跑时它会自己退出。
start "" /min cmd /c "%~dp0start-console-host.bat"
:loop
rem rotate stdout log at 5MB, keep one previous copy.
rem Safe here: this runs before node starts, so no handle is open on the file yet.
if exist logs\bridge-stdout.log (
    for %%A in (logs\bridge-stdout.log) do (
        if %%~zA GTR 5242880 move /y logs\bridge-stdout.log logs\bridge-stdout.log.1 >nul
    )
)
node src/bridge.js >> logs\bridge-stdout.log 2>&1
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    rem NO pause here. Under the hidden scheduled-task launcher there is no console to press
    rem a key on, so "pause" would block the supervisor forever while holding the task in a
    rem zombie state with no bridge process alive (observed 2026-10-24 02:58).
    rem Keep an interactive pause only when a real console is attached.
    if "%QQBRIDGE_NO_PAUSE%"=="" (
        if not defined SESI_NO_CONSOLE pause
    )
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
