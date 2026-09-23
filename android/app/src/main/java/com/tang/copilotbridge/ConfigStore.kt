package com.tang.copilotbridge

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** 连接配置持久化（DataStore preferences） */

private val Context.dataStore by preferencesDataStore(name = "bridge")

data class ConnConfig(
    val host: String,
    val port: Int = 8765,
    val device: String,
) {
    val wsUrl: String get() = "ws://$host:$port/ws"
}

class ConfigStore(private val context: Context) {
    val config: Flow<ConnConfig?> = context.dataStore.data.map { p ->
        val host = p[KEY_HOST] ?: return@map null
        val device = p[KEY_DEVICE] ?: return@map null
        ConnConfig(host, p[KEY_PORT] ?: 8765, device)
    }

    suspend fun save(c: ConnConfig) {
        context.dataStore.edit { p ->
            p[KEY_HOST] = c.host
            p[KEY_PORT] = c.port
            p[KEY_DEVICE] = c.device
        }
    }

    suspend fun clear() {
        context.dataStore.edit { it.clear() }
    }

    companion object {
        private val KEY_HOST = stringPreferencesKey("host")
        private val KEY_PORT = intPreferencesKey("port")
        private val KEY_DEVICE = stringPreferencesKey("device")
    }
}
