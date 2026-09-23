@echo off
setlocal EnableExtensions
rem ============================================================
rem AHP 远控启动器：
rem   1. 生成/读取 agent host 连接 token（%USERPROFILE%\.pocket-copilot\token.txt）
rem   2. 后台启动 pocket-copilot daemon（8765，已运行则跳过）
rem   3. 注入 agent host 环境变量并启动 VS Code（8081）
rem
rem token 管理：
rem  - 首次运行自动生成随机 token（GUID，128 位熵），持久化到 token.txt
rem    （daemon 读取同一文件，作为唯一事实源；token 永不出电脑）
rem  - 换 token：删除 token.txt 后完全重启 VS Code + daemon
rem
rem 注意：
rem  1. 环境变量只对"第一个"VS Code 进程生效（单实例转发机制）。
rem     若 VS Code 已在运行，需先完全退出再用本脚本启动。
rem  2. daemon 日志：%USERPROFILE%\.pocket-copilot\daemon.log
rem  3. 想收窄暴露面：把 0.0.0.0 改成 Tailscale IP。
rem ============================================================
set "POCKET_DIR=%USERPROFILE%\.pocket-copilot"
set "TOKEN_FILE=%POCKET_DIR%\token.txt"
rem 仓库根目录 = 脚本所在目录（仓库可任意挪位置）
set "PROJECT_DIR=%~dp0"

if exist "%TOKEN_FILE%" goto :read_token
if not exist "%POCKET_DIR%" mkdir "%POCKET_DIR%"
for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"`) do set "TOKEN=%%T"
> "%TOKEN_FILE%" echo %TOKEN%
echo 首次运行：已生成新 token 并保存到 %TOKEN_FILE%
goto :start_daemon

:read_token
set /p TOKEN=<"%TOKEN_FILE%"

:start_daemon
rem 后台启动 daemon（8765 端口被占用视为已在运行，跳过）
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath cmd.exe -ArgumentList '/c','cd /d %PROJECT_DIR% && npm run dev >> %POCKET_DIR%\daemon.log 2>&1' -WindowStyle Hidden; Write-Host 'daemon 已后台启动' } else { Write-Host 'daemon 已在运行（8765 端口占用）' }"

:launch
set VSCODE_AGENT_HOST_PORT=8081
set VSCODE_AGENT_HOST_HOST=0.0.0.0
set VSCODE_AGENT_HOST_CONNECTION_TOKEN=%TOKEN%
start "" "D:\App\Microsoft VS Code\Code.exe" %*
