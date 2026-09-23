package com.tang.copilotbridge

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tang.copilotbridge.BridgeClient.ClientState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * UI 薄适配层：状态直接读 [BridgeController]（进程级单例），
 * 连接生命周期由 BridgeService 持有，Activity 销毁不影响连接。
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val ctl = BridgeController.get(app)

    val config: StateFlow<ConnConfig?> = ctl.config
    val clientState: StateFlow<ClientState> = ctl.clientState
    val sessions: StateFlow<List<PhoneSession>> = ctl.sessions
    val focus: StateFlow<String?> = ctl.focus
    val view: StateFlow<ChatView?> = ctl.view
    val error: StateFlow<String?> = ctl.error

    val selectedId: Flow<String?> = ctl.focus

    fun connect(c: ConnConfig) {
        ctl.connect(c)
        BridgeService.start(getApplication())
    }

    fun disconnect() {
        ctl.connect(null)
    }

    fun select(id: String) = ctl.select(id)

    fun send(text: String) = ctl.send(text)

    fun dismissError() {
        viewModelScope.launch { ctl.dismissError() }
    }

    fun onDeepLink(uri: Uri) {
        ctl.onDeepLink(uri)
        BridgeService.start(getApplication())
    }
}
