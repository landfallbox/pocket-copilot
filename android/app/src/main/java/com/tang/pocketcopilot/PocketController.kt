package com.tang.pocketcopilot

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
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

    fun dismissError() {
        _error.value = null
    }

    /** 深链 pocket-copilot://pair?host=..&port=..&device=.. → 保存并连接 */
    fun onDeepLink(uri: Uri) {
        if (uri.scheme != "pocket-copilot" || uri.host != "pair") return
        val host = uri.getQueryParameter("host") ?: return
        val port = uri.getQueryParameter("port")?.toIntOrNull() ?: 8765
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
