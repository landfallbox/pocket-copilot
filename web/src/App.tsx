import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Brain,
  Bug,
  ChevronRight,
  CircleCheck,
  Code2,
  FileCode2,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  LoaderCircle,
  Play,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useStore, startConnection, selectSession, type Item } from './store';

/* ============================================================
   工具 → 图标
   ============================================================ */

const ICON_RULES: Array<[RegExp, typeof FileText]> = [
  [/readFile|ReadFile/, FileText],
  [/createFile|CreateFile/, FilePlus],
  [/replaceString|ReplaceString|multiReplace|MultiReplace|replace/, FilePen],
  [/edit|Edit/, FilePen],
  [/listDirectory|ListDirectory/, FolderOpen],
  [/findText|FindText|search|Search/, Search],
  [/getErrors|GetErrors|diagnostic|Diagnostic/, Bug],
  [/memory|Memory/, Brain],
  [/browser|Browser|navigate|Navigate|read_page|screenshot/, Globe],
  [/terminal|Terminal/, Terminal],
  [/playwright|Playwright|run_code/, Play],
  [/todo|Todo|task|Task/, ListChecks],
  [/github|Github|GitHub/, Code2],
  [/fetch|Fetch|web|Web/, Globe],
  [/code|Code/, FileCode2],
];

function toolIcon(toolName: string) {
  for (const [re, Icon] of ICON_RULES) if (re.test(toolName)) return Icon;
  return Wrench;
}

/** 工具名 → 中文标签（贴近 Copilot 步骤描述风格） */
function toolLabel(name: string): string {
  const map: Array<[RegExp, string]> = [
    [/fetch|webpage|web/i, '抓取网页'],
    [/terminal/i, '运行命令'],
    [/read_file|readFile/i, '读取文件'],
    [/grep|search|find/i, '搜索'],
    [/list_dir|listDirectory/i, '列出目录'],
    [/create_file|createFile/i, '创建文件'],
    [/replace|edit|multi_replace/i, '编辑文件'],
    [/get_errors|diagnostic/i, '检查错误'],
    [/memory/i, '记忆'],
    [/browser|navigate/i, '浏览器'],
    [/todo|task/i, '任务'],
    [/github|code/i, '查询代码'],
  ];
  for (const [re, label] of map) if (re.test(name)) return label;
  return name;
}

/* ============================================================
   时间轴（思考 + 工具调用）
   ============================================================ */

type Part =
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolName: string; label: string }
  | { type: 'text'; text: string }
  | { type: 'question'; title?: string; message: string; options?: string[] };

/** items → 展示 part 序列（edit 归并成工具调用，status 忽略；连续 text/reasoning 合并） */
function toParts(items: Item[]): Part[] {
  const out: Part[] = [];
  // 连续同类型（text/reasoning）合并：后端 flush 时序（jsonl done 早于 heimdall 流结束）
  // 会把一段正文切成多个 item，前端合并还原成连续段落
  const append = (type: 'reasoning' | 'text', text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  for (const it of items) {
    if (it.type === 'thinking' && it.text) append('reasoning', it.text);
    else if (it.type === 'text' && it.text) append('text', it.text);
    else if (it.type === 'tool_call' && it.tool) {
      const name = it.tool.message ?? it.tool.toolId ?? 'tool';
      out.push({ type: 'tool-call', toolName: name, label: toolLabel(name) });
    } else if (it.type === 'edit' && it.edit) {
      const label = `编辑文件：${it.edit.fsPath ?? '?'}`;
      out.push({ type: 'tool-call', toolName: 'edit', label });
    } else if (it.type === 'question' && it.question) {
      out.push({
        type: 'question',
        title: it.question.title,
        message: it.question.message ?? '',
        options: it.question.options,
      });
    }
  }
  return out;
}

/** 单步折叠行：默认收起，点击展开（贴近 Copilot 的步骤/思考折叠行为） */
function StepRow({
  icon: Icon,
  label,
  running,
  children,
}: {
  icon: typeof FileText;
  label: string;
  running?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group my-0.5">
      <summary className="flex cursor-pointer select-none items-center gap-2 rounded px-1 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90" />
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {running ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
      </summary>
      <div className="ml-[9px] mt-1 border-l border-border pl-3">{children}</div>
    </details>
  );
}

function TimelineRow({ part, running }: { part: Part; running?: boolean }) {
  if (part.type === 'tool-call') {
    const Icon = toolIcon(part.toolName);
    return (
      <StepRow icon={Icon} label={part.label} running={running}>
        <div className="py-0.5 text-[12.5px] text-muted-foreground">
          <code className="rounded bg-secondary/60 px-1 py-0.5 text-[12px]">{part.toolName}</code>
        </div>
      </StepRow>
    );
  }
  if (part.type === 'question') {
    return (
      <div className="my-1 rounded-md border border-border bg-secondary/40 px-3 py-2 text-[13px]">
        {part.title && <div className="font-semibold">{part.title}</div>}
        <div className="whitespace-pre-wrap text-foreground/90">{part.message}</div>
        {part.options?.length ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {part.options.map((o) => (
              <span key={o} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                {o}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  // reasoning → 折叠“思考过程”（默认收起，点击展开）
  const text = (part.text ?? '').trim();
  if (!text) return null;
  return (
    <StepRow icon={Brain} label="思考过程" running={running}>
      <div className="py-0.5">
        <span className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">{text}</span>
      </div>
    </StepRow>
  );
}

/** 一组连续的 思考+工具 → 外层折叠（"Finished with x steps"），展开后每个步骤独立折叠（贴近 Copilot 两层折叠） */
function StepsGroup({ parts, running }: { parts: Part[]; running: boolean }) {
  const n = parts.filter((p) => p.type === 'tool-call').length;
  const hasReasoning = parts.some((p) => p.type === 'reasoning');
  const label = running
    ? 'Working…'
    : n > 0
      ? `Finished with ${n} step${n === 1 ? '' : 's'}`
      : '思考过程';
  const lastStepIdx = parts.length - 1;
  return (
    <details className="group my-1">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 rounded px-1 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90" />
        {running ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-[#89d185]" />
        )}
        <span>{label}</span>
        {hasReasoning && n > 0 && <span className="text-[11px] text-muted-foreground/70">· 含思考</span>}
      </summary>
      <div className="ml-[9px] mt-1 border-l border-border pl-3">
        {parts.map((p, i) => (
          <TimelineRow key={i} part={p} running={running && i === lastStepIdx} />
        ))}
      </div>
    </details>
  );
}

/* ============================================================
   消息
   ============================================================ */

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end py-1.5">
      <div className="markdown-body max-w-[85%] rounded-xl bg-accent px-3.5 py-2 text-[14px] leading-relaxed text-accent-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

/** 助手消息：连续思考+工具归外层折叠组（"Finished with x steps"），正文 markdown 常显 —— 贴近 Copilot */
function AssistantMessage({ parts, running }: { parts: Part[]; running: boolean }) {
  const blocks: Array<
    | { kind: 'group'; parts: Part[] }
    | { kind: 'text'; text: string }
    | { kind: 'question'; part: Part }
  > = [];
  let steps: Part[] = [];
  const flushSteps = () => {
    if (steps.length) {
      blocks.push({ kind: 'group', parts: steps });
      steps = [];
    }
  };
  for (const p of parts) {
    if (p.type === 'reasoning' || p.type === 'tool-call') steps.push(p);
    else if (p.type === 'text' && p.text.trim()) {
      flushSteps();
      blocks.push({ kind: 'text', text: p.text });
    } else if (p.type === 'question') {
      flushSteps();
      blocks.push({ kind: 'question', part: p });
    }
  }
  flushSteps();

  const lastGroupIdx = blocks.map((b) => b.kind).lastIndexOf('group');

  return (
    <div className="flex gap-2.5 py-1.5">
      <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
        AI
      </span>
      <div className="min-w-0 flex-1">
        {blocks.length === 0 ? (
          <div className="flex items-center gap-1.5 py-1 text-[13px] text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            思考中…
          </div>
        ) : (
          blocks.map((b, i) =>
            b.kind === 'group' ? (
              b.parts.length === 1 ? (
                // 单步（仅 1 个 part）：独立折叠（默认收起可展开），不套外层组
                <div key={i}>
                  <TimelineRow part={b.parts[0]} running={running && i === lastGroupIdx} />
                </div>
              ) : (
                // 多步（≥2 个连续 part）：外层折叠 "Finished with x steps" / "思考过程"
                <StepsGroup key={i} parts={b.parts} running={running && i === lastGroupIdx} />
              )
            ) : b.kind === 'text' ? (
              <div key={i} className="markdown-body my-1 text-[14px] leading-relaxed text-foreground/95">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown>
              </div>
            ) : (
              <div key={i}>
                <TimelineRow part={b.part} />
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

/* ============================================================
   会话视图
   ============================================================ */

function SessionView() {
  const version = useStore((s) => s.version);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const bottomRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    void version;
    const s = useStore.getState();
    const sess = activeSessionId ? s.sessions.get(activeSessionId) : undefined;
    if (!sess) return null;
    const msgs: Array<{ id: string; role: 'user' | 'assistant'; text?: string; parts?: Part[]; running?: boolean }> = [];
    for (const rid of sess.order) {
      const r = sess.requests.get(rid);
      if (!r) continue;
      if (r.userText) msgs.push({ id: `${rid}-u`, role: 'user', text: r.userText });
      const parts = toParts(r.items);
      if (parts.length || !r.done) msgs.push({ id: `${rid}-a`, role: 'assistant', parts, running: !r.done });
    }
    return { msgs, sess };
  }, [version, activeSessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [version, activeSessionId]);

  if (!data) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">选择左侧会话</div>;
  }
  return (
    <div className="h-full overflow-y-auto px-3 py-2">
      {data.msgs.map((m) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} text={m.text ?? ''} />
        ) : (
          <AssistantMessage key={m.id} parts={m.parts ?? []} running={!!m.running} />
        ),
      )}
      <div ref={bottomRef} />
    </div>
  );
}

/* ============================================================
   主框架
   ============================================================ */

export default function App() {
  const connected = useStore((s) => s.connected);
  const recorder = useStore((s) => s.recorder);
  const version = useStore((s) => s.version);
  const activeSessionId = useStore((s) => s.activeSessionId);

  useEffect(() => {
    startConnection();
  }, []);

  const sessions = useMemo(() => {
    void version;
    return [...useStore.getState().sessions.values()].sort(
      (a, b) => b.lastActivity - a.lastActivity,
    );
  }, [version]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <h1 className="flex-1 truncate text-sm font-semibold">Copilot Bridge</h1>
        {recorder?.stale && (
          <span className="text-xs text-destructive" title="VS Code 有活动但 heimdall 长时间无新记录，链路可能断了">
            记录异常
          </span>
        )}
        <span className={connected ? 'text-xs text-[#89d185]' : 'text-xs text-muted-foreground'}>
          {connected ? '已连接' : '连接中…'}
        </span>
      </header>
      <div className="flex gap-1.5 overflow-x-auto border-b border-border bg-background px-3 py-2">
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            onClick={() => selectSession(s.sessionId)}
            className={
              'whitespace-nowrap rounded-full border px-3 py-1 text-xs ' +
              (s.sessionId === activeSessionId
                ? 'border-primary text-primary'
                : 'border-border text-foreground hover:bg-secondary')
            }
          >
            {s.project ?? s.sessionId.slice(0, 8)}
            {s.model ? ` · ${s.model}` : ''}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <SessionView />
      </div>
      <footer className="border-t border-border px-4 py-2 text-center text-xs text-muted-foreground">
        只读视图 · 写方向（Spike 2）开发中
      </footer>
    </div>
  );
}
