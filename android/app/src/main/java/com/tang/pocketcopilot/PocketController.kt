package com.tang.pocketcopilot

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * 进程级连接控制器（单例）。
 * 持有 [PocketClient] 与全部 UI 状态，生命周期跟随进程而非 Activity：
 * 前台 Service 负责拉起/停止它，Activity 被杀后连接与状态依然保留。
 */
class PocketController private constructor(private val app: Context) {

    val configStore = ConfigStore(app)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _config = MutableStateFlow<ConnConfig?>(null)
    val config: StateFlow<ConnConfig?> = _config.asStateFlow()

    private val _clientState = MutableStateFlow(PocketClient.ClientState.DISCONNECTED)
    val clientState: StateFlow<PocketClient.ClientState> = _clientState.asStateFlow()

    private val _sessions = MutableStateFlow<List<PhoneSession>>(emptyList())
    val sessions: StateFlow<List<PhoneSession>> = _sessions.asStateFlow()

    /** 侧边栏"显示已完成"开关（默认 false，与电脑端一致隐藏已标记完成的会话） */
    private val _showArchived = MutableStateFlow(false)
    val showArchived: StateFlow<Boolean> = _showArchived.asStateFlow()

    fun setShowArchived(v: Boolean) {
        _showArchived.value = v
    }

    /** 端上默认过滤掉已标记完成的会话；打开"显示已完成"后全部展示 */
    val visibleSessions: StateFlow<List<PhoneSession>> =
        combine(_sessions, _showArchived) { list, show ->
            if (show) list else list.filterNot { it.archived }
        }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    private val _projects = MutableStateFlow<List<PhoneProject>>(emptyList())
    val projects: StateFlow<List<PhoneProject>> = _projects.asStateFlow()

    /** 待确认的新建会话配置（非 null 时 UI 弹确认框） */
    private val _pendingConfig = MutableStateFlow<PhoneSessionConfig?>(null)
    val pendingConfig: StateFlow<PhoneSessionConfig?> = _pendingConfig.asStateFlow()

    private val _focus = MutableStateFlow<String?>(null)
    val focus: StateFlow<String?> = _focus.asStateFlow()

    private val _view = MutableStateFlow<ChatView?>(null)
    val view: StateFlow<ChatView?> = _view.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var client: PocketClient? = null

    /**
     * 进程/Service 启动后调用：加载已保存配置，有则自动连接。
     * 返回最终配置（null 表示无配置，Service 应自行退出）。
     */
    suspend fun initOnce(): ConnConfig? {
        if (client != null) return _config.value
        val c = configStore.config.first()
        _config.value = c
        if (c != null) startClient(c)
        return c
    }

    /** 保存配置并（重）连接；config 为 null 时断开并清除配置 */
    fun connect(c: ConnConfig?) {
        _config.value = c
        scope.launch {
            if (c == null) {
                client?.stop()
                client = null
                _clientState.value = PocketClient.ClientState.DISCONNECTED
                _sessions.value = emptyList()
                _focus.value = null
                _view.value = null
                configStore.clear()
            } else {
                configStore.save(c)
                startClient(c)
            }
        }
    }

    fun select(id: String) {
        client?.select(id)
    }

    fun send(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        client?.send(t)
    }

    /** 在焦点会话所属项目下新建会话 */
    fun newSession() = client?.newSession()

    /** 在指定项目下新建会话（config 为用户确认后的配置） */
    fun newSessionIn(projectUri: String, config: Map<String, Any>? = null) =
        client?.newSessionIn(projectUri, config)

    /** 请求解析项目会话配置（回包 configResolved → 弹确认框） */
    fun resolveConfig(projectUri: String) = client?.resolveConfig(projectUri)

    /** 用户在确认框点"创建"：带配置新建会话并收起弹窗 */
    fun confirmNewSession(config: Map<String, Any>? = null) {
        val pc = _pendingConfig.value
        if (pc != null) {
            _pendingConfig.value = null
            client?.newSessionIn(pc.projectUri, config)
        }
    }

    /** 用户在确认框点"取消" */
    fun cancelNewSession() {
        _pendingConfig.value = null
    }

    /** 标记 / 取消标记会话完成 */
    fun setArchived(id: String, archived: Boolean) = client?.setArchived(id, archived)

    /** 请求项目列表（回包 projects 事件） */
    fun listProjects() = client?.listProjects()

    fun dismissError() {
        _error.value = null
    }

    /** 深链 pocket-copilot://pair?host=..&port=..&device=.. → 保存并连接（port 必填） */
    fun onDeepLink(uri: Uri) {
        if (uri.scheme != "pocket-copilot" || uri.host != "pair") return
        val host = uri.getQueryParameter("host") ?: return
        val port = uri.getQueryParameter("port")?.toIntOrNull() ?: return
        val device = uri.getQueryParameter("device") ?: return
        connect(ConnConfig(host, port, device))
    }

    private fun startClient(c: ConnConfig) {
        client?.stop()
        client = PocketClient(
            config = c,
            onEvent = ::handleEvent,
            onState = { _clientState.value = it },
        ).also { it.start() }
    }

    private fun handleEvent(e: DaemonEvent) {
        when (e) {
            is DaemonEvent.Welcome -> {
                _sessions.value = e.sessions
                _focus.value = e.focus
            }
            is DaemonEvent.Sessions -> _sessions.value = e.items
            is DaemonEvent.Focus -> {
                // 焦点会话变化（含 null = 全部完成）：同步标题栏焦点；
                // 置 null 时清空旧视图，避免残留上一个会话内容
                _focus.value = e.id
                if (e.id == null) _view.value = null
            }
            is DaemonEvent.Projects -> _projects.value = e.items
            is DaemonEvent.ConfigResolved -> _pendingConfig.value = e.config
            is DaemonEvent.SessionCreated -> {
                // 新建会话后 daemon 已 select 到新会话，focus 由后续 chat 事件更新；
                // 这里主动拉一次项目列表保持选择器数据新鲜。
                client?.listProjects()
            }
            is DaemonEvent.Chat -> {
                _focus.value = e.id
                _view.value = e.view
            }
            is DaemonEvent.Host -> {
                if (!e.ok) _error.value = "agent host 未连接（daemon 正在重连）"
            }
            is DaemonEvent.Error -> _error.value = e.msg
        }
    }

    companion object {
        @Volatile
        private var instance: PocketController? = null

        fun get(app: Context): PocketController =
            instance ?: synchronized(this) {
                instance ?: PocketController(app.applicationContext).also { instance = it }
            }
    }
}
