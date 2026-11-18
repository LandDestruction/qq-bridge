@echo off
rem start-bridge-forever.bat -- entry point for autostart.
rem qq-bridge already supervises itself: start.bat's ":loop" restarts node after a 5s
rem timeout, and state\bridge.lock rejects a second instance. This wrapper only makes
rem sure start.bat runs in its OWN process tree (never as a child of DSH), because a
rem bridge spawned under the DSH agent dies with DSH.
rem
rem Place at logon via the HKCU Run key pointing at start-bridge-hidden.vbs.
cd /d "%~dp0"
call start.bat
