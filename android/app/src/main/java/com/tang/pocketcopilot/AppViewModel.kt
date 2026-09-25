package com.tang.pocketcopilot

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tang.pocketcopilot.PocketClient.ClientState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * UI 薄适配层：状态直接读 [PocketController]（进程级单例），
 * 连接生命周期由 PocketService 持有，Activity 销毁不影响连接。
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val ctl = PocketController.get(app)

    val config: StateFlow<ConnConfig?> = ctl.config
    val clientState: StateFlow<ClientState> = ctl.clientState
    val sessions: StateFlow<List<PhoneSession>> = ctl.sessions
    val visibleSessions: StateFlow<List<PhoneSession>> = ctl.visibleSessions
    val showArchived: StateFlow<Boolean> = ctl.showArchived
    val projects: StateFlow<List<PhoneProject>> = ctl.projects
    val pendingConfig: StateFlow<PhoneSessionConfig?> = ctl.pendingConfig
    val focus: StateFlow<String?> = ctl.focus
    val view: StateFlow<ChatView?> = ctl.view
    val error: StateFlow<String?> = ctl.error

    val selectedId: Flow<String?> = ctl.focus

    fun connect(c: ConnConfig) {
        ctl.connect(c)
        PocketService.start(getApplication())
    }

    fun disconnect() {
        ctl.connect(null)
    }

    fun select(id: String) = ctl.select(id)

    fun send(text: String) = ctl.send(text)

    fun newSession() = ctl.newSession()

    fun newSessionIn(projectUri: String, config: Map<String, Any>? = null) =
        ctl.newSessionIn(projectUri, config)

    fun resolveConfig(projectUri: String) = ctl.resolveConfig(projectUri)

    fun confirmNewSession(config: Map<String, Any>? = null) = ctl.confirmNewSession(config)

    fun cancelNewSession() = ctl.cancelNewSession()

    fun setArchived(id: String, archived: Boolean) = ctl.setArchived(id, archived)

    fun setShowArchived(v: Boolean) = ctl.setShowArchived(v)

    fun listProjects() = ctl.listProjects()

    fun dismissError() {
        viewModelScope.launch { ctl.dismissError() }
    }

    fun onDeepLink(uri: Uri) {
        ctl.onDeepLink(uri)
        PocketService.start(getApplication())
    }
}
