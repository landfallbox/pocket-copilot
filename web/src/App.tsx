import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FluentProvider,
  webDarkTheme,
  Spinner,
  makeStyles,
} from '@fluentui/react-components';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  ChevronRightRegular as ChevronRightIcon,
  ChevronDownRegular as ChevronDownIcon,
  DismissRegular as DismissIcon,
  SendRegular as SendIcon,
  CheckmarkCircleRegular as CheckmarkCircleIcon,
  WrenchRegular as WrenchIcon,
  DocumentRegular as DocumentIcon,
  DocumentAddRegular as DocumentAddIcon,
  DocumentEditRegular as DocumentEditIcon,
  FolderOpenRegular as FolderOpenIcon,
  SearchRegular as SearchIcon,
  BugRegular as BugIcon,
  BrainRegular as BrainIcon,
  GlobeRegular as GlobeIcon,
  WindowRegular as TerminalIcon,
  PlayRegular as PlayIcon,
  TaskListLtrRegular as ListChecksIcon,
  CodeRegular as CodeIcon,
  NavigationRegular as MenuIcon,
  ChatRegular as ChatIcon,
} from '@fluentui/react-icons';
import type { SessionSummary } from '@microsoft/agent-host-protocol';
import {
  useAhpStore,
  startConnection,
  selectSession,
  sendMessage,
  loadOlder,
} from './store';
import { chatToMessages, type Message, type Part } from './convert';

// ============================================================================
// = 主题                                                                      =
// ============================================================================

/** 固定深色 Fluent 基底（不再读取 VS Code 主题），语义色由 --vscode-* 变量统一覆盖 */
function useFluentBaseTheme() {
  return webDarkTheme;
}

// ============================================================================
// = 工具 → 图标                                                               =
// ============================================================================

const ICON_RULES: Array<[RegExp, typeof DocumentIcon]> = [
  [/readFile|ReadFile/, DocumentIcon],
  [/createFile|CreateFile/, DocumentAddIcon],
  [/replaceString|ReplaceString|multiReplace|MultiReplace|replace|edit|Edit/, DocumentEditIcon],
  [/listDirectory|ListDirectory/, FolderOpenIcon],
  [/findText|FindText|search|Search/, SearchIcon],
  [/getErrors|GetErrors|diagnostic|Diagnostic/, BugIcon],
  [/memory|Memory/, BrainIcon],
  [/browser|Browser|navigate|Navigate|read_page|screenshot|fetch|Fetch|web|Web/, GlobeIcon],
  [/terminal|Terminal/, TerminalIcon],
  [/playwright|Playwright|run_code/, PlayIcon],
  [/todo|Todo|task|Task/, ListChecksIcon],
  [/github|Github|GitHub|code|Code/, CodeIcon],
];

function toolIcon(toolName: string) {
  for (const [re, Icon] of ICON_RULES) if (re.test(toolName)) return Icon;
  return WrenchIcon;
}

// ============================================================================
// = 时间轴（步骤折叠）                                                        =
// ============================================================================

const timelineStyles = makeStyles({
  row: {
    display: 'flex',
    gap: '10px',
    padding: '3px 0',
    alignItems: 'flex-start',
  },
  iconWrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    flexShrink: 0,
    marginTop: '2px',
    color: 'var(--vscode-muted-fg)',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: 'var(--vscode-muted-fg)',
    opacity: 0.6,
  },
  toolLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: '13px',
    lineHeight: '1.4',
    color: 'var(--vscode-foreground)',
    opacity: 0.9,
  },
  reasoning: {
    flex: 1,
    minWidth: 0,
    fontSize: '12.5px',
    lineHeight: '1.5',
    color: 'var(--vscode-muted-fg)',
    whiteSpace: 'pre-wrap',
  },
});

function TimelineRow({ part }: { part: Part }) {
  const styles = timelineStyles();
  if (part.type === 'tool-call') {
    const Icon = toolIcon(part.toolName);
    return (
      <div className={styles.row}>
        <span className={styles.iconWrap}>
          <Icon fontSize={14} />
        </span>
        <span className={styles.toolLabel}>{part.label}</span>
      </div>
    );
  }
  const text = part.text.trim();
  if (!text) return null;
  return (
    <div className={styles.row}>
      <span className={styles.iconWrap}>
        <span className={styles.dot} />
      </span>
      <span className={styles.reasoning}>{text}</span>
    </div>
  );
}

const stepsStyles = makeStyles({
  summary: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: '13px',
    color: 'var(--vscode-muted-fg)',
  },
  chevron: {
    transition: 'transform 0.15s',
    transform: 'rotate(0deg)',
  },
  chevronOpen: {
    transform: 'rotate(90deg)',
  },
  body: {
    marginTop: '6px',
    marginLeft: '7px',
    paddingLeft: '12px',
    borderLeft: '1px solid var(--vscode-border)',
  },
});

/**
 * 一组连续的 思考 + 工具调用 → 折叠时间轴（模仿 Copilot "Finished with x steps"）。
 * 默认折叠；展开后竖向时间轴，工具行带图标、思考行带圆点。
 */
function StepsGroup({ parts, running }: { parts: Part[]; running: boolean }) {
  const styles = stepsStyles();
  const [open, setOpen] = useState(false);
  const n = parts.filter((p) => p.type === 'tool-call').length;
  const hasReasoning = parts.some((p) => p.type === 'reasoning');
  const label = running
    ? 'Working…'
    : n > 0
      ? `Finished with ${n} step${n === 1 ? '' : 's'}`
      : '思考过程';
  return (
    <div style={{ margin: '6px 0' }}>
      <div
        className={styles.summary}
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((v) => !v)}
      >
        <ChevronRightIcon
          className={open ? styles.chevronOpen : styles.chevron}
          fontSize={14}
        />
        {running ? (
          <Spinner size="tiny" />
        ) : (
          <CheckmarkCircleIcon
            fontSize={14}
            style={{ color: 'var(--vscode-chat-success)' }}
          />
        )}
        <span>{label}</span>
        {hasReasoning && n > 0 && (
          <span style={{ fontSize: '11px', opacity: 0.7 }}>· 含思考</span>
        )}
      </div>
      {open && (
        <div className={styles.body}>
          {parts.map((p, i) => (
            <TimelineRow key={i} part={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// = markdown                                                                  =
// ============================================================================

/** 代码块：react-syntax-highlighter + VS Code 主题色表 */
function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <SyntaxHighlighter
      language={language || 'text'}
      style={vscDarkPlus}
      customStyle={{
        margin: 0,
        background: 'var(--vscode-chat-code-bg)',
        borderRadius: 'var(--vscode-radius-md)',
        border: '1px solid var(--vscode-border)',
        padding: '12px 14px',
        fontSize: '12.5px',
        fontFamily: 'var(--vscode-font-mono)',
      }}
      codeTagProps={{
        style: { fontFamily: 'var(--vscode-font-mono)' },
      }}
    >
      {code}
    </SyntaxHighlighter>
  );
}

/** markdown 渲染（GFM + 代码高亮 + 行内代码芯片） */
function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isBlock = String(children).includes('\n');
            if (match && isBlock) {
              return (
                <CodeBlock
                  language={match[1]}
                  code={String(children).replace(/\n$/, '')}
                />
              );
            }
            return (
              <code className="md-inline-code" {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          a({ children, ...props }) {
            return (
              <a
                {...props}
                style={{ color: 'var(--vscode-chat-link)' }}
                target="_blank"
                rel="noreferrer"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ============================================================================
// = 消息                                                                      =
// ============================================================================

const msgStyles = makeStyles({
  userRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: '5px',
    marginTop: '12px',
  },
  userBubble: {
    maxWidth: '90%',
    width: 'fit-content',
    padding: '8px 12px',
    borderRadius: 'var(--vscode-radius-xl)',
    backgroundColor: 'var(--vscode-chat-bubble)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '13px',
    lineHeight: '1.5',
  },
  asstRow: {
    marginTop: '12px',
    minWidth: 0,
  },
  thinking: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 0',
    fontSize: '13px',
    color: 'var(--vscode-muted-fg)',
  },
});

/** 助手消息：思考 + 工具调用折叠成 "Finished with x steps"，文本段 markdown 渲染 */
function AssistantMessage({
  message,
  running,
}: {
  message: Extract<Message, { role: 'assistant' }>;
  running: boolean;
}) {
  const styles = msgStyles();
  const nodes = useMemo(() => {
    const out: Array<
      { kind: 'group'; parts: Part[] } | { kind: 'text'; part: Part }
    > = [];
    let group: Part[] = [];
    const flush = () => {
      if (group.length) {
        out.push({ kind: 'group', parts: group });
        group = [];
      }
    };
    message.parts.forEach((p, i) => {
      if (p.type === 'reasoning' || p.type === 'tool-call') {
        group.push(p);
      } else if (p.type === 'text' && p.text.trim()) {
        flush();
        out.push({ kind: 'text', part: p });
      }
    });
    flush();
    return out;
  }, [message.parts]);

  const lastGroupIdx = nodes.map((n) => n.kind).lastIndexOf('group');

  if (nodes.length === 0) {
    return (
      <div className={styles.asstRow}>
        <div className={styles.thinking}>
          <Spinner size="tiny" /> 思考中…
        </div>
      </div>
    );
  }

  return (
    <div className={styles.asstRow}>
      {nodes.map((n, i) =>
        n.kind === 'group' ? (
          <StepsGroup
            key={`g${i}`}
            parts={n.parts}
            running={running && i === lastGroupIdx}
          />
        ) : (
          <div key={`t${i}`}>
            <Markdown text={n.part.type === 'text' ? n.part.text : ''} />
          </div>
        ),
      )}
    </div>
  );
}

const emptyStyles = makeStyles({
  wrap: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '14px',
    padding: '24px',
    textAlign: 'center',
  },
  icon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    backgroundColor: 'var(--vscode-muted)',
    color: 'var(--vscode-primary)',
  },
  title: {
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
  },
  sub: {
    fontSize: '13px',
    color: 'var(--vscode-muted-fg)',
    maxWidth: '280px',
    lineHeight: 1.5,
  },
});

/** 空状态：居中图标 + 引导文案（模仿移动端"开始对话"） */
function EmptyState({ hasSession }: { hasSession: boolean }) {
  const styles = emptyStyles();
  return (
    <div className={styles.wrap}>
      <div className={styles.icon}>
        <ChatIcon fontSize={28} />
      </div>
      <div className={styles.title}>
        {hasSession ? '此会话暂无消息' : '开始一段对话'}
      </div>
      {!hasSession && (
        <div className={styles.sub}>
          从左侧选择一个会话，或直接输入消息发送到 VS Code
        </div>
      )}
    </div>
  );
}

function MessageList({
  messages,
  running,
  hasSession,
  canLoadOlder,
  loadingOlder,
}: {
  messages: Message[];
  running: boolean;
  hasSession: boolean;
  canLoadOlder: boolean;
  loadingOlder: boolean;
}) {
  const styles = msgStyles();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="flex-1 overflow-y-auto" style={{ padding: '16px 16px 8px' }}>
      {messages.length === 0 ? (
        <EmptyState hasSession={hasSession} />
      ) : (
        <div style={{ maxWidth: '720px', margin: '0 auto' }}>
          {canLoadOlder && (
            <div style={{ textAlign: 'center', marginBottom: '12px' }}>
              <button
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                style={{
                  padding: '4px 12px',
                  fontSize: '12px',
                  borderRadius: '12px',
                  border: '1px solid var(--vscode-border)',
                  backgroundColor: 'transparent',
                  color: 'var(--vscode-muted-fg)',
                  cursor: loadingOlder ? 'default' : 'pointer',
                  opacity: loadingOlder ? 0.6 : 1,
                }}
              >
                {loadingOlder ? '加载中…' : '加载更早消息'}
              </button>
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className={styles.userRow}>
                <div className={styles.userBubble}>
                  {m.text}
                  {m.queued && (
                    <span
                      style={{
                        display: 'block',
                        marginTop: '4px',
                        fontSize: '11px',
                        textAlign: 'right',
                        opacity: 0.6,
                      }}
                    >
                      排队中
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                running={running && m.id === messages[messages.length - 1]?.id}
              />
            ),
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// = 输入框（写路径）                                                          =
// ============================================================================

const inputStyles = makeStyles({
  footer: {
    padding: '8px 12px calc(12px + env(safe-area-inset-bottom))',
  },
  box: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    width: '100%',
    maxWidth: '720px',
    margin: '0 auto',
    backgroundColor: 'var(--vscode-input)',
    border: '1px solid var(--vscode-border)',
    borderRadius: '16px',
    padding: '8px 10px',
    transition: 'border-color 0.15s',
  },
  bottomRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  textarea: {
    flex: 1,
    resize: 'none',
    border: 'none',
    outline: 'none',
    backgroundColor: 'transparent',
    color: 'var(--vscode-foreground)',
    padding: '9px 0',
    fontSize: '14px',
    lineHeight: 1.4,
    fontFamily: 'var(--vscode-font-family)',
    minHeight: '20px',
    maxHeight: '140px',
  },
  send: {
    flexShrink: 0,
    marginLeft: 'auto',
    width: '34px',
    height: '34px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: 'var(--vscode-primary)',
    color: 'var(--vscode-primary-fg)',
    transition: 'opacity 0.15s, transform 0.1s',
  },
  sendDisabled: {
    opacity: 0.4,
    cursor: 'default',
  },
  hint: {
    maxWidth: '720px',
    margin: '6px auto 0',
    fontSize: '11px',
    color: 'var(--vscode-muted-fg)',
    textAlign: 'center',
  },
});

function InputFooter() {
  const styles = inputStyles();
  const [value, setValue] = useState('');
  const phase = useAhpStore((s) => s.phase);
  const chatState = useAhpStore((s) => s.chatState);
  const connected = phase === 'connected';
  const ready = connected && !!chatState;

  const canSend = !!value.trim() && ready;
  const submit = () => {
    const text = value.trim();
    if (!text || !ready) return;
    sendMessage(text);
    setValue('');
  };

  return (
    <div className={styles.footer}>
      <div className={styles.box}>
        <textarea
          className={styles.textarea}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            !connected
              ? '正在连接 VS Code…'
              : !chatState
                ? '选择会话后可发送'
                : '询问 Copilot…'
          }
          disabled={!ready}
          rows={1}
        />
        <div className={styles.bottomRow}>
          <button
            className={canSend ? styles.send : `${styles.send} ${styles.sendDisabled}`}
            onClick={submit}
            disabled={!canSend}
            aria-label="发送"
          >
            <SendIcon fontSize={16} />
          </button>
        </div>
      </div>
      {connected && chatState?.activeTurn && (
        <div className={styles.hint}>
          Copilot 正在工作，现在发送的消息将排队，当前回合结束后自动发出
        </div>
      )}
    </div>
  );
}

// ============================================================================
// = 侧边栏                                                                    =
// ============================================================================

const sidebarStyles = makeStyles({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: 'var(--vscode-card)',
  },
  panelHead: {
    padding: '14px 16px 10px',
  },
  panelTitle: {
    fontSize: '15px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 项目导航行（侧边栏只列项目，会话切换交给标题下拉）
  projectRow: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    borderRadius: '10px',
    fontSize: '14px',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    opacity: 0.9,
    transition: 'background-color 0.12s',
  },
  projectRowActive: {
    backgroundColor: 'var(--vscode-muted)',
    opacity: 1,
  },
  showMore: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    marginTop: '4px',
    borderRadius: '10px',
    fontSize: '13px',
    textAlign: 'center',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--vscode-muted-fg)',
    border: '1px dashed var(--vscode-border)',
    transition: 'background-color 0.12s',
  },
  model: {
    display: 'block',
    marginTop: '2px',
    fontSize: '11px',
    color: 'var(--vscode-muted-fg)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/** 项目导航行：项目名 + 最近会话副标题 + 会话数，点击跳该项目最近会话 */
function ProjectItem({
  project,
  count,
  recentTitle,
  active,
  onPick,
}: {
  project: string;
  count: number;
  recentTitle: string;
  active: boolean;
  onPick: () => void;
}) {
  const styles = sidebarStyles();
  return (
    <button
      className={
        active
          ? `${styles.projectRow} ${styles.projectRowActive}`
          : styles.projectRow
      }
      onClick={onPick}
      title={project}
    >
      <span
        style={{
          display: 'block',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {project}
      </span>
      <span className={styles.model}>
        {recentTitle} · {count} 会话
      </span>
    </button>
  );
}

function Sidebar({
  sessions,
  activeSessionId,
  onPick,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onPick: (id: string) => void;
}) {
  const styles = sidebarStyles();
  const PAGE = 6;
  const [showCount, setShowCount] = useState(PAGE);

  // 当前会话所属项目（侧边栏高亮用）
  const activeProject = useMemo(
    () =>
      activeSessionId
        ? (sessions.find((s) => s.resource === activeSessionId)?.project
            ?.displayName ?? null)
        : null,
    [sessions, activeSessionId],
  );

  // 全量项目分组（含会话数 + 最近活动），按最近活动排序
  const allGroups = useMemo(() => {
    const byProject = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const key = s.project?.displayName || '未分组';
      const arr = byProject.get(key);
      if (arr) arr.push(s);
      else byProject.set(key, [s]);
    }
    return [...byProject.entries()]
      .map(([project, list]) => ({
        project,
        list: list.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
        lastActivity: list[0].modifiedAt,
      }))
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }, [sessions]);

  // 分页：默认显示最近 6 个，"Show more" 每次展开 6 个
  const visibleGroups = allGroups.slice(0, showCount);
  const hasMore = showCount < allGroups.length;

  const header = (
    <div className={styles.panelHead}>
      <span className={styles.panelTitle}>会话</span>
    </div>
  );

  if (allGroups.length === 0) {
    return (
      <div className={styles.panel} style={{ position: 'relative' }}>
        {header}
        <div
          style={{
            padding: '16px 12px',
            textAlign: 'center',
            fontSize: '12px',
            color: 'var(--vscode-muted-fg)',
          }}
        >
          暂无项目
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} style={{ position: 'relative' }}>
      {header}
      <nav className="flex-1 overflow-y-auto" style={{ padding: '8px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {visibleGroups.map((g) => (
            <ProjectItem
              key={g.project}
              project={g.project}
              count={g.list.length}
              recentTitle={g.list[0].title || g.list[0].resource.slice(0, 8)}
              active={g.project === activeProject}
              onPick={() => onPick(g.list[0].resource)}
            />
          ))}
        </div>
        {hasMore && (
          <button
            className={styles.showMore}
            onClick={() => setShowCount((c) => c + PAGE)}
          >
            显示更多（{allGroups.length - showCount}）
          </button>
        )}
      </nav>
    </div>
  );
}

// ============================================================================
// = 根组件                                                                    =
// ============================================================================

const appStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    // 盖住 Fluent webDarkTheme wrapper 的默认深灰背景（#292929），透出纯黑
    backgroundColor: 'var(--vscode-background)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px calc(8px + env(safe-area-inset-top))',
    backgroundColor: 'var(--vscode-background)',
  },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    border: 'none',
    backgroundColor: 'var(--vscode-muted)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background-color 0.12s',
  },
  titleWrap: {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    maxWidth: '100%',
    fontSize: '15px',
    fontWeight: 600,
    color: 'inherit',
    background: 'transparent',
    border: 0,
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '8px',
  },
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleMenu: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)',
    minWidth: '220px',
    maxWidth: 'min(320px, 80vw)',
    maxHeight: '50vh',
    overflowY: 'auto',
    backgroundColor: 'var(--vscode-card)',
    border: '1px solid var(--vscode-border)',
    borderRadius: '10px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
    zIndex: 45,
    padding: '4px',
  },
  titleMenuItem: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    borderRadius: '8px',
    fontSize: '14px',
    textAlign: 'left',
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleMenuItemActive: {
    backgroundColor: 'var(--vscode-muted)',
  },
  error: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    borderBottom: '1px solid var(--vscode-tk-errorForeground, #f48771)',
    backgroundColor: 'var(--vscode-tk-inputValidation-errorBackground, #3a1d1d)',
    color: 'var(--vscode-tk-inputValidation-errorForeground, #f48771)',
    padding: '8px 12px',
    fontSize: '12px',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  // 抽屉遮罩（默认透明不可点，打开时淡入）
  scrim: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    opacity: 0,
    pointerEvents: 'none',
    transition: 'opacity 0.2s',
    zIndex: 30,
  },
  scrimOpen: {
    opacity: 1,
    pointerEvents: 'auto',
  },
  // 左侧抽屉（默认移出屏幕，打开时滑入）
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: 'min(85vw, 320px)',
    transform: 'translateX(-100%)',
    transition: 'transform 0.22s ease',
    zIndex: 40,
    boxShadow: '2px 0 16px rgba(0, 0, 0, 0.4)',
  },
  drawerOpen: {
    transform: 'translateX(0)',
  },
});

export default function App() {
  const appStyles_ = appStyles();
  const baseTheme = useFluentBaseTheme();
  const phase = useAhpStore((s) => s.phase);
  const sessions = useAhpStore((s) => s.sessions);
  const activeSessionId = useAhpStore((s) => s.activeSessionId);
  const error = useAhpStore((s) => s.error);
  const chatState = useAhpStore((s) => s.chatState);
  const loadingOlder = useAhpStore((s) => s.loadingOlder);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);

  useEffect(() => {
    startConnection();
  }, []);

  const connected = phase === 'connected';

  // 聊天展示：ChatState → 消息列表
  const messages = useMemo(
    () => (chatState ? chatToMessages(chatState) : []),
    [chatState],
  );
  const running = !!chatState?.activeTurn;
  const canLoadOlder = !!chatState?.turnsNextCursor;

  const activeTitle = useMemo(() => {
    if (!activeSessionId) return '';
    const s = sessions.find((x) => x.resource === activeSessionId);
    return s?.title || activeSessionId.slice(0, 8);
  }, [sessions, activeSessionId]);

  // 选中会话后自动收起抽屉（移动端习惯）
  const handleSelect = (id: string) => {
    selectSession(id);
    setDrawerOpen(false);
  };

  // 当前会话所属项目 + 同项目会话列表（标题下拉切换用）
  const activeProject = useMemo(() => {
    if (!activeSessionId) return null;
    return (
      sessions.find((s) => s.resource === activeSessionId)?.project
        ?.displayName ?? null
    );
  }, [sessions, activeSessionId]);

  const titleMenuList = useMemo(() => {
    if (!activeProject) return [] as SessionSummary[];
    return sessions.filter((s) => s.project?.displayName === activeProject);
  }, [sessions, activeProject]);

  const pickFromTitle = (id: string) => {
    selectSession(id);
    setTitleMenuOpen(false);
  };

  // 标题显示
  const displayTitle = activeTitle || (connected ? 'Copilot Bridge' : '连接中…');
  // 标题下拉：同项目有多个会话时可用
  const titleEnabled = titleMenuList.length > 1;

  return (
    <FluentProvider theme={baseTheme} style={{ height: '100%' }}>
      <div className={appStyles_.root}>
        <header className={appStyles_.header}>
          <button
            className={appStyles_.iconBtn}
            onClick={() => setDrawerOpen(true)}
            aria-label="打开会话列表"
          >
            <MenuIcon fontSize={18} />
          </button>
          <div className={appStyles_.titleWrap}>
            <button
              className={appStyles_.title}
              onClick={() => setTitleMenuOpen((o) => !o)}
              disabled={!titleEnabled}
              style={!titleEnabled ? { cursor: 'default' } : undefined}
              aria-label="切换会话"
              title={titleEnabled ? '切换同项目会话' : undefined}
            >
              <span className={appStyles_.titleText}>{displayTitle}</span>
              {titleEnabled && <ChevronDownIcon fontSize={14} />}
            </button>
            {titleMenuOpen && titleEnabled && (
              <div className={appStyles_.titleMenu}>
                {titleMenuList.map((s) => (
                  <button
                    key={s.resource}
                    className={
                      s.resource === activeSessionId
                        ? `${appStyles_.titleMenuItem} ${appStyles_.titleMenuItemActive}`
                        : appStyles_.titleMenuItem
                    }
                    onClick={() => pickFromTitle(s.resource)}
                  >
                    {s.title || s.resource.slice(0, 8)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 点击外部关闭标题下拉 */}
          {titleMenuOpen && (
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 35 }}
              onClick={() => setTitleMenuOpen(false)}
            />
          )}
        </header>
        {error && (
          <div className={appStyles_.error}>
            <span style={{ flex: 1 }}>{error}</span>
            <button
              onClick={() => useAhpStore.setState({ error: null })}
              style={{
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                color: 'inherit',
                padding: '2px',
              }}
              aria-label="关闭"
            >
              <DismissIcon fontSize={14} />
            </button>
          </div>
        )}
        <div className={appStyles_.main}>
          <MessageList
            messages={messages}
            running={running}
            hasSession={!!activeSessionId}
            canLoadOlder={canLoadOlder}
            loadingOlder={loadingOlder}
          />
          <InputFooter />
        </div>

        {/* 抽屉遮罩 */}
        <div
          className={
            drawerOpen
              ? `${appStyles_.scrim} ${appStyles_.scrimOpen}`
              : appStyles_.scrim
          }
          onClick={() => setDrawerOpen(false)}
        />
        {/* 会话抽屉 */}
        <div
          className={
            drawerOpen
              ? `${appStyles_.drawer} ${appStyles_.drawerOpen}`
              : appStyles_.drawer
          }
        >
          <Sidebar
            key={String(drawerOpen)}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onPick={handleSelect}
          />
        </div>
      </div>
    </FluentProvider>
  );
}
