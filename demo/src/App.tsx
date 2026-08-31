import { useEffect, useMemo, useState } from 'react';
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  useAssistantState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useShallow } from 'zustand/shallow';
import {
  Thread,
  makeMarkdownText,
  UserMessage as DefaultUserMessage,
  UserActionBar,
  AssistantMessage as DefaultAssistantMessage,
  AssistantActionBar,
  BranchPicker,
} from '@assistant-ui/react-ui';
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
import remarkGfm from 'remark-gfm';
import { useDemoStore, startConnection, selectSession, type SessionState } from './store';
import { sessionToMessages } from './convert';

/** 只读模式：隐藏输入框（写方向是 Spike 2 的事） */
function ReadOnlyFooter() {
  return (
    <div className="px-4 py-3 text-center text-xs text-muted-foreground border-t border-border">
      只读视图 · 写方向（Spike 2）开发中
    </div>
  );
}

/**
 * markdown 文本组件（react-ui 默认 Text 是纯文本，需显式挂上 markdown 渲染）。
 * 注入 remark-gfm：react-markdown v10 默认仅 CommonMark，表格/删除线/任务列表等
 * GFM 语法必须靠该插件，否则 `|` 表格会被当纯文本渲染。
 */
const MarkdownText = makeMarkdownText({ remarkPlugins: [remarkGfm] });

/**
 * 用户消息：复用 react-ui 默认结构，仅把 Text 换成 markdown 渲染。
 * （react-ui 的 userMessage 配置不消费 components.Text，必须整体覆盖 UserMessage）
 */
function MarkdownUserMessage() {
  return (
    <DefaultUserMessage.Root>
      <DefaultUserMessage.Attachments />
      <MessagePrimitive.If hasContent>
        <UserActionBar />
        <DefaultUserMessage.Content components={{ Text: MarkdownText }} />
      </MessagePrimitive.If>
      <BranchPicker />
    </DefaultUserMessage.Root>
  );
}

/* ---------------- 工具 → 图标 ---------------- */

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

/** 按 toolName 选图标；无法识别时回退 Wrench */
function toolIcon(toolName: string) {
  for (const [re, Icon] of ICON_RULES) if (re.test(toolName)) return Icon;
  return Wrench;
}

/* ---------------- 时间轴 ---------------- */

type Part = {
  type: string;
  text?: string;
  toolName?: string;
  args?: { message?: string; pastTenseMessage?: string };
  argsText?: string;
};

function isProcessPart(p: Part) {
  return p.type === 'reasoning' || p.type === 'tool-call';
}

/** 工具调用的时间轴标签：优先过去式（Read / Searched…），回退进行式，再回退工具名 */
function toolLabel(p: Part): string {
  return p.args?.pastTenseMessage || p.args?.message || p.argsText || p.toolName || 'tool';
}

/** 单条时间轴行：工具调用带图标，思考带圆点 */
function TimelineRow({ part }: { part: Part }) {
  if (part.type === 'tool-call') {
    const Icon = toolIcon(part.toolName ?? '');
    return (
      <div className="flex gap-2.5 py-1">
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground/90">
          {toolLabel(part)}
        </span>
      </div>
    );
  }
  // reasoning
  const text = (part.text ?? '').trim();
  if (!text) return null;
  return (
    <div className="flex gap-2.5 py-1">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
        {text}
      </span>
    </div>
  );
}

/**
 * 一组连续的 思考 + 工具调用 → 折叠时间轴（模仿 Copilot "Finished with x steps"）。
 * 默认折叠；展开后是竖向时间轴，工具行带图标、思考行带圆点。
 */
function StepsGroup({ parts, running }: { parts: Part[]; running: boolean }) {
  const n = parts.filter((p) => p.type === 'tool-call').length;
  const hasReasoning = parts.some((p) => p.type === 'reasoning');
  const label = running
    ? 'Working…'
    : n > 0
      ? `Finished with ${n} step${n === 1 ? '' : 's'}`
      : '思考过程';
  return (
    <details className="group my-1.5">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {running ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-[#89d185]" />
        )}
        <span>{label}</span>
        {hasReasoning && n > 0 && (
          <span className="text-[11px] text-muted-foreground/70">· 含思考</span>
        )}
      </summary>
      <div className="mt-1.5 ml-[7px] border-l border-border pl-3">
        {parts.map((p, i) => (
          <TimelineRow key={i} part={p} />
        ))}
      </div>
    </details>
  );
}

/**
 * 助手消息：把 思考 + 工具调用 折叠成 "Finished with x steps" 时间轴，
 * 文本段落（含最终回答）在时间轴外以 markdown 渲染。
 * 数据来自消息级 context（core 的 MessageByIndexProvider 在本组件外层建立）。
 */
function CustomAssistantMessage() {
  const parts = useAssistantState(useShallow((s) => s.message.parts)) as Part[];
  const status = useAssistantState((s) => s.message.status);
  const running = status?.type === 'running';

  const nodes = useMemo(() => {
    const out: Array<{ kind: 'group'; parts: Part[] } | { kind: 'text'; index: number }> = [];
    let group: Part[] = [];
    const flush = () => {
      if (group.length) {
        out.push({ kind: 'group', parts: group });
        group = [];
      }
    };
    parts.forEach((p, i) => {
      if (isProcessPart(p)) {
        group.push(p);
      } else if (p.type === 'text' && (p.text ?? '').trim()) {
        flush();
        out.push({ kind: 'text', index: i });
      }
    });
    flush();
    return out;
  }, [parts]);

  // 只有消息末尾的步骤组才是"活跃"的；前面的组（模型已走完）一律显示 Finished
  const lastGroupIdx = nodes.map((n) => n.kind).lastIndexOf('group');

  return (
    <DefaultAssistantMessage.Root>
      <DefaultAssistantMessage.Avatar />
      <div className="min-w-0 flex-1">
        {nodes.length === 0 ? (
          <div className="flex items-center gap-1.5 py-1 text-[13px] text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            思考中…
          </div>
        ) : (
          nodes.map((n, i) =>
            n.kind === 'group' ? (
              <StepsGroup
                key={`g${i}`}
                parts={n.parts}
                running={running && i === lastGroupIdx}
              />
            ) : (
              // 文本段落在 PartByIndexProvider 内渲染，MarkdownText 才能从 part context 读到 text
              <MessagePrimitive.PartByIndex
                key={`t${n.index}`}
                index={n.index}
                components={{ Text: MarkdownText }}
              />
            ),
          )
        )}
      </div>
      <BranchPicker />
      <AssistantActionBar />
    </DefaultAssistantMessage.Root>
  );
}

function Runtime({ children }: { children: React.ReactNode }) {
  const version = useDemoStore((s) => s.version);
  const activeSessionId = useDemoStore((s) => s.activeSessionId);

  const messages = useMemo<ThreadMessageLike[]>(() => {
    void version;
    const s = useDemoStore.getState();
    const sess = activeSessionId ? s.sessions.get(activeSessionId) : undefined;
    if (!sess) return [];
    return sessionToMessages(sess.order, sess.requests);
  }, [version, activeSessionId]);

  const isRunning = useMemo(() => {
    void version;
    const s = useDemoStore.getState();
    const sess = s.activeSessionId ? s.sessions.get(s.activeSessionId) : undefined;
    if (!sess) return false;
    return sess.order.some((id) => !sess.requests.get(id)?.done);
  }, [version, activeSessionId]);

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    // messages 已是 ThreadMessageLike，恒等转换（0.11 要求非 ThreadMessage 时提供 convertMessage）
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {
      // 只读：忽略发送
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
  );
}

/** 会话项：标题（无则 sessionId 前缀）+ 模型 */
function SessionItem({
  sess,
  active,
  onSelect,
}: {
  sess: SessionState;
  active: boolean;
  onSelect: () => void;
}) {
  const label = sess.title || sess.sessionId.slice(0, 8);
  return (
    <button
      onClick={onSelect}
      className={
        'w-full truncate rounded px-2 py-1.5 text-left text-[13px] ' +
        (active
          ? 'bg-secondary text-foreground'
          : 'text-foreground/80 hover:bg-secondary/60')
      }
      title={sess.title ?? sess.sessionId}
    >
      <span className="block truncate">{label}</span>
      {sess.model && (
        <span className="block truncate text-[11px] text-muted-foreground">
          {sess.model}
        </span>
      )}
    </button>
  );
}

/** 侧边栏：按项目分组，每组可折叠，组内会话按最近活跃排序 */
function Sidebar({
  sessions,
  activeSessionId,
}: {
  sessions: SessionState[];
  activeSessionId: string | null;
}) {
  // 默认全展开；折叠状态按项目 key 记录
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const byProject = new Map<string, SessionState[]>();
    for (const s of sessions) {
      const key = s.project || '未分组';
      const arr = byProject.get(key);
      if (arr) arr.push(s);
      else byProject.set(key, [s]);
    }
    // 组按组内最近活跃排序，组内会话按最近活跃排序
    return [...byProject.entries()]
      .map(([project, list]) => ({
        project,
        list: list.sort((a, b) => b.lastActivity - a.lastActivity),
        lastActivity: list[0].lastActivity,
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }, [sessions]);

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (groups.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-muted-foreground">
        暂无会话
      </div>
    );
  }

  return (
    <nav className="flex-1 overflow-y-auto px-2 py-2">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.project);
        return (
          <div key={g.project} className="mb-1">
            <button
              onClick={() => toggle(g.project)}
              className="flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={
                  'h-3.5 w-3.5 shrink-0 transition-transform ' +
                  (isCollapsed ? '' : 'rotate-90')
                }
              />
              <span className="truncate">{g.project}</span>
              <span className="ml-auto text-[10px] text-muted-foreground/70">
                {g.list.length}
              </span>
            </button>
            {!isCollapsed && (
              <div className="mt-0.5 space-y-0.5 pl-1">
                {g.list.map((s) => (
                  <SessionItem
                    key={s.sessionId}
                    sess={s}
                    active={s.sessionId === activeSessionId}
                    onSelect={() => selectSession(s.sessionId)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default function App() {
  const connected = useDemoStore((s) => s.connected);
  const version = useDemoStore((s) => s.version);
  const activeSessionId = useDemoStore((s) => s.activeSessionId);
  const error = useDemoStore((s) => s.error);

  useEffect(() => {
    startConnection();
  }, []);

  const sessions = useMemo(() => {
    void version;
    return [...useDemoStore.getState().sessions.values()].sort(
      (a, b) => b.lastActivity - a.lastActivity,
    );
  }, [version]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <h1 className="flex-1 truncate text-sm font-semibold">Copilot Bridge Demo</h1>
        <span className={connected ? 'text-[#89d185] text-xs' : 'text-muted-foreground text-xs'}>
          {connected ? '已连接' : '连接中…'}
        </span>
      </header>
      {error && (
        <div className="border-b border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
          <Sidebar sessions={sessions} activeSessionId={activeSessionId} />
        </aside>
        <div className="min-h-0 flex-1">
          <Runtime>
            <Thread
              assistantMessage={{
                allowReload: false,
                allowCopy: true,
                allowSpeak: false,
                allowFeedbackPositive: false,
                allowFeedbackNegative: false,
              }}
              userMessage={{ allowEdit: false }}
              branchPicker={{ allowBranchPicker: false }}
              components={{
                Composer: () => null,
                MessagesFooter: ReadOnlyFooter,
                UserMessage: MarkdownUserMessage,
                AssistantMessage: CustomAssistantMessage,
              }}
            />
          </Runtime>
        </div>
      </div>
    </div>
  );
}
