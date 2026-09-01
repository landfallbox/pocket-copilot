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
  ArrowClockwiseRegular as RefreshIcon,
  ChatRegular as ChatIcon,
  SettingsRegular as SettingsIcon,
  EyeOffRegular as EyeOffIcon,
  CheckmarkRegular as CheckmarkIcon,
} from '@fluentui/react-icons';
import {
  useDemoStore,
  startConnection,
  selectSession,
  sendMessage,
  refreshActive,
  isProjectVisible,
  toggleProject,
  type SessionState,
} from './store';
import { sessionToMessages, type Message, type Part } from './convert';

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
      { kind: 'group'; parts: Part[] } | { kind: 'text'; index: number }
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
        out.push({ kind: 'text', index: i });
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
          <div key={`t${n.index}`}>
            <Markdown
              text={
                message.parts[n.index].type === 'text'
                  ? message.parts[n.index].text
                  : ''
              }
            />
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
      <div className={styles.sub}>
        {hasSession
          ? '点击下方刷新重试，或发送一条消息'
          : '从左侧选择一个会话，或直接输入消息发送到 VS Code'}
      </div>
    </div>
  );
}

function MessageList({
  messages,
  running,
  hasSession,
}: {
  messages: Message[];
  running: boolean;
  hasSession: boolean;
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
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className={styles.userRow}>
                <div className={styles.userBubble}>{m.text}</div>
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
    alignItems: 'flex-end',
    gap: '8px',
    width: '100%',
    maxWidth: '720px',
    margin: '0 auto',
    backgroundColor: 'var(--vscode-input)',
    border: '1px solid var(--vscode-border)',
    borderRadius: '24px',
    padding: '6px 6px 6px 16px',
    transition: 'border-color 0.15s',
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
  const sending = useDemoStore((s) => s.sending);
  const connected = useDemoStore((s) => s.connected);
  const activeSessionId = useDemoStore((s) => s.activeSessionId);

  const canSend = !!value.trim() && !sending && connected && !!activeSessionId;
  const submit = () => {
    const text = value.trim();
    if (!text || sending || !connected || !activeSessionId) return;
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
            activeSessionId ? '询问 Copilot…' : '选择会话后可发送'
          }
          disabled={!activeSessionId}
          rows={1}
        />
        <button
          className={canSend ? styles.send : `${styles.send} ${styles.sendDisabled}`}
          onClick={submit}
          disabled={!canSend}
          aria-label="发送"
        >
          {sending ? <Spinner size="tiny" /> : <SendIcon fontSize={16} />}
        </button>
      </div>
      {sending && (
        <div className={styles.hint}>
          正在注入 VS Code（激活窗口 → 切换会话 → 粘贴发送）…
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
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '14px 16px 10px',
  },
  panelTitle: {
    flex: 1,
    fontSize: '15px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: 'none',
    background: 'var(--vscode-muted)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    width: '100%',
    padding: '6px 10px',
    borderRadius: '8px',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.03em',
    color: 'var(--vscode-muted-fg)',
    cursor: 'pointer',
    background: 'transparent',
    border: 0,
    textAlign: 'left',
  },
  item: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    borderRadius: '10px',
    fontSize: '14px',
    textAlign: 'left',
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    opacity: 0.85,
    transition: 'background-color 0.12s',
  },
  itemActive: {
    backgroundColor: 'var(--vscode-muted)',
    opacity: 1,
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
  // 项目头右侧的隐藏按钮（覆盖在分组头右侧，阻止冒泡避免触发折叠）
  eyeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '6px',
    border: 0,
    background: 'transparent',
    color: 'var(--vscode-muted-fg)',
    cursor: 'pointer',
    flexShrink: 0,
    opacity: 0,
    transition: 'opacity 0.12s, background-color 0.12s',
  },
  eyeBtnHover: {
    opacity: 1,
    background: 'var(--vscode-muted)',
  },
  // 项目头 hover 时显示隐藏按钮（用 group 选择器在 JSX 内联实现）
  // “管理项目”面板（覆盖在侧边栏内容之上，勾选全量项目）
  managePanel: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--vscode-card)',
    zIndex: 5,
  },
  manageHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '14px 16px 10px',
  },
  manageTitle: {
    flex: 1,
    fontSize: '15px',
    fontWeight: 600,
  },
  manageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '10px 12px',
    borderRadius: '10px',
    fontSize: '14px',
    textAlign: 'left',
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    color: 'var(--vscode-foreground)',
  },
  manageRowActive: {
    backgroundColor: 'var(--vscode-muted)',
  },
  manageCheck: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: '6px',
    border: '1px solid var(--vscode-border)',
    color: 'var(--vscode-foreground)',
    flexShrink: 0,
  },
  manageCheckOn: {
    backgroundColor: 'var(--vscode-tk-button-background, #0e639c)',
    border: '1px solid var(--vscode-tk-button-background, #0e639c)',
    color: '#fff',
  },
  manageCount: {
    marginLeft: 'auto',
    fontSize: '11px',
    color: 'var(--vscode-muted-fg)',
  },
});

function SessionItem({
  sess,
  active,
  onSelect,
}: {
  sess: SessionState;
  active: boolean;
  onSelect: () => void;
}) {
  const styles = sidebarStyles();
  const label = sess.title || sess.sessionId.slice(0, 8);
  return (
    <button
      className={active ? `${styles.item} ${styles.itemActive}` : styles.item}
      onClick={onSelect}
      title={sess.title ?? sess.sessionId}
    >
      <span
        style={{
          display: 'block',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {sess.model && <span className={styles.model}>{sess.model}</span>}
    </button>
  );
}

function Sidebar({
  sessions,
  activeSessionId,
  onPick,
  onClose,
}: {
  sessions: SessionState[];
  activeSessionId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const styles = sidebarStyles();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [managing, setManaging] = useState(false);
  // 订阅可见项目变化（切换项目后重算）
  useDemoStore((s) => s.visibleProjects);
  useDemoStore((s) => s.version);

  // 全量项目分组（含会话数 + 最近活动），用于"管理项目"面板
  const allGroups = useMemo(() => {
    const byProject = new Map<string, SessionState[]>();
    for (const s of sessions) {
      const key = s.project || '未分组';
      const arr = byProject.get(key);
      if (arr) arr.push(s);
      else byProject.set(key, [s]);
    }
    return [...byProject.entries()]
      .map(([project, list]) => ({
        project,
        list: list.sort((a, b) => b.lastActivity - a.lastActivity),
        lastActivity: list[0].lastActivity,
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }, [sessions]);

  // 仅可见项目（在 visibleProjects 列表中）
  const groups = useMemo(
    () => allGroups.filter((g) => isProjectVisible(g.project)),
    [allGroups],
  );

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const header = (
    <div className={styles.panelHead}>
      <span className={styles.panelTitle}>会话</span>
      <button
        className={styles.closeBtn}
        onClick={() => setManaging(true)}
        aria-label="管理项目"
        title="管理项目"
      >
        <SettingsIcon fontSize={16} />
      </button>
      <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
        <DismissIcon fontSize={16} />
      </button>
    </div>
  );

  // "管理项目"面板：覆盖在侧边栏内容之上，列出全量项目供勾选
  const managePanel = managing ? (
    <div className={styles.managePanel}>
      <div className={styles.manageHead}>
        <span className={styles.manageTitle}>管理项目</span>
        <button
          className={styles.closeBtn}
          onClick={() => setManaging(false)}
          aria-label="关闭"
        >
          <DismissIcon fontSize={16} />
        </button>
      </div>
      <nav
        className="flex-1 overflow-y-auto"
        style={{ padding: '4px 8px 16px' }}
      >
        {allGroups.map((g) => {
          const visible = isProjectVisible(g.project);
          return (
            <button
              key={g.project}
              className={
                visible
                  ? `${styles.manageRow} ${styles.manageRowActive}`
                  : styles.manageRow
              }
              onClick={() => toggleProject(g.project)}
            >
              <span
                className={
                  visible
                    ? `${styles.manageCheck} ${styles.manageCheckOn}`
                    : styles.manageCheck
                }
              >
                {visible && <CheckmarkIcon fontSize={14} />}
              </span>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {g.project}
              </span>
              <span className={styles.manageCount}>{g.list.length}</span>
            </button>
          );
        })}
      </nav>
    </div>
  ) : null;

  if (groups.length === 0) {
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
          暂无可见项目
          <div style={{ marginTop: '8px' }}>
            点击右上角齿轮，选择要显示的项目
          </div>
        </div>
        {managePanel}
      </div>
    );
  }

  return (
    <div className={styles.panel} style={{ position: 'relative' }}>
      {header}
      <nav className="flex-1 overflow-y-auto" style={{ padding: '8px' }}>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.project);
          return (
            <div key={g.project} style={{ marginBottom: '4px' }}>
              <div
                className={styles.groupHeader}
                onClick={() => toggle(g.project)}
                onMouseEnter={(e) =>
                  (
                    e.currentTarget.querySelector('[data-eye]') as
                      | HTMLElement
                      | null
                  )?.style.setProperty('opacity', '1')
                }
                onMouseLeave={(e) =>
                  (
                    e.currentTarget.querySelector('[data-eye]') as
                      | HTMLElement
                      | null
                  )?.style.setProperty('opacity', '0')
                }
              >
                <ChevronRightIcon
                  fontSize={14}
                  style={{
                    transform: isCollapsed ? 'rotate(0)' : 'rotate(90deg)',
                    transition: 'transform 0.15s',
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {g.project}
                </span>
                <span style={{ fontSize: '10px', opacity: 0.7, flexShrink: 0 }}>
                  {g.list.length}
                </span>
                <button
                  data-eye
                  className={styles.eyeBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleProject(g.project);
                  }}
                  aria-label="隐藏项目"
                  title="隐藏项目"
                >
                  <EyeOffIcon fontSize={14} />
                </button>
              </div>
              {!isCollapsed && (
                <div
                  style={{
                    marginTop: '2px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    paddingLeft: '4px',
                  }}
                >
                  {g.list.map((s) => (
                    <SessionItem
                      key={s.sessionId}
                      sess={s}
                      active={s.sessionId === activeSessionId}
                      onSelect={() => onPick(s.sessionId)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      {managePanel}
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
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: '15px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  const connected = useDemoStore((s) => s.connected);
  const version = useDemoStore((s) => s.version);
  const activeSessionId = useDemoStore((s) => s.activeSessionId);
  const error = useDemoStore((s) => s.error);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    startConnection();
  }, []);

  const sessions = useMemo(() => {
    void version;
    return [...useDemoStore.getState().sessions.values()].sort(
      (a, b) => b.lastActivity - a.lastActivity,
    );
  }, [version]);

  const { messages, running, activeTitle } = useMemo(() => {
    void version;
    const s = useDemoStore.getState();
    const sess = activeSessionId ? s.sessions.get(activeSessionId) : undefined;
    if (!sess)
      return { messages: [] as Message[], running: false, activeTitle: '' };
    const msgs = sessionToMessages(sess.order, sess.requests);
    const isRunning = sess.order.some((id) => !sess.requests.get(id)?.done);
    return {
      messages: msgs,
      running: isRunning,
      activeTitle: sess.title || sess.sessionId.slice(0, 8),
    };
  }, [version, activeSessionId]);

  // 选中会话后自动收起抽屉（移动端习惯）
  const handleSelect = (id: string) => {
    selectSession(id);
    setDrawerOpen(false);
  };

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
          <h1 className={appStyles_.title}>
            {activeTitle || (connected ? 'Copilot Bridge' : '连接中…')}
          </h1>
          <button
            className={appStyles_.iconBtn}
            onClick={() => refreshActive()}
            disabled={!activeSessionId}
            style={activeSessionId ? undefined : { opacity: 0.4 }}
            aria-label="刷新"
          >
            <RefreshIcon fontSize={17} />
          </button>
        </header>
        {error && (
          <div className={appStyles_.error}>
            <span style={{ flex: 1 }}>{error}</span>
            <button
              onClick={() => useDemoStore.setState({ error: null })}
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
            sessions={sessions}
            activeSessionId={activeSessionId}
            onPick={handleSelect}
            onClose={() => setDrawerOpen(false)}
          />
        </div>
      </div>
    </FluentProvider>
  );
}
