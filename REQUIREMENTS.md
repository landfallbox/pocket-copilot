# 项目文档：copilot-bridge

> 一份文档，先明确"做什么"（Part 1），再逐步细化"怎么做"（Part 2）。
> 新会话开始任何工作前，先完整阅读本文件以恢复全部上下文，然后从"下一步"继续。
> 2026-08-27 由 REQUIREMENTS.md（需求封板）与 CONTEXT.md（技术事实）合并而成。

---

# Part 1：做什么

## 1. 目标

**PC VS Code Copilot 的远程镜像**：在手机上远程以类原生的效果实现电脑端与移动端的 Copilot 交互体验和无感切换。

- PC 是唯一事实源，手机端是它的实时投影；"无感切换"天然成立，要做的只有两件事：
  1. **看**：投影足够实时、足够完整
  2. **写**：手机上的操作能注入 PC 会话，如同用户本人在操作
- 覆盖电脑上**所有已打开 VS Code 窗口**的项目，所有会话，含**全量历史**
- **范围原则：只谈软件启用后的内容**——heimdall 记录启用之前的历史会话与项目不作考虑、不回填；项目范围 = heimdall 记录到的项目
- 模型输出必须**流式**；端到端延迟秒级内可接受
- 访问范围目前仅自己（Tailscale），暂不做认证
- 手机不是"平行的自研 agent"，而是**同一个 Copilot 会话的第二块屏**：同一会话、同一套记忆、同一个 harness、同一份模型配置

## 2. 主要功能点

### 读

1. **会话总览**：所有 workspace、所有会话的列表（项目名、状态 running/done、模型名、记录源状态）
2. **全量历史**：进入会话可看完整历史，不限于当前上下文窗口（范围 = heimdall 记录启用后的内容）
3. **实时流**：模型文本流式输出；思考、工具调用、状态实时更新；断线重连后 replay 补齐
4. **待审编辑（diff）**：先基础版——显示有待审编辑 + diff 内容

### 写

5. **发送文字消息**（第一步，M2）
6. **批准 / 拒绝编辑**（逐步增强）
7. **回答模型提问**（逐步增强）
8. **打断运行中的请求**（逐步增强）

### 基础支撑

9. **数据面**：heimdall 实时记录（模型内容）+ jsonl（索引/状态）+ chatEditingSessions（diff）
10. **网络**：Tailscale，仅自己访问

## 3. 里程碑

| 里程碑 | 内容 |
|---|---|
| M1 | 读全通：会话总览 + 全量历史 + 实时流 + diff 基础版 |
| M2 | 写起步：发送文字消息 |
| M3 | 写增强：批准/拒绝、回答提问、打断 |
| M4 | 体验增强：diff 完整交互、推送、端形态定稿 |

### 优化项（优先级分层）

优先级定义：**P0 = 功能开发与 BUG 修复 > P1 = 高优先级优化 > P2 = 无伤大雅的优化**

| 优先级 | 项 | 说明 |
|---|---|---|
| P1 | 非聊天流量过滤（见 8.1） | 存储优化，不阻塞 M1：不过滤时非聊天流量匹配不上 userText，对齐器丢弃，显示不会错；但记录文件会被高频小请求灌大，长期保留下需尽早处理 |
| P1 | 记录数据量控制（见 8.1） | 同类存储优化：完整请求体不默认存（只存对齐字段）；监控记录文件增长，必要时制定清理/失活策略。注："不默认存"是格式 spec 的字段集决策，Spike 1.5 定格式时就要落实（非事后补丁）；P1 管的是持续存储监控与清理策略 |

## 4. 现阶段不做

- 多用户、认证、分发
- PWA 壳（manifest / service worker / 添加到主屏）
- 写路径的具体机制（M2 前定方向）
- 手机端发起全新会话
- heimdall 记录启用前的历史内容（不回填、不显示模型内容）
- 记录清理 / 失活算法

## 5. 关键决策（讨论确认）

| 项 | 结论 |
|---|---|
| 模型内容数据源 | heimdall 路由侧**实时**记录（因要求流式，不能"请求完成后落盘"） |
| jsonl 的角色 | 仅作索引/状态源（会话/请求骨架、done、token 数） |
| diff 数据源 | `chatEditingSessions/` |
| 范围原则 | 只谈 heimdall 记录启用后的内容：历史会话不回填，项目范围 = heimdall 记录到的项目 |
| 记录保留 | 长期保留在电脑本地，暂不做失活/清理（后续可补） |
| "写"的范围 | 全部交互功能都在目标内，但**逐步实现**，第一步是发送文字消息 |
| M2 消息格式 | 纯文本 |
| diff 体验 | 最终完整实现，先做基础版（有待审编辑 + diff 内容展示） |
| 写路径具体机制 | **UIA 主路径**（2026-08-31 Spike 2 实测定稿：零侵入，不重启 VS Code/不开调试端口/不碰注册表；PowerShell + .NET UIAutomation 子进程按需调用；剪贴板粘贴注入 + 会话选择器切换）；CDP 降为备选（需调试端口启动参数） |
| 手机端 App 形态 | 早期仅浏览器（开发/测试用，不做 PWA 壳）；体验足够完整时直接打包为真 App（如 Capacitor） |
| 前端技术栈 | React 19 + Vite + TS + zustand（沿用 demo 已验证底座）；**移除 @assistant-ui/react**，展示层手写组件 |
| bridge 架构 | 不引入框架，现有裸 Node 骨架扩展 |
| 推送通知 | 待定 |

---

# Part 2：怎么做

## 6. 总体架构

```
手机端（早期浏览器，最终 App）◀── WebSocket（Tailscale）──▶ PC 桥接服务
                                                                ├── 读①：heimdall 请求/响应记录（模型内容：文本/思考/工具）
                                                                ├── 读②：chatSessions/*.jsonl 只当索引/状态源
                                                                │      （会话/请求骨架 + done + token 数）
                                                                │      + chatEditingSessions/（待审 diff）
                                                                │      → 对齐 → 规范化事件流
                                                                └── 写：注入 VS Code（M2 起，UIA 主路径，
                                                                       CDP 备选，见 6 降级链）
```

- 单一事实来源 = VS Code 进程内的真实 Copilot 会话（读方向直接读它的落盘数据，写方向驱动它的 UI）
- 手机和 PC 操作的是字面意义上的同一个 Copilot，记忆 / harness / 模型配置天然一致
- 写方向降级链（2026-08-31 Spike 2 实测后定稿）：**Windows UIA（主路径，零侵入实测通过）→ CDP（备选，需 `--remote-debugging-port` 启动）**；键盘注入（剪贴板 + 回车）已内化于 UIA 主路径（粘贴 + Enter 就是键盘注入）
- 进程拓扑：M1 两个进程（heimdall 生产路由 + copilot-bridge）；写路径 UIA 走 PowerShell 子进程按需调用（无常驻连接、无重资源），bridge 本体直接内嵌写模块，无需独立进程

**Spike 2 UIA 实测结论（2026-08-31，全链路验证通过）**：
- **前提**：VS Code 无障碍树是惰性的，`accessibilitySupport` 默认 auto 时树几乎为空（15 元素）；用户 settings.json 设 `"accessibilitySupport": "on"` 后完整构建（704 元素）。已写入用户配置，可逆；正式实现时需提示用户此前提
- **实现载体**：PowerShell + .NET UIAutomation（系统自带，零依赖零构建，~1s 延迟可接受）。nut-js 已证死路（libnut-win32 无元素检查能力，依赖已卸载）
- **注入流程（已验证）**：Win32 `ShowWindow(hwnd,9)+SetForegroundWindow` 激活 VS Code 窗口到前台（只做元素 SetFocus 不够，键盘事件发给前台窗口）→ 按 `ControlType=Edit` + 相对窗口坐标定位聊天输入框 → 元素 SetFocus → 剪贴板保存/写入/`SendKeys("^v")`/恢复。ValuePattern.SetValue 对 React 受控 contenteditable 无效（不触发 input 事件），必须走剪贴板粘贴
- **会话定位（已验证）**：读面板顶部 `Button 'Pick Agent Session'` 的 name = 当前会话标题；与 bridge SessionTitleStore（vscdb 权威标题）比对，不匹配则 Invoke 该按钮打开会话列表（顶部含 `Search agent sessions by name` 搜索框），ListItem name 格式 `"<标题>, Local • <相对时间>"`（取第一个逗号前段做标题前缀匹配）→ 点击 → 重读按钮 name 确认切换完成 → 再注入
- **窗口匹配**：标题 `*copilot-bridge - Visual Studio Code*`（工作区名在标题里，天然按窗口/项目隔离）
- **待确认（正式实现前）**：① Enter 发送行为（agent 模式长文本换行是否也是 Enter，需实测）；② 输入框定位坐标（spike 用屏幕绝对坐标 x>=2000,y>=1100，须改相对窗口定位）；③ 跨项目会话切换行为（列表默认只显示当前窗口项目的会话）

## 7. 环境事实（均已在本机验证）

### 7.1 软件环境

| 项 | 值 |
|---|---|
| OS | Windows |
| VS Code | 1.134.0，build 110a328ea54b42367b803ec53ee0bf52ef26b419，x64，安装于 `D:\App\Microsoft VS Code` |
| Copilot Chat 扩展 | publisher: GitHub，version 0.62.0，位于 `resources\app\extensions\copilot` |
| heimdall | `D:\code\projects\heimdall`，本地 OpenAI 兼容模型路由器（含 vendor failover，Electron GUI）；主 checkout 是**生产路由**（所有模型调用经它），不得直接修改，开发走 worktree |
| 模型标识 | `customendpoint/Heimdall/Qwen3.8-27B`（第三方模型走 heimdall 路由） |
| code 命令 | 已加入用户 PATH（`D:\App\Microsoft VS Code\bin`） |

### 7.2 API 边界（已核对 1.134.0 的 `vscode.d.ts`）

- `vscode.chat.createChatParticipant`：只能注册**自己的** chat participant
- **不存在**会话级 API：无法向内置 Copilot 会话注入消息、无法订阅其消息流、无法读取其会话状态
- `vscode.lm`（`selectChatModels` / `sendRequest`，含 tool calling）完整可用——但当前方向（接入 Copilot 本体）不需要它
- 结论：**读方向无 API 但可走本地文件；写方向无 API，只能 UI 自动化**

### 7.3 闭源事实（已验证）

- VS Code 编辑器本体：MIT 开源
- Copilot Chat 扩展：**闭源专有**。`extensions\copilot` 下无 `src` 目录，只有 `dist/` 共 21.3MB 编译混淆 JS + 专有 LICENSE
- 循环逻辑（上下文装配 / 截断 / 重试 / 停止条件）无法合法获取
- 本地日志是用户自己的数据，可作设计参考；反编译扩展代码 / 逐字复制系统提示词分发有版权风险（个人自用风险低）

### 7.4 本地会话存储（已验证；2026-08-27 起 jsonl 降级为索引/状态源）

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

## 8. 数据面

### 8.1 heimdall 请求/响应记录（待开发，Spike 1.5）

- 在 heimdall 仓库 worktree 分支（`feature/request-logging`）开发；**逐 chunk 实时 append** jsonl：`request_start`（模型名/元数据）→ 若干 `chunk`（文本/思考/工具增量）→ `request_end`（usage token 数）
- 配置开关默认关；记录失败必须静默降级、绝不影响转发（生产路由底线）
- **非聊天流量过滤【P1 高优先级优化项，见 §3 分层】**：heimdall 路由的是**所有**模型流量，代码补全 / inline edit 等非聊天流量（高频小请求）可能混入。**定位：过滤是存储优化，不是正确性要求**（不阻塞 M1）——非聊天流量的"用户消息"是模板/代码上下文，永远匹配不上 jsonl userText，对齐器会丢弃，显示不会错。设计原则：**宁可多记不可错杀**（保召回，精度无所谓）。候选信号（组合使用，命中任一聊天特征即记）：模型名（聊天模型才路由到 heimdall；注意 inline edit 也用聊天模型，会走 heimdall）、**tools 数组**（聊天 agent 带 22 个工具定义，补全/inline edit 大概率不带）、system prompt 指纹（聊天为固定 19KB，已验证）、messages 多轮结构。（"只记流式请求"已证伪——inline edit 也是流式。）实际流量构成与信号可靠性在 Spike 1.5a 验证
- **完整请求体不默认存【P1 高优先级优化项，见 §3 分层】**：请求体携带完整对话历史（LLM 惯例），每轮全存会使存储膨胀数倍，与长期保留冲突。默认只存对齐所需字段（最后一条用户消息文本 + 对话历史指纹）；完整请求体作为排障选项，默认关。此条是格式 spec 的字段集决策，Spike 1.5 定格式时落实；P1 分层管的是持续存储监控与清理策略
- **记录源可观察（防静默失效）**：记录失败在 heimdall 侧静默（底线），但 bridge 必须能发现"记录源断了"：跟踪最后一条记录的时间戳；会话 running 却长时间无新记录、或全局长时间零记录 → 会话总览显示"记录源异常"，用户可区分"模型没输出"与"链路断了"
- 按天滚动文件，长期保留（与 heimdall 现有 usage 记录同模式）
- 记录格式 spec（字段/路径/轮转/version 字段）放 heimdall `docs/`，copilot-bridge 引用；格式带 version，bridge 解析时校验
- 背景：所有模型调用（含流式 SSE）都经 heimdall 中转，在路由侧落盘 = 干净 JSON + 天然流式 + 零解析

### 8.2 jsonl 侧（已实现，只做索引）

- `tailer.ts`：chokidar 监听 `workspaceStorage\*\chatSessions\*.jsonl`，字节偏移增量读 + per-file drain 互斥；**行边界校验检测重写**（追加式 jsonl 的 offset 必然在行边界，前一字节是 `\n`；重写后旧 offset 指向某行中间 → 判定重写，重置偏移 + 等文件写入稳定后整读）
- `normalize.ts`：只提取会话元数据（sessionId/createdAt/model）、请求骨架（requestId/userText/ts）、`result` 收尾（done + **token 数**）。userText 是对齐主键的匹配目标，token 数用于对齐校验
- **完成判定 done 双来源（方案 A，2026-08-28）**：VS Code 对部分请求不写 jsonl `result`（实测 5 请求仅 3 有 result），单靠 result 会卡 "Working…"。故 done = ① jsonl `result`（`onKind1`）**或** ② heimdall 推导（`Aligner.finishTurn`：本次模型调用无 tool_call = agent 循环结束 → `markDone`），任一触发即完成。代价：heimdall 推导的 done 无 token 数/elapsed（可接受）
- 旧版 chunk 流解析管线（滑动窗口去重/chip 注入/时间线重建/围栏碎片过滤）已于 2026-08-27 删除；按范围原则不回填历史
- 已知遗留：重写检测后继续用原句柄读（若 VS Code 换文件/inode，句柄可能指向已删除旧文件）——用户取消过该修复，数据再丢时重审

### 8.3 会话归属对齐（⚠️ 关键风险点，方案承重墙，先验证后开发）

- 背景：heimdall 只见 HTTP 请求/响应，不知道请求属于哪个会话（sessionId 是 VS Code 内部概念，不出现在 HTTP 里）；多项目多会话**并行**时纯时间窗 + token 数不够（时间重叠、token 组合歧义）
- **对齐失败 = 整个读方案不成立**，必须先用最小实验验证可行性（Spike 1.5a），再投入 heimdall 记录功能开发
- 策略（2026-08-27 讨论修正，token 数从"主键"降级为"校验"）：
  - **主键**：heimdall 请求体最后一条用户消息 ↔ jsonl userText（agent 多轮调用中该消息不变，天然解决"一个 jsonl 请求对应多条 heimdall 记录"的一对多）
  - **消歧**：完整对话历史指纹（hash），处理不同会话发相同消息的碰撞
  - **校验**：时间窗 + token 数（usage），不匹配则报警/丢弃，不硬挂
- 已知难点：VS Code 发给模型的用户消息可能裹上下文（@文件等），与 jsonl userText 不严格相等，需归一化/包含匹配
- 编辑审批状态仍读 `chatEditingSessions/state.json`（不走模型，路由侧看不到）

**2026-08-27 离线验证结论（Spike 1.5a，承重墙已验证可解）**：
- **关键发现**：VS Code debug-logs `main.jsonl` 的 `chat:<model>` span attrs 直接含 `inputMessages`（完整请求消息数组）+ `userRequest`（裹上下文的用户消息）+ token 数——不改动 heimdall、不抓包即可离线验证对齐（debug-logs 仅近期保留、会截断，只作验证工具不作数据源）。
- **主键归一化规则（已验证）**：请求体最后一条 user 消息是裹了 `<context>/<editorContext>/<reminderInstructions>/<userRequest>` 标签的完整文本，其中 `<userRequest>...</userRequest>` 标签内容**与 jsonl userText 精确相等**（多请求会话实测 11/11 精确匹配、反向 span→请求 61/61 全命中）。归一化 = 正则提取 `<userRequest>` 标签内容，无需模糊/包含匹配；@文件等富内容场景标签结构待 1.5 补验，降级为归一化包含匹配。
- **一对多（已验证）**：agent 单轮多次模型调用的最后一条 user 消息不变（工具结果走 `role:tool`），天然归到同一 jsonl 请求；bridge 按 (会话, 主键) 分组 + 时间排序还原轮次。
- **token 校验（已验证）**：heimdall usage（request_end）与 VS Code span 的 token 数按**时序贪心配对**（span.ts 升序 ↔ usage.time 升序，inTok 单调）63/63 完全相等——证明 heimdall 记录可精确归属到会话/请求。
- **消歧指纹（机制成立）**：inputMessages 即完整对话历史，不同请求天然不同；单会话内未出现 userText 重复，跨会话相同消息用历史指纹区分。
- **残留（非阻塞）**：① @文件/截图等富内容消息的标签结构待 1.5 补验；② heimdall 侧请求体是 OpenAI 格式（content 可能为字符串或 parts 数组），提取规则需兼容；③ 并行会话同时发的真实碰撞样本待 1.5 在线验证。

**2026-08-28 在线验证修正（开发版 router 4100 + Qwen 3.8 27B DEV 真实流量，全链路打通）**：
- **`<userRequest>` 须取最后一个块**：离线结论"正则提取 `<userRequest>` 标签内容"在线验证发现不够——`<context>` 里可能回显含 `<userRequest>` 字面量的历史命令（如诊断脚本里的正则字面量 `([\s\S]*?)`），取第一个会误命中。真实用户输入总在 prompt 末尾，须 `matchAll` 取末段。
- **chunk 丢失竞态**：重启重放时 heimdall 记录可能先于 jsonl 请求定义被处理，onStart 时请求未进 normalizer → turn 进 pending，随后 chunk 到达时 turn 未 claim 被丢。修复：chunk/end 缓冲（claim 后补放）+ sweep 周期性重试 pending 匹配。
- **`@agent Try Again` 重试边界**：jsonl 文本是 `@agent Try Again`，但 heimdall lastUserText 仍是原始用户输入（重试不新增 user 消息）→ 该请求对不齐（已知边界，暂不阻塞）。

### 8.4 事件协议（bridge → 客户端）

`hello` / `session_list` / `replay`（客户端切换会话/重连时请求完整历史）/ `session` / `user_message` / `request_done`（done + token 数）。内容类事件（文本/思考/工具）待 heimdall 记录功能落地后扩展（`chunk` 事件类型已在协议中预留）。`hello` / `session_list` 带记录源健康字段（最后记录时间戳 / 异常标记）。

## 9. bridge 架构（Node）

- 技术栈：TypeScript + ESM（`tsx` 直跑，无构建）、`ws`、`chokidar`，**不引入框架**。服务 bind 127.0.0.1:8765，`npm run dev` 启动
- 现有骨架（5 个文件，<1000 行）：
  - `config.ts`：配置（端口/路径）
  - `tailer.ts`：文件监听与增量读取（含重写检测）
  - `normalize.ts`：jsonl 语义解析 → 状态机 → 事件
  - `server.ts`：HTTP（静态页）+ WebSocket（广播/replay）
  - `types.ts`：共享类型与事件协议
- 数据流：`jsonl ──chokidar──▶ tailer（切行/重写检测）──▶ normalize（语义→状态机）──▶ server（WS 广播）──▶ 客户端`
- M1 新增（同风格裸写，不套框架）：
  - **heimdall tailer**：tail heimdall 记录 jsonl（复用现有切行/偏移/重写检测机制）
  - **对齐器**：主键 + 指纹 + 校验三层，把模型内容挂到会话/请求
  - **normalize 扩展**：消费 heimdall 内容事件，产出 `chunk` 类事件
  - **chatEditingSessions 监听**：待审 diff 基础版（`state.json` 结构未验证，做之前先看真实文件）
  - **记录源健康状态**：最后 heimdall 记录时间戳 + 异常判定（见 8.1），暴露给前端
  - **项目名映射**：workspaceStorage hash → 项目路径（`workspace.json`），供会话总览显示项目名
- 不引框架的理由：项目复杂度是纵向（领域逻辑：jsonl 语义/重写检测/对齐），框架提供的是横向抽象（路由/中间件），形状不匹配；依赖面、调试路径、升级节奏都受益

## 10. 前端

- 技术栈：React 19 + Vite + TS + **zustand**（沿用 demo/ 已验证底座）
- **移除 @assistant-ui/react**：其定位是"主动对话 client"，与本项目"镜像/观察者"场景错配（convert.ts 翻译层、edit 折叠、ICON_RULES 等反复调整都是撞抽象）；展示层改手写组件
- 手写组件范围（界面结构自己写，难的部分继续用库）：消息列表、流式气泡、可折叠步骤组（"Finished with x steps"）、工具行、会话总览、diff 视图（基础版 = 带颜色的行列表）、输入框（M2）
- 继续用的库：react-markdown（流式 markdown 渲染）、jsdiff（diff 计算）、lucide-react（图标）
- 迁移：demo/ 迁移至 web/ 并由 bridge 托管（开发时仍用 Vite dev server 热更新）；web/ 旧 vanilla 代码删除
- 明确不引入：路由库（会话切换是状态不是路由）、CSS 框架、React Query 等数据层（数据是 WS 推的）
- 该栈是 Capacitor 官方支持最好的组合，App 形态后置决策不受影响

## 11. 通信与网络

- **WebSocket**（浏览器原生）常连 bridge :8765：模型流式输出每秒几十个事件，必须常开推送，不能轮询
- **断线重连 + replay 补齐**：断了自动重拨；重连后要全量快照覆盖本地（会话数据 KB 级，全量重发简单不出错）。开发阶段价值 = 重启服务器不用刷页面；手机/App 阶段价值 = 网络波动/切后台兜底
- **静态托管**：浏览器阶段 Vite 构建产物由 bridge 托管（同端口出文件和数据通道）；App 阶段 UI 打进包内，此部分退役
- **网络**：Tailscale（PC + 手机）；仅自己访问，暂不做认证，但预留 token 参数（成本低）

## 12. 已否决的备选方案（含原因，避免重复讨论）

| 方案 | 否决原因 |
|---|---|
| code tunnel / code-server | 桌面 UI 塞手机屏，不可用（已实测） |
| VS Code 扩展内自研 agent（chat participant + vscode.lm + 自研 harness） | 用户明确要 Copilot 本体，不要平行 agent |
| 独立 agent 服务 + 双端（跨设备无感但自研 agent） | 同上——"无感切换"架构思路保留，但 agent 必须是 Copilot 本体 |
| SSH + tmux + aider；OpenHands；aider + 薄桥 | 用户认为都不好（同样是平行 agent） |
| 1:1 复刻内置 harness | 版权风险 + 内置 harness 为官方模型调优，对第三方模型未必最优 |
| jsonl 响应 chunk 流解析（原读路径） | 过于脆弱：滑动窗口快照去重、周期性压缩重写（38MB 文件/23MB 头部行）、围栏碎片，反复出 bug → 2026-08-27 转向 heimdall 记录 |

## 13. 风险与边界（必须接受）

0. **会话归属对齐（关键风险点，方案承重墙）——✅ 2026-08-28 在线验证通过**：见 8.3。主键（`<userRequest>` 末段提取）/消歧（历史指纹）/校验（token 时序配对）三层在真实流量上均成立，浏览器正确渲染助手正文；在线验证修正"取末段"与 chunk 竞态两个 bug；残留 @文件富内容与并行碰撞样本不阻塞
1. **脆弱性**：写方向依赖 VS Code UI 结构，版本升级可能失效。缓解：固定 VS Code 版本 + Playwright 冒烟回归脚本（发消息→检查回复）
2. **VS Code 必须开着**：会话活在 VS Code 进程里，这是接入本体的固有约束
3. **法律边界**：读自己本地文件 = 合规；Windows UIA 自动化驱动自己机器上的 VS Code UI = 合规（等同自己操作，且零侵入：不改启动参数/注册表/进程配置）；反编译 / 复制分发微软代码 = 不做
4. **长期**：`vscode.chat` API 在持续扩张，若未来出现官方会话级 API，写方向可整体替换为干净实现，读方向不受影响
5. **项目名映射——✅ 2026-08-27 已验证**：`workspaceStorage\<hash>\workspace.json` 实测存在（37 个目录 34 个有，缺的 3 个是 ext-dev 等特殊目录）。单根 `folder`=file URI、多根 `workspace`=.code-workspace 路径；项目名取路径末段（多根取 .code-workspace 文件名，folders 为空时降级显示文件名）。无需降级方案
6. **chatEditingSessions/state.json 结构——✅ 2026-08-27 已验证**：实测结构 = `{version:2, initialFileContents:[[uri,hash]], timeline:{checkpoints[], currentEpoch, fileBaselines[], operations:[{type:'textEdit'|'delete', uri, requestId, epoch, edits:[{text,range}]}]}, recentSnapshot:{entries:[{resource, originalHash, currentHash, state, ...}]}}`；`contents/<7位hash>`=文件内容，`originalHash`/`currentHash` 都指向 contents/ 文件 → **diff 可还原**（两文件对比或读 operations edits）。残留：`state` 枚举值（实测 0/1/2）与"待审"状态的映射待 M1 开发时触发一次待审编辑确认（低成本、非阻塞）

## 14. 验证计划（spikes）

| Spike | 内容 | 通过标准 | 状态 |
|---|---|---|---|
| 1（先做，低风险） | 文件监听 → 事件流 → 最简网页实时显示当前会话 | 浏览器上看到真实 Copilot 会话随 PC 侧操作更新 | **基础设施已跑通**（tailer/WS/前端）；"内容显示"目标由 1.5 系列接管（内容源改为 heimdall） |
| **1.5a（关键风险验证，最高优先级）** | **对齐可行性最小实验**：抓 1-2 个真实 heimdall 请求体（临时开启请求体日志或代理抓包），对比 jsonl userText，验证"最后一条用户消息匹配"在真实数据上成立（含并行会话、@上下文包裹情况）；顺带摸清 heimdall 实际收到的流量构成（非聊天流量占比），确定过滤规则 | 真实数据上主键匹配成功率可接受，消歧/归一化规则明确，过滤规则明确 | **✅ 2026-08-27 离线验证通过**（用 debug-logs 替代 heimdall 请求体 + usage jsonl 替代 request_end；主键/消歧/token 三层均成立，见 8.3；非聊天流量过滤规则与 @文件富内容待 1.5 在线补验） |
| 1.5（读路径重构，2026-08-27 立项） | heimdall 加请求/响应记录（worktree 分支开发）；bridge 读路径改为 heimdall 记录 + jsonl 索引混合 | 流式文本/思考/工具从 heimdall 记录可靠还原，会话归属按对齐策略（8.3）成功 | **✅ 2026-08-28 在线验证通过**（开发版 router 4100 + Qwen 3.8 27B DEV 真实流量：router 落盘 → bridge 读取 → aligner 对齐 → 浏览器渲染助手正文全链路打通）。在线验证暴露并修复 3 个 bug：① lastUserText 是完整 prompt 非纯输入（须提取 `<userRequest>`）；② 取最后一个 `<userRequest>` 块（context 可能回显含该标签字面量的历史命令）；③ chunk 丢失竞态（重启重放 heimdall 先于 jsonl，须缓冲 chunk + pending 重试）。**残留**：@文件富内容/并行碰撞样本/非聊天流量过滤（不阻塞） |
| 2 | 写路径验证（机制 2026-08-31 由 CDP 改为 **Windows UIA**）：不重启 VS Code/不开调试端口，PowerShell + .NET UIAutomation 定位会话（Pick Agent Session 选择器）+ 输入框，剪贴板粘贴注入一条消息 | 消息出现在 PC 的 Copilot 会话中，回复两端都可见 | **✅ 2026-08-31 实测通过**（注入 + 会话定位全链路验证，结论见 6；CDP 方案因需 `--remote-debugging-port` 启动参数被用户否决后弃用） |

Spike 链：**1.5a（对齐验证，承重墙）→ 1.5（heimdall 记录 + 读路径）→ 2（写路径）**；1.5a 不过 = 读方案回炉。

## 15. 下一步

1. ~~确认技术栈~~ / ~~Spike 1 实现~~（已完成）
2. ~~读路径转向 heimdall 记录 + jsonl 索引~~（代码已重构，见 8.2）
3. ~~Spike 1.5a：对齐可行性验证~~（2026-08-27 离线验证通过，见 8.3；残留 @文件富内容/并行碰撞样本/非聊天流量过滤规则并入 1.5 在线补验）
4. ~~Spike 1.5：heimdall 请求/响应记录~~（2026-08-27 完成：worktree `feature/request-logging` 已提交，request_start/chunk/request_end 逐事件实时 append，配置开关默认关，10 个测试套件全过，格式 spec 定稿于 heimdall `docs/request-logging-format.md`；第二实例验证由 E2E 测试覆盖——独立端口+独立数据目录的 router 实例）
5. ~~copilot-bridge 读路径对接 heimdall 记录；对齐器实现（主键+指纹+校验三层）~~（2026-08-27 代码完成；**2026-08-28 真实流量在线验证通过**：开发版 router 4100 + Qwen 3.8 27B DEV，全链路打通，浏览器正确渲染助手正文；修复 lastUserText 包装/取末段/chunk 竞态 3 个 bug。残留 @文件富内容/并行碰撞/非聊天流量过滤不阻塞）
6. ~~验证两个未验证假设（风险 5/6）~~（2026-08-27 已验证：workspace.json 映射可行 + state.json 结构已取样，diff 可还原；残留仅 state 枚举与"待审"状态映射，M1 开发时触发一次待审编辑确认）
7. ~~前端迁移（demo/ → web/，去 assistant-ui）~~（2026-08-27 完成：手写组件替代 assistant-ui，react-markdown/lucide-react 保留，构建通过，内置浏览器验证会话列表/用户气泡/连接状态正常）+ 安装 Tailscale（PC + 手机），浏览器访问 `http://<PC的tailscale-ip>:8765` 验证
8. ~~Spike 2：写路径验证~~（2026-08-31 实测通过，机制 UIA 定稿，见 6/14）；后续：M2 正式实现（Enter 发送实测、坐标相对窗口化、Node 注入模块 + WS `send_message` + 前端输入框）、diff 基础版（M1 最后一块）、审批流细化（chatEditingSessions）、通知、服务自启、VS Code 升级回归机制

## 16. 用户偏好（新会话必须遵守）

- 中文（简体）回复，简洁、先结论后步骤
- Commit 格式（Angular）：`<type>(<lowercase-scope>): <中文 subject>`
- 命令行一律 Windows PowerShell 语法
- 最小必要改动，修根因不做表面补丁
- 不主动创建说明类 .md/.txt 文件（本文档是用户明确要求的例外）
- 日志规范：不用 `print("="*60)` 分割线、不用 `\n` 做 print 换行、不用 ✓/× 符号
- 存在多种方案时先分析利弊给推荐，用户确认后再写代码
- 回答中若创建临时文件，结束前必须清理
