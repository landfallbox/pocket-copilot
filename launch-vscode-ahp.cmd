@echo off
setlocal EnableExtensions
rem ============================================================
rem AHP 远控启动器：注入 agent host WebSocket 端口环境变量后启动 VS Code
rem 手机 PWA 通过 bridge 配置端点获取 ws://<本机Tailscale-IP>:8081?tkn=<token>
rem
rem token 管理：
rem  - 首次运行自动生成随机 token（GUID，128 位熵），持久化到
rem    %USERPROFILE%\.copilot-bridge\token.txt
rem    （bridge 服务读取同一文件，作为配置端点的单一事实源）
rem  - 换 token：删除 token.txt 后完全重启 VS Code
rem
rem 注意：
rem  1. 环境变量只对"第一个"VS Code 进程生效（单实例转发机制）。
rem     若 VS Code 已在运行，需先完全退出再用本脚本启动。
rem  2. 想收窄暴露面：把 0.0.0.0 改成 Tailscale IP。
rem ============================================================
set "BRIDGE_DIR=%USERPROFILE%\.copilot-bridge"
set "TOKEN_FILE=%BRIDGE_DIR%\token.txt"

if exist "%TOKEN_FILE%" goto :read_token
if not exist "%BRIDGE_DIR%" mkdir "%BRIDGE_DIR%"
for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"`) do set "TOKEN=%%T"
> "%TOKEN_FILE%" echo %TOKEN%
echo 首次运行：已生成新 token 并保存到 %TOKEN_FILE%
goto :launch

:read_token
set /p TOKEN=<"%TOKEN_FILE%"

:launch
set VSCODE_AGENT_HOST_PORT=8081
set VSCODE_AGENT_HOST_HOST=0.0.0.0
set VSCODE_AGENT_HOST_CONNECTION_TOKEN=%TOKEN%
start "" "D:\App\Microsoft VS Code\Code.exe" %*
