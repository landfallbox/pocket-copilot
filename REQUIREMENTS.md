# 项目文档：pocket-copilot

> 一份文档，先明确"做什么"（Part 1），再逐步细化"怎么做"（Part 2）。
> 新会话开始任何工作前，先完整阅读本文件以恢复全部上下文，然后从"下一步"继续。
> 2026-08-27 由 REQUIREMENTS.md（需求封板）与 CONTEXT.md（技术事实）合并而成。
> **2026-09-23 架构大改**：AHP（Agent Host Protocol）端到端 Spike 通过，读/写路径全部改用 AHP 官方协议；原 heimdall 记录 + 对齐器读路径与 UIA 写路径退役（详见 §12）。
> **2026-09-23 端形态定稿**：最终手机端为 **Android 原生 App**（Kotlin + Compose），电脑端 pocket-copilot 演进为 **daemon**（AHP 客户端 + 简化手机协议网关 + 配对）；AHP 留在电脑端，Android 为瘦客户端（详见 §5/§6/§9）。PWA 降级为过渡期开发工具（仍直连 agent host）。
> **2026-09-24 管理器接管**：新增 Electron 管理器（`manager/`）——AHP 环境变量读写（注册表 `HKCU\Environment` 为 token 唯一事实来源）、daemon/隧道生命周期、开机自启、一键重启 VS Code。daemon 改为 tsc 编译 + 软件自带 Node 运行时（`ELECTRON_RUN_AS_NODE`）独立子进程启动，token 经 `AHP_TOKEN` 环境变量注入；`launch-vscode-ahp.cmd` 与 token.txt 退役删除（详见 §5/§9）。

---

# Part 1：做什么

## 1. 目标

**PC VS Code Copilot 的远程镜像**：在手机上远程以类原生的效果实现电脑端与移动端的 Copilot 交互体验和无感切换。

- PC 是唯一事实源，手机端是它的实时投影；"无感切换"天然成立，要做的只有两件事：
  1. **看**：投影足够实时、足够完整
  2. **写**：手机上的操作能注入 PC 会话，如同用户本人在操作
- 覆盖电脑上**所有已打开 VS Code 窗口**的项目，所有会话，含**全量历史**
- **范围原则：只谈软件启用后的内容**——启用前的历史会话不作考虑、不回填；项目范围 = agent host 可见的会话
- 模型输出必须**流式**；端到端延迟秒级内可接受
- 访问范围目前仅自己（Tailscale），暂不做认证
- 手机不是"平行的自研 agent"，而是**同一个 Copilot 会话的第二块屏**：同一会话、同一套记忆、同一个 harness、同一份模型配置

## 2. 主要功能点

### 读

1. **会话总览**：所有 workspace、所有会话的列表（项目名、状态 running/done、模型名、agent host 连接状态）
2. **全量历史**：进入会话可看完整历史，不限于当前上下文窗口（范围 = AHP 连接建立后的内容，`fetchTurns` 分页）
3. **实时流**：模型文本流式输出；思考、工具调用、状态实时更新；断线重连后 replay 补齐
4. **待审编辑（diff）**：先基础版——显示有待审编辑 + diff 内容

### 写

5. **发送文字消息**（第一步，M2）
6. **批准 / 拒绝编辑**（逐步增强）
7. **回答模型提问**（逐步增强）
8. **打断运行中的请求**（逐步增强）

### 基础支撑

9. **数据面**：AHP 原生状态（会话/turn/流式输出/工具调用/changeset diff），agent host 为唯一事实源
10. **网络**：Tailscale，仅自己访问

## 3. 里程碑

> M1/M2 已由 PWA 直连 agent host 完成（读全通 + 发送消息）。2026-09-23 端形态定稿后重排：AHP 客户端逻辑从 PWA 上移到电脑端 daemon，手机端改为 Android 原生瘦客户端。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 读全通：会话总览 + 全量历史 + 实时流 + diff 基础版（PWA 直连验证） | ✅ 完成 |
| M2 | 写起步：发送文字消息（PWA 直连验证） | ✅ 完成 |
| M3a | **daemon**：AHP 镜像（焦点会话 ChatState）+ 简化手机协议网关 + QR 配对；WS 脚本验证全链路 | ✅ 完成（2026-09-23：代码完成，真机接入，全链路验证通过） |
| M4 | **Android App**（Kotlin + Compose）：实现同一套简化协议（会话列表 / 视图快照渲染 / 发消息） | 进行中（代码已提交 2026-09-23；剩余工作见 §15 M4-1~M4-4） |
| M5 | 写增强：批准/拒绝、回答提问、打断 + 体验（托盘、推送、diff 完整交互） | 待启动 |

## 4. 现阶段不做

- 多用户、认证、分发
- PWA 壳（manifest / service worker / 添加到主屏）
- 手机端发起全新会话
- AHP 连接建立前的历史内容（不回填）
- 多焦点会话镜像（daemon 同一时刻只镜像手机正在看的"焦点会话"，切会话才切订阅）

## 5. 关键决策（讨论确认）

| 项 | 结论 |
|---|---|
| 模型内容数据源 | **AHP 原生状态流**（agent host 订阅：文本流式/工具调用/状态；2026-09-23 Spike 3 定稿，heimdall 记录方案退役） |
| jsonl 的角色 | 退役（AHP 状态即唯一事实源，不再解析本地文件） |
| diff 数据源 | AHP changeset 通道（agent host 原生提供） |
| 范围原则 | 只谈 AHP 连接建立后的内容：历史会话不回填，项目范围 = agent host 可见的会话 |
| "写"的范围 | 全部交互功能都在目标内，但**逐步实现**，第一步是发送文字消息 |
| M2 消息格式 | 纯文本 |
| diff 体验 | 最终完整实现，先做基础版（有待审编辑 + diff 内容展示） |
| 写路径具体机制 | **AHP dispatchAction**（2026-09-23 Spike 3 实测定稿：外部客户端向 chat 通道发 `chat/pendingMessageSet`，Copilot turn 真实执行，与 Agents 窗口同一代码路径）；UIA/CDP 方案退役（见 §12） |
| **端形态（2026-09-23 定稿）** | 最终手机端 = **Android 原生 App**（Kotlin + Jetpack Compose，瘦客户端）；电脑端 = **daemon**（pocket-copilot 演进）；PWA 降级为过渡期开发工具（仍直连 agent host，用于绕过 daemon 调试） |
| **AHP 客户端位置** | **电脑端 daemon**（Node + 官方 `@microsoft/agent-host-protocol` TS 包，已验证）；Android 不实现 AHP（Kotlin 重写 = 重复劳动，且原始 token 会暴露到手机） |
| **daemon 角色** | ① AHP 客户端：订阅根通道（会话列表）+ 焦点会话的 session/chat 通道，官方 `chatReducer` 维护 ChatState；② 简化手机协议网关（JSON over WS，推视图快照）；③ QR 配对（按设备发 deviceToken，原始 AHP token 不出电脑）；④ 健康探测 + VS Code 重启后自动重连 |
| **手机协议粒度** | 快照制：daemon 维护完整 ChatState，状态变化节流 100ms 推**视图快照**（带单调版本号，手机忽略过期版本）；手机零 diff 逻辑 |
| **镜像范围** | 只镜像"焦点会话"（手机正在看的那个 session + chat 通道）；手机切会话时 daemon 切订阅；不镜像全部会话 |
| 配对方式 | QR 码：`pocket-copilot://pair?host=<Tailscale-IP>&port=8765&device=<deviceToken>`；Android deep link 解析后连 `ws://<host>:8765/ws` 发 `hello` 鉴权 |
| PWA 过渡策略 | 保留直连 agent host 不动（开发/调试用）；不切到 daemon（用户 2026-09-23 决定跳过该过渡步骤，daemon 用 WS 脚本验证后直接进 Android） |
| 前端技术栈（PWA，过渡期） | React 19 + Vite + TS + zustand（沿用 demo 已验证底座）；**移除 @assistant-ui/react**，展示层手写组件 |
| Android 技术栈 | Kotlin + Jetpack Compose；WebSocket 用 OkHttp；QR 扫码用 ML Kit（deep link 兜底手动输入） |
| daemon 架构 | 不引入框架，现有裸 Node 骨架扩展（`src/ahp/` + `src/phone/` 模块） |
| daemon 形态 | v1 纯后台进程 + 日志文件；托盘图标放 M5 |
| 推送通知 | 待定（M5） |
| **token 管理（2026-09-24 定稿）** | **注册表 `HKCU\Environment` 的 `VSCODE_AGENT_HOST_CONNECTION_TOKEN` 是唯一事实来源**（VS Code 读取处）；管理器 UI 读写注册表（预填以注册表为准、未设置留空，保存时写后读回校验）；daemon 启动时由管理器把注册表值注入 `AHP_TOKEN` 环境变量。token.txt 与 `launch-vscode-ahp.cmd` 退役删除 |
| **daemon 运行时（2026-09-24 定稿）** | 保留**独立子进程**（崩溃隔离，不连累管理器 UI），但去掉 powershell→npm→tsx 进程链：`tsc` 编译到 `dist/`（`npm run build:daemon`），管理器用软件自带 Node 运行时（`ELECTRON_RUN_AS_NODE=1` + `process.execPath`）直启 `dist/server.js`，`detached` 防终端关闭连坐；自启（schtasks ONLOGON）走同一方式 |
| **电脑端管理器（2026-09-24 定稿）** | Electron 托盘常驻应用（`manager/`）：AHP 环境变量读写、daemon/隧道生命周期、开机自启、一键重启 VS Code（AHP 环境变量生效）、状态轮询 + 绿/黄/红托盘图标 |

---

# Part 2：怎么做

## 6. 总体架构

```
Android App（瘦客户端）◀── 简化协议 JSON over WS（公网隧道 28765 / Tailscale，deviceToken 鉴权）──▶ 电脑端 daemon :8765
                                                                              │  AHP 官方 TS 包
                                                                              ▼
                                                                    VS Code agent host 进程 :8081
                                                                    ├── IPC 客户端：Agents 窗口（既有，不变）
                                                                    └── WS 客户端：daemon（新增，对等）
PWA（过渡期开发工具）◀── AHP over WS（?tkn=token，直连，绕过 daemon）──▶ agent host

Electron 管理器（托盘常驻）── 管理 ──▶ daemon（spawn，注入 AHP_TOKEN）/ 隧道（直接 spawn 系统 ssh.exe -R）/ 注册表 AHP 环境变量 / VS Code 重启
```

- 单一事实来源 = VS Code agent host 进程内的真实 Copilot 会话（读/写都走 AHP 官方协议，无文件解析、无 UI 自动化、无平行 agent）
- 手机和 PC 操作的是字面意义上的同一个 Copilot：daemon 与 Agents 窗口共享同一 StateManager，记忆 / harness / 模型配置天然一致；手机发的消息在 Agents 窗口里与用户亲手输入无异
- **AHP 客户端逻辑在电脑端 daemon**（Node + 官方 `@microsoft/agent-host-protocol` TS 包，已验证）；daemon 订阅根通道 + 焦点会话的 session/chat 通道，用官方 `chatReducer` 维护 ChatState，节流 100ms 向手机推视图快照
- **Android 是瘦客户端**：不实现 AHP，只实现简化协议（会话列表 / 视图快照渲染 / 发消息 / 切会话）；原始 AHP token 永不出电脑，手机只持 deviceToken
- 进程拓扑：VS Code（含 agent host 子进程，带环境变量启动）+ daemon（管理器拉起，§9）；daemon 健康探测 + 3s 重连循环，VS Code 重启后自动重连
- 协议版本漂移风险被隔离：AHP 版本变化只影响 daemon（Node 侧升级官方包即可），Android 协议是自研简单 JSON，不受影响

**AHP 端到端 Spike 结论（2026-09-23，全链路验证通过，VS Code 1.136.2 + 真实 Copilot 账号）**：
- **零改造启动**：agent host 进程读 `VSCODE_AGENT_HOST_PORT` / `VSCODE_AGENT_HOST_HOST` / `VSCODE_AGENT_HOST_CONNECTION_TOKEN` 环境变量，设置后即监听 TCP WebSocket 端口（`?tkn=` 查询参数认证）；桌面版 starter 深拷贝主进程 env 透传 → 带环境变量启动 VS Code 即可，零代码修改。变量由管理器写入注册表 `HKCU\Environment`（用户级，所有新进程可见），生效需冷启动 VS Code（管理器一键重启）
- **多客户端共享状态**：外部客户端与 Agents 窗口是对等的 AHP 客户端，共享同一 AgentService/StateManager（官方源码注释明确"IPC 与 WebSocket 客户端共享状态"）
- **已验证链路**：WS 连接 + token 认证 → `initialize`（协商 0.9.0，根快照含 Copilot agent）→ `createSession`（真实 git 状态检查）→ 向 **chat 通道** 发 `chat/pendingMessageSet` → 队列消费触发 `chat/turnStarted` → 会话实体化（`session/ready`）→ Copilot 真实执行（worktree 创建、流式输出、token 统计、`chat/turnComplete` 8 秒）
- **关键陷阱**：消息必须 dispatch 到 `ahp-chat://` 通道，发到 session 通道队列不消费（QueueDrainContribution 只处理 chat 通道）
- **会话生命周期**：createSession 是 deferred backing（停留 creating），首次 send 才实体化（→ ready）
- **单实例陷阱**：环境变量只对首个 VS Code 进程生效；已有实例运行时新进程只转发即退出、端口不开 → 需完全退出后冷启动
- **Copilot 登录依赖**：agent host 用主 profile 的 Copilot 登录态（已验证：临时 profile 未登录 → turn 报 authentication 错误；主 profile 已登录 → 通过）

## 7. 环境事实（均已在本机验证）

### 7.1 软件环境

| 项 | 值 |
|---|---|
| OS | Windows |
| VS Code | 1.136.2, x64, 安装于 `D:\App\Microsoft VS Code`（app 实际在 `88e44fa0e0\resources\app\` hash 目录） |
| Copilot Chat 扩展 | publisher: GitHub，version 0.62.0，位于 `resources\app\extensions\copilot` |
| heimdall | `D:\code\projects\heimdall`，本地 OpenAI 兼容模型路由器（含 vendor failover，Electron GUI）；主 checkout 是**生产路由**（所有模型调用经它），不得直接修改，开发走 worktree |
| 模型标识 | `customendpoint/Heimdall/Qwen3.8-27B`（第三方模型走 heimdall 路由） |
| code 命令 | 已加入用户 PATH（`D:\App\Microsoft VS Code\bin`） |

### 7.2 API 边界（已核对 1.134.0 的 `vscode.d.ts`）

- `vscode.chat.createChatParticipant`：只能注册**自己的** chat participant
- **不存在**会话级 API：无法向内置 Copilot 会话注入消息、无法订阅其消息流、无法读取其会话状态
- `vscode.lm`（`selectChatModels` / `sendRequest`，含 tool calling）完整可用——但当前方向（接入 Copilot 本体）不需要它
- 结论：扩展 API 层无会话级 API（上述事实仍成立）；但进程级 AHP 协议提供了完整的会话读/写能力（见 7.6），是当前主路径

### 7.3 闭源事实（已验证）

- VS Code 编辑器本体：MIT 开源
- Copilot Chat 扩展：**闭源专有**。`extensions\copilot` 下无 `src` 目录，只有 `dist/` 共 21.3MB 编译混淆 JS + 专有 LICENSE
- 循环逻辑（上下文装配 / 截断 / 重试 / 停止条件）无法合法获取
- 本地日志是用户自己的数据，可作设计参考；反编译扩展代码 / 逐字复制系统提示词分发有版权风险（个人自用风险低）

### 7.4 本地会话存储（已验证；AHP 方案后不再使用，仅供参考）

路径模式（hash 随工作区变化）：

```
%APPDATA%\Code\User\workspaceStorage\<workspace-hash>\
├── chatSessions\
│   └── <sessionId>.jsonl          # 会话主日志，实时追加
├── chatEditingSessions\
│   └── <sessionId>\
│       ├── state.json             # 待审编辑状态
│       └── contents\              # 待审文件内容
└── GitHub.copilot-chat\
    └── debug-logs\
        └── <sessionId>\
            ├── main.jsonl         # 完整事件轨迹（实测 6.4MB）
            ├── models.json        # 模型元信息
            ├── system_prompt_0.json  # 完整系统提示词（19KB，已按第三方模型适配）
            └── tools_0.json       # 完整工具定义（71KB，22 个工具含 JSON schema）
```

jsonl 记录结构（抽样验证）：

- `kind=0`：会话头，字段全在 `v` 下：`{version:3, creationDate, initialLocation, sessionId, hasPendingEdits, requests:[N], pendingRequests, inputState}`；**头部行可达 23MB**（历史请求都收在 `v.requests` 里）
- `kind=1`：状态更新，`k=` 字段如 `responderUsername`、`inputState selectedModel`（含完整模型配置）、`inputState inputText`；`k=["requests",N,"result"]` = 请求完成（timings/tokens）
- `kind=2`：`k=["requests"]` 时 `v` 是**数组**（新请求定义：requestId/timestamp/message/response/result）；`k=["requests",N,"response"]` = 滑动窗口 chunk 快照（**新架构下不再消费**）

文件行为（实测）：

- 对话进行期间**实时增长**（~8KB 缓冲批量 flush）
- VS Code 会**周期性整体重写/压缩**文件（实测 38MB / 543 行）；重写后头部前 1KB 跨重写稳定（头部指纹检测失效），但旧读取偏移会指向新文件某行中间 → **行边界校验是有效重写检测手段**

### 7.5 code tunnel 实测（已排除）

- `code tunnel` 可用，曾成功创建隧道，第三方模型配置在隧道侧原样可用
- **排除原因**：浏览器里是完整桌面 VS Code UI，手机屏幕与触控操作逻辑下几乎不可用——它只证明了远程链路可行

### 7.6 AHP 协议事实（2026-09-23 验证）

- 官方规范：`microsoft/agent-host-protocol`（MIT，对标 LSP/DAP）；官方 TS 客户端 `@microsoft/agent-host-protocol@0.9.0`（npm，浏览器兼容、零依赖；入口 `/client`（AhpClient/AhpStateMirror）、`/ws`（WebSocketTransport）、`/hosts`（MultiHostClient 多主机编排 + 自动重连））
- agent host 进程是 VS Code 子进程（每 user-data-dir 一个），随普通窗口启动；设置 `VSCODE_AGENT_HOST_PORT` 环境变量后监听 TCP 端口，与 IPC 客户端共享状态
- 认证：WebSocket upgrade 用 `?tkn=` 查询参数校验 token；不设置 token 则无认证（危险，必须设置）。token 唯一事实来源 = 注册表 `HKCU\Environment` 的 `VSCODE_AGENT_HOST_CONNECTION_TOKEN`（管理器写入）；daemon 经管理器注入的 `AHP_TOKEN` 环境变量获得（2026-09-24 起，token.txt 退役）
- 协议版本协商：客户端在 `initialize.protocolVersions` 提供多版本，服务端选择（本机协商到 0.9.0；1.136.2 服务端亦支持 1.0.0）
- 通道模型：`ahp-root://`（全局）/ `ahp-session:/<id>`（会话）/ `ahp-chat://default/<base64>`（聊天）；状态为快照 + 动作流，订阅即得全量快照
- 主要命令：`listSessions` / `createSession` / `fetchTurns`（历史分页，turnsNextCursor）/ `subscribe`
- 主要写动作（客户端可 dispatch）：`chat/pendingMessageSet`（queued/steering）/ `chat/toolCallConfirmed`（批准/拒绝）/ `chat/inputAnswerChanged` + `chat/inputCompleted`（回答提问）/ `chat/turnCancelled`（打断，细节 M3 验证）
- 流式：`chat/delta`（文本增量）/ `chat/responsePart`（完整 part）/ `chat/usage`（token 统计）/ `chat/toolCall*`（工具调用生命周期）
- diff：`SessionState.changesets` 提供可订阅的 changeset URI（uncommitted/会话级/逐 turn 视图）

## 8. 数据面（已退役，历史记录）

> 原数据面（heimdall 记录 + jsonl 索引 + 对齐器）于 **2026-09-23 整体退役**，由 AHP 原生状态取代（见 §6/§7.6）：AHP 天然提供流式内容、会话归属、历史分页（`fetchTurns`），"会话归属对齐"承重墙风险随之消失。以下为历史结论摘要。

- **heimdall 请求/响应记录**（worktree `feature/request-logging` 开发完成）：逐 chunk 实时 append（request_start/chunk/request_end），配置开关默认关。离线（2026-08-27）+ 在线（2026-08-28）验证均通过：对齐三层（主键 `<userRequest>` 提取 / 历史指纹消歧 / token 时序配对校验）在真实流量成立，全链路（router 落盘 → pocket-copilot 读取 → 对齐 → 浏览器渲染）打通。主路径改用 AHP 后不再使用；heimdall 仓库不动（功能在默认关的开关后，生产路由无影响）
- **pocket-copilot 侧旧数据面代码**（heimdall-tailer / registry / tailer / line-tailer / session-info / session-titles / model-name / project-name，约 2000 行）随 M1 重构删除
- **UIA 写路径**（Spike 2，`inject.ts` 386 行）同样退役删除；其前提 `accessibilitySupport: "on"` 已写入用户 settings.json，可保留（无害）或还原

## 9. daemon 架构（Node，pocket-copilot 演进）

- 技术栈：TypeScript + ESM，**不引入框架**。服务 bind 0.0.0.0:8765（公网隧道 / Tailscale 访问）
- 构建与启动（2026-09-24 定稿）：
  - `npm run build:daemon`（tsc → `dist/`，`tsconfig.build.json`）；开发期仍可 `npm run dev`（tsx 直跑）
  - 管理器用软件自带 Node 运行时启动：`ELECTRON_RUN_AS_NODE=1` + `process.execPath` 直启 `dist/server.js`（独立子进程，崩溃隔离；`detached` 防终端关闭连坐）；不再依赖 powershell→npm→tsx 进程链
  - 开机自启：schtasks ONLOGON 任务 `PocketCopilotDaemon` 跑管理器生成的 `start-daemon.ps1`（同一 Electron 运行时 + 从注册表读 token 注入 `AHP_TOKEN`）
  - **token**：daemon 只读 `AHP_TOKEN` 环境变量（管理器启动时从注册表读出注入）；token.txt 已退役删除
- 职责：
  - **AHP 客户端**（`src/ahp/`）：官方 `@microsoft/agent-host-protocol` TS 包；连接/initialize/断线重连（3s 重试循环 + 健康探测 8081）；订阅根通道（会话列表）+ 焦点会话的 session/chat 通道；官方 `chatReducer` 维护 ChatState
  - **简化手机协议网关**（`src/phone/`）：JSON over WS（`/ws` 路径 upgrade）；设备鉴权（deviceToken）；会话列表 / 视图快照（节流 100ms + 单调版本号）/ host 状态 事件扇出；命令（select/send，M5 加 stop/respond）
  - **配对**（`src/phone/pairing.ts`）：deviceToken 生成/校验（存 `%USERPROFILE%\.pocket-copilot\devices.json`）；QR 内容 `pocket-copilot://pair?host=<Tailscale-IP>&port=8765&device=<deviceToken>`
  - **静态托管 + 配置端点 + 健康检查**（既有，保留）：PWA 过渡期仍用
- 模块拆分：
  - `src/ahp/connection.ts`：AHP 连接生命周期（store.ts 连接状态机移植）
  - `src/ahp/mirror.ts`：根通道会话列表 + 焦点会话 ChatState（store.ts 的 consumeRoot/selectSession/consumeChat 移植）
  - `src/ahp/view.ts`：ChatState → 手机视图快照（web/src/convert.ts 原样搬）
  - `src/phone/protocol.ts`：协议类型（daemon / PWA / Android 三方共享）
  - `src/phone/hub.ts`：手机 WS 连接管理、鉴权、扇出、心跳
  - `src/phone/pairing.ts`：deviceToken + QR
  - `src/server.ts`：既有 HTTP/静态/health + WS upgrade 路由
- 生命周期：管理器托管（启动/停止/状态轮询）；开机自启走 schtasks（§5）；日志 `%LOCALAPPDATA%\PocketCopilotManager\daemon.log`
- 不引框架的理由：复杂度是纵向（AHP 状态 → 视图模型映射），框架提供的是横向抽象（路由/中间件），形状不匹配

### 9.1 电脑端管理器（Electron，`manager/`，2026-09-24 新增）

- 形态：Electron 托盘常驻应用（main.js CJS + 原生 HTML/JS renderer，preload contextBridge）；`window-all-closed` 不退（托盘常驻），退出前杀自己托管的 daemon/隧道
- 职责：
  - **AHP 环境变量**：读写注册表 `HKCU\Environment` 的 `VSCODE_AGENT_HOST_PORT` / `_HOST` / `_CONNECTION_TOKEN`（PowerShell `Get/Set-ItemProperty`）；UI 预填以注册表为准、未设置留空；保存时写后读回校验
  - **daemon 生命周期**：启动（注入 `AHP_TOKEN`，产物缺失时提示先 `npm run build:daemon`）/ 停止（托管走 killTree，非托管按端口 8765 杀宿主）/ 状态轮询（3s，`/api/health`）
  - **隧道**：直接 spawn 系统 `ssh.exe -R 28765→8765`（Win10 1809+ 自带 OpenSSH），重连循环在 main.js（断线 5s 重连；重连前先探活，公网已可达则 30s 复检不空转）；"隧道可用"状态以公网探活为准（SSH -R 只在服务器侧监听，本地无 28765 端口）
  - **一键重启 VS Code**：杀全部 Code 进程 → 重新拉起工作区（AHP 环境变量冷启动生效，绕开单实例陷阱）
  - **开机自启**：schtasks ONLOGON `PocketCopilotDaemon`（生成 start-daemon.ps1，不经过管理器直接启 daemon）
- 日志：`%LOCALAPPDATA%\PocketCopilotManager\manager.log` / `daemon.log` / `tunnel.log`

## 10. 前端（PWA，过渡期开发工具）

> 2026-09-23 端形态定稿后，PWA 不再是最终交付物，降级为**过渡期开发/调试工具**：直连 agent host（绕过 daemon），用于 daemon 出问题时隔离排查（如 considering 卡住 bug）。M4 起最终交付物是 Android App。

- 技术栈：React 19 + Vite + TS + **zustand**（沿用 demo/ 已验证底座）
- **数据层**：官方客户端库 `@microsoft/agent-host-protocol`（浏览器内 `WebSocketTransport` + `AhpClient`）；store.ts 是"AHP 状态镜像"（root/session/chat 订阅 → zustand）
- **复用去向**：store.ts 的连接/订阅状态机 → daemon `src/ahp/connection.ts` + `mirror.ts`；convert.ts 的 ChatState→消息模型 → daemon `src/ahp/view.ts`（即手机协议的 view 结构）
- 视图映射：会话总览 = `listSessions` + root 通道订阅；聊天视图 = `ChatState.turns` + `chat/delta` 流式；历史 = `fetchTurns` 分页（turnsNextCursor）
- 写路径：输入框 → dispatch `chat/pendingMessageSet`（queued）到 chat 通道
- 明确不引入：路由库、CSS 框架、React Query 等数据层

## 11. 通信与网络

- **主数据面（最终形态）**：Android App ↔ daemon 走**简化协议 JSON over WS**（`ws://<Tailscale-IP>:8765/ws`，deviceToken 鉴权）；daemon ↔ agent host 走 AHP over WS（`?tkn=`）。AHP 的常开推送特性（快照 + 动作流）由 daemon 内部消化，对手机呈现为视图快照推送
- **daemon → 手机推送**：视图快照制，节流 100ms + 单调版本号（手机忽略过期版本）；会话数据 KB 级，全量快照简单不出错
- **断线重连**：daemon 侧 3s 重试循环 + 健康探测 8081，VS Code 重启后自动重连并重订阅（全量快照补齐）；Android 侧 WS 断线指数退避重连 + 重发 hello
- **静态托管**：PWA 过渡期由 daemon 托管（同端口出文件和配置）；Android 阶段 UI 打进包内，此部分退役
- **网络**：Tailscale（PC + 手机）；仅自己访问；agent host 端口必须带 token（`?tkn=`，仅 daemon 持有）；手机只持 deviceToken（QR 配对下发）
- **单实例陷阱**：环境变量只对首个 VS Code 进程生效；已有实例运行时新进程只转发即退出、端口不开 → 健康检查要能区分"VS Code 未启动"与"未带环境变量启动"；管理器提供一键重启 VS Code（杀进程 → 重新拉起工作区，冷启动生效）

## 12. 已否决的备选方案（含原因，避免重复讨论）

| 方案 | 否决原因 |
|---|---|
| code tunnel / code-server | 桌面 UI 塞手机屏，不可用（已实测） |
| VS Code 扩展内自研 agent（chat participant + vscode.lm + 自研 harness） | 用户明确要 Copilot 本体，不要平行 agent |
| 独立 agent 服务 + 双端（跨设备无感但自研 agent） | 同上——"无感切换"架构思路保留，但 agent 必须是 Copilot 本体 |
| SSH + tmux + aider；OpenHands；aider + 薄桥 | 用户认为都不好（同样是平行 agent） |
| 1:1 复刻内置 harness | 版权风险 + 内置 harness 为官方模型调优，对第三方模型未必最优 |
| jsonl 响应 chunk 流解析（原读路径） | 过于脆弱：滑动窗口快照去重、周期性压缩重写（38MB 文件/23MB 头部行）、围栏碎片，反复出 bug → 2026-08-27 转向 heimdall 记录 |
| heimdall 记录 + jsonl 索引 + 对齐器读路径（曾为主路径，已建成并验证） | 被 AHP 取代（2026-09-23）：AHP 原生提供流式内容 + 会话归属 + 历史分页，无需自建"对齐承重墙"；原方案脆弱（jsonl 重写/prompt 包裹/竞态），且 heimdall 生产路由需背负记录功能。退役后 heimdall 仓库不动（功能在默认关的开关后） |
| Windows UIA 写路径（Spike 2 实测通过） | 被 AHP 取代（2026-09-23）：AHP dispatch 是官方协议的同一代码路径，无 UI 结构依赖、无 `accessibilitySupport` 前提、不抢前台窗口；UIA 仅留历史记录（§8） |
| Android 直连 agent host :8081（2026-09-23 否决） | 需 Kotlin 重写 AHP 客户端（通道模型/快照+动作流/reducer，纯重复劳动）；原始 AHP token 暴露到手机；AHP 版本漂移直接打到 App 层。改为 daemon 中转（§5/§6） |
| PWA 壳 / Capacitor 套壳（2026-09-23 否决） | 用户明确最终要 Android 原生 App；套壳只是过渡，非终态 |

## 13. 风险与边界（必须接受）

1. **AHP 协议版本漂移**：VS Code 升级可能带来协议版本变化（本机 1.136.2 服务端支持 0.9.0/1.0.0，与客户端库 0.9.0 协商）；npm 客户端库若滞后需同步升级。缓解：协议有版本协商、官方库随 VS Code 同步更新；**漂移被隔离在 daemon（Node 侧升级官方包即可），Android 自研协议不受影响**；开发期固定 VS Code 版本 + 冒烟回归（发消息→检查回复）
2. **单实例冷启动陷阱**：环境变量只对首个 VS Code 进程生效；已有实例运行时新进程只转发即退出、端口不开。缓解：健康检查区分"VS Code 未启动"与"未带环境变量启动"；管理器一键重启 VS Code（杀全部 Code 进程 → 重新拉起工作区）
3. **VS Code 必须开着**：会话活在 VS Code 进程里，agent host 是 VS Code 子进程——这是接入本体的固有约束
4. **Copilot 登录依赖**：agent host 用主 profile 的 Copilot 登录态；登录过期时 turn 报 authentication 错误（PWA 需明确透出该错误并提示重新登录）
5. **worktree 副作用**：AHP 会话默认 `isolation: worktree`，Copilot 会在 `<repo>.worktrees/` 建 worktree（分支 `agents/<uuid>`）；与 Agents 窗口 PC 端行为一致，测试会话结束后需清理 worktree + 分支
6. **法律边界**：使用官方开源 AHP 协议（MIT）连接自己机器上的 agent host = 合规；不反编译 / 不复制分发微软代码
7. **多实例边界**：每 user-data-dir 一个 agent host；若用户以不同 user-data-dir 开第二实例需第二个端口（罕见场景，后置支持）
8. **长期**：若 VS Code 未来开放官方移动端 / 远程会话 API，本项目可退役或切换官方通道
9. **第二个 AHP 客户端的副作用（排查中）**：PWA 直连期间观察到长 turn 结束后 thinking 块偶发卡在 "Considering"（agent host 状态已回 Idle，仅 UI 渲染未 finalize）；A/B 测试存在混淆变量（短 turn vs 长 turn），控制变量测试未完成。daemon 上线后 8081 上仍有 daemon 这一个外部 AHP 客户端，若 bug 复现则触发条件即"存在第二个 AHP 客户端"本身，需进一步定位（agent host 广播/finalize 链）

## 14. 验证计划（spikes）

| Spike | 内容 | 通过标准 | 状态 |
|---|---|---|---|
| 1（先做，低风险） | 文件监听 → 事件流 → 最简网页实时显示当前会话 | 浏览器上看到真实 Copilot 会话随 PC 侧操作更新 | **基础设施已跑通**（tailer/WS/前端）；"内容显示"目标由 1.5 系列接管（内容源改为 heimdall） |
| **1.5a（关键风险验证，最高优先级）** | **对齐可行性最小实验**：抓 1-2 个真实 heimdall 请求体（临时开启请求体日志或代理抓包），对比 jsonl userText，验证"最后一条用户消息匹配"在真实数据上成立（含并行会话、@上下文包裹情况）；顺带摸清 heimdall 实际收到的流量构成（非聊天流量占比），确定过滤规则 | 真实数据上主键匹配成功率可接受，消歧/归一化规则明确，过滤规则明确 | **✅ 2026-08-27 离线验证通过**（用 debug-logs 替代 heimdall 请求体 + usage jsonl 替代 request_end；主键/消歧/token 三层均成立，见 §8 历史摘要；非聊天流量过滤规则与 @文件富内容待 1.5 在线补验） |
| 1.5（读路径重构，2026-08-27 立项） | heimdall 加请求/响应记录（worktree 分支开发）；pocket-copilot 读路径改为 heimdall 记录 + jsonl 索引混合 | 流式文本/思考/工具从 heimdall 记录可靠还原，会话归属按对齐策略（§8 历史摘要）成功 | **✅ 2026-08-28 在线验证通过**（开发版 router 4100 + Qwen 3.8 27B DEV 真实流量：router 落盘 → pocket-copilot 读取 → aligner 对齐 → 浏览器渲染助手正文全链路打通）。在线验证暴露并修复 3 个 bug：① lastUserText 是完整 prompt 非纯输入（须提取 `<userRequest>`）；② 取最后一个 `<userRequest>` 块（context 可能回显含该标签字面量的历史命令）；③ chunk 丢失竞态（重启重放 heimdall 先于 jsonl，须缓冲 chunk + pending 重试）。**残留**：@文件富内容/并行碰撞样本/非聊天流量过滤（不阻塞） |
| 2 | 写路径验证（机制 2026-08-31 由 CDP 改为 **Windows UIA**）：不重启 VS Code/不开调试端口，PowerShell + .NET UIAutomation 定位会话（Pick Agent Session 选择器）+ 输入框，剪贴板粘贴注入一条消息 | 消息出现在 PC 的 Copilot 会话中，回复两端都可见 | **✅ 2026-08-31 实测通过**（注入 + 会话定位全链路验证，结论见 8 历史摘要；CDP 方案因需 `--remote-debugging-port` 启动参数被用户否决后弃用；方案 2026-09-23 被 AHP 取代） |
| **3（AHP 端到端，2026-09-23）** | 外部客户端（Node + 官方 `@microsoft/agent-host-protocol`）经 WebSocket + token 连接 agent host → `initialize` → `createSession` → 向 chat 通道 dispatch `chat/pendingMessageSet` → 观察 turn 事件 | Copilot turn 真实执行（worktree 创建、流式输出、token 统计、`turnComplete`），回复内容与指令一致 | **✅ 2026-09-23 实测通过**（VS Code 1.136.2 + 真实 Copilot 账号，闭环 8 秒，结论见 6；关键陷阱：消息必须发 chat 通道，session 通道不消费） |

Spike 链：**1.5a → 1.5 → 2（已完成，方案退役）→ 3（AHP 端到端，当前主路径定稿）**。

## 15. 下一步

1. ~~Spike 1 / 1.5a / 1.5（heimdall 读路径）~~（已完成，方案 2026-09-23 退役）
2. ~~Spike 2（UIA 写路径）~~（实测通过，方案 2026-09-23 退役）
3. ~~Spike 3（AHP 端到端）~~（2026-09-23 实测通过，AHP 主路径定稿，见 6/7.6）
4. **M1 读全通（AHP）**：
   - 启动器加固：`launch-vscode-ahp.cmd` 首次运行自动生成 token 并持久化到 `%USERPROFILE%\.pocket-copilot\`（token 不硬编码进仓库）；桌面快捷方式目标改为启动器（2026-09-24 退役：token 管理改由管理器写注册表，启动器删除）
   - web/：引入 `@microsoft/agent-host-protocol`，store.ts 重构（AhpStateMirror + zustand），convert.ts 重写（AHP 状态 → 视图模型）；展示层组件复用
   - src/：瘦身为薄服务（静态托管 + 配置端点 + agent host 端口健康检查）；删除旧数据面代码（约 2000 行，见 §8）
   - 验收：手机（Tailscale）打开 `http://<PC的tailscale-ip>:8765` → 会话总览 → 完整历史 → PC 侧真实会话实时流式
5. ~~**M2 写起步**~~：✅ 完成（PWA 直连，dispatch `chat/pendingMessageSet`（queued）到 chat 通道；手机发消息 → Copilot 执行 → 回复两端流式）
6. **M3a daemon**（2026-09-23 端形态定稿后新增）：
   - `src/ahp/`：connection.ts（连接/重连，store.ts 状态机移植）+ mirror.ts（根通道会话列表 + 焦点会话 ChatState）+ view.ts（convert.ts 移植 → 视图快照）
   - `src/phone/`：protocol.ts（协议类型）+ hub.ts（WS 连接管理/鉴权/扇出/心跳）+ pairing.ts（deviceToken + QR）
   - `src/server.ts`：加 WS upgrade 路由（`/ws`）；daemon 启动方式见 §9（2026-09-24 起由管理器拉起，原"启动器顺带拉起"退役）
   - 验收：WS 脚本全链路（hello 鉴权 → welcome 会话列表 → 焦点会话视图快照随 PC 侧 turn 流式更新 → send → Copilot 执行 → 回显）
7. **M4 Android App**：Kotlin + Jetpack Compose；实现同一套简化协议（QR 配对 → 会话列表 → 视图快照渲染 → 发消息）；真机（Tailscale）验收
   - 已完成（2026-09-23，`4a5e737`）：QR 扫码配对（deep link + 手动输入兜底）、会话列表 + 标题下拉切会话、视图快照渲染（Markdown/代码高亮/reasoning/工具步骤组/pending 回显）、发消息、前台 Service 保活 + 常驻通知、WS 指数退避重连
   - **M4-1（阻塞，优先）** 手机心跳断开循环：daemon.log 反复"手机已连接 → 30s 心跳超时断开 → 重连"。daemon 侧 ping/pong 30s 判活，OkHttp 会自动回 pong，pong 回不来 = 手机侧 socket 被系统冻结（Doze/锁屏/Wi-Fi 省电），非协议 bug。
     - 动作：① 复现定位（锁屏/后台分别测，确认触发条件）；② daemon 心跳放宽到 60~120s；③ Android 引导用户关闭电池优化（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）
     - 验收：锁屏 + 后台 30 分钟以上连接不断；daemon.log 无心跳超时循环
   - **M4-2** 全量历史（fetchTurns 分页）上 daemon 链路：PWA 有"加载更早历史"（`fetchTurns` + `turnsNextCursor`），daemon mirror 只吃订阅快照，ChatState.turns 是滑动窗口，Android 看不到完整历史（M1 验收标准"全量历史"在 Android 路径未覆盖）。
     - 动作：① protocol.ts 加 `loadOlder` 命令；② daemon mirror 响应命令发 `fetchTurns`，`turnsLoaded` 经 chatReducer 回流后自动重推视图；③ Android 消息流顶部加"加载更早"按钮
     - 验收：Android 进入历史较长的会话，可分页加载到最早 turn；加载后新内容继续流式正常
   - **M4-3** "Considering" 卡住兜底（§13.9 关联）：长 turn 结束后 thinking 块偶发不 finalize（agent host 已 Idle，仅 UI 未收尾），Android 步骤组会永远显示 "Working…"。
     - 动作：① UI 兜底（turn 结束/状态回 Idle 后强制收尾步骤组）；② 根因定位（是否"存在第二个 AHP 客户端"触发）后置，不阻塞 M4
     - 验收：长 turn 结束后步骤组正常收尾；复现样本记录在案
   - **M4-4** 真机验收 + 文档收尾：
     - 动作：① 修完 M4-1 后真机（Tailscale）跑完整链路（配对 → 会话列表 → 流式渲染 → 切会话 → 发消息 → 历史分页）并记录结果；② 更新本文档里程碑表与验收记录；③ 小项（不阻塞）：daemon 侧设备名硬编码 `'phone'`，配对时可带设备名
     - 验收：M4 里程碑状态更新为 ✅，本文档同步
8. **M5 写增强 + 体验**：批准/拒绝（`chat/toolCallConfirmed`）、回答提问（`chat/inputAnswerChanged`/`inputCompleted`）、打断（`chat/turnCancelled` 细节验证）、托盘、推送、diff 完整交互

## 16. 用户偏好（新会话必须遵守）

- 中文（简体）回复，简洁、先结论后步骤
- Commit 格式（Angular）：`<type>(<lowercase-scope>): <中文 subject>`
- 命令行一律 Windows PowerShell 语法
- 最小必要改动，修根因不做表面补丁
- 不主动创建说明类 .md/.txt 文件（本文档是用户明确要求的例外）
- 日志规范：不用 `print("="*60)` 分割线、不用 `\n` 做 print 换行、不用 ✓/× 符号
- 存在多种方案时先分析利弊给推荐，用户确认后再写代码
- 回答中若创建临时文件，结束前必须清理
