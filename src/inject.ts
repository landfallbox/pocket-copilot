/**
 * UIA 写路径：通过 PowerShell + .NET UIAutomation 向 VS Code Copilot 会话注入消息。
 *
 * 机制（2026-08-31 Spike 2 实测验证）：
 * 1. 激活 VS Code 窗口（ShowWindow + SetForegroundWindow）
 * 2. 打开会话选择器（Pick Agent Session 按钮）→ 按标题匹配目标会话 → 点击
 * 3. 定位聊天输入框（Edit + 宽高 300-600x15-120 + 最底部 y 最大）
 * 4. 剪贴板粘贴 + Enter 发送
 *
 * 前提：VS Code settings.json 需设 "accessibilitySupport": "on"
 * 降级：若 Pick Agent Session 按钮不存在（极新会话），跳过切换直接注入当前面板
 */
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 注入结果 */
export interface InjectResult {
  ok: boolean;
  error?: string;
}

/**
 * 向指定项目的 Copilot 会话注入一条消息。
 * @param project 项目名（匹配 VS Code 窗口标题 `*<project> - Visual Studio Code*`）
 * @param sessionTitle 目标会话标题（SessionTitleStore 获取）
 * @param message 要发送的消息文本
 */
export async function injectMessage(
  project: string,
  sessionTitle: string,
  message: string,
): Promise<InjectResult> {
  const script = buildScript(project, sessionTitle, message);
  return runPowerShell(script);
}

/** 构建 PowerShell 脚本 */
function buildScript(
  project: string,
  sessionTitle: string,
  message: string,
): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const proj = esc(project);
  const title = esc(sessionTitle);
  const msg = esc(message);

  return `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32inj {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$ErrorActionPreference = 'Stop'
$project = '${proj}'
$title = '${title}'
$message = '${msg}'

# 1. 找 VS Code 窗口
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$win = $null
foreach ($w in $all) {
  $n = $w.Current.Name
  if ($n -like "*${proj} - Visual Studio Code*") { $win = $w }
}
if ($null -eq $win) {
  Write-Output 'ERROR:WINDOW_NOT_FOUND'
  exit 1
}

# 2. 激活窗口到前台
$wr = $win.Current.BoundingRectangle
$hwnd = $win.Current.NativeWindowHandle
[void][Win32inj]::ShowWindow($hwnd, 9)
[void][Win32inj]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500

# 3. 打开会话选择器并切换目标会话
$pickCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, 'Pick Agent Session')
$pick = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $pickCond)
if ($null -ne $pick) {
  $pick.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 800

  # 在会话列表中按标题前缀匹配（ListItem name 格式: "<title>, Local • <time>"）
  $listCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::List)
  $lists = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
  $target = $null
  foreach ($list in $lists) {
    $lr = $list.Current.BoundingRectangle
    if ($lr.IsEmpty -or [double]::IsInfinity($lr.X)) { continue }
    $relX = [int]($lr.X - $wr.X)
    if ($relX -lt 1300) { continue }
    $itemCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ListItem)
    $items = $list.FindAll([System.Windows.Automation.TreeScope]::Children, $itemCond)
    foreach ($item in $items) {
      $nm = [string]$item.Current.Name
      if ($nm.StartsWith("${title},")) { $target = $item; break }
    }
    if ($null -ne $target) { break }
  }
  if ($null -eq $target) {
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Write-Output 'ERROR:SESSION_NOT_FOUND'
    exit 1
  }
  $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 800
}

# 4. 定位聊天输入框（Edit + 宽高 300-600 x 15-120 + 最底部）
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)
$edits = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$input = $null
$bestY = -1
foreach ($e in $edits) {
  $r = $e.Current.BoundingRectangle
  if ($r.Width -lt 300 -or $r.Width -gt 600) { continue }
  if ($r.Height -lt 15 -or $r.Height -gt 120) { continue }
  if ([double]::IsInfinity($r.Y) -or [double]::IsNaN($r.Y)) { continue }
  if ($r.Y -gt $bestY) { $bestY = $r.Y; $input = $e }
}
if ($null -eq $input) {
  Write-Output 'ERROR:INPUT_NOT_FOUND'
  exit 1
}

# 5. 聚焦 + 剪贴板粘贴 + Enter 发送
$input.SetFocus()
Start-Sleep -Milliseconds 300
$saved = Get-Clipboard -Raw
Set-Clipboard -Value $message
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 300
Set-Clipboard -Value $saved

Write-Output 'OK'
`;
}

/** 运行 PowerShell 脚本（临时文件方式，避免 -Command 长度/转义问题） */
function runPowerShell(script: string): Promise<InjectResult> {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `bridge-inject-${Date.now()}.ps1`);
    try {
      writeFileSync(tmpFile, script, 'utf-8');
    } catch (err) {
      resolve({ ok: false, error: `write tmp: ${err}` });
      return;
    }

    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const cleanup = () => {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    };
    const finish = (r: InjectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(r);
    };

    // Windows 上 spawn 的 timeout 选项不可靠，手动超时 kill 兜底
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ ok: false, error: '注入超时（30s）' });
    }, 30_000);

    child.on('close', (code) => {
      const output = stdout.trim();
      if (output === 'OK') {
        finish({ ok: true });
      } else {
        const error = output.startsWith('ERROR:')
          ? output.slice(6)
          : output || stderr.slice(0, 200) || `exit code ${code}`;
        finish({ ok: false, error });
      }
    });

    child.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
  });
}
