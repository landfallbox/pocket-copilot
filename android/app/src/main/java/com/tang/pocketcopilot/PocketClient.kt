package com.tang.pocketcopilot

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import com.google.gson.JsonObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 手机 → daemon 的 WS 客户端。
 * - 连接 ws://host:port/ws（配对时指定），首帧发 hello 鉴权
 * - 断线指数退避重连（1s → 2s → 4s ... 上限 30s），重连后重新 hello
 * - 事件经 [events] 回调抛给 UI（主线程外，UI 侧自行切主线程）
 */
class PocketClient(
    private val config: ConnConfig,
    private val onEvent: (DaemonEvent) -> Unit,
    private val onState: (ClientState) -> Unit,
) {
    enum class ClientState { DISCONNECTED, CONNECTING, AUTHENTICATED }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val connected = AtomicBoolean(false)
    private val authed = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)
    private var socket: WebSocket? = null
    private var retryJob: Job? = null
    private val backoffMs = AtomicLong(1000)

    fun start() {
        stop()
        stopped.set(false)
        connectNow()
    }

    fun stop() {
        stopped.set(true)
        retryJob?.cancel()
        socket?.close(1000, "client stop")
        socket = null
        connected.set(false)
        authed.set(false)
        onState(ClientState.DISCONNECTED)
    }

    fun select(id: String) {
        if (!authed.get()) return
        socket?.send(Commands.select(id))
    }

    fun send(text: String) {
        if (!authed.get()) return
        socket?.send(Commands.send(text))
    }

    // -------------------------------------------------------------------------

    private fun connectNow() {
        if (stopped.get()) return
        onState(ClientState.CONNECTING)
        val request = Request.Builder().url(config.wsUrl).build()
        socket = client.newWebSocket(request, listener)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i(TAG, "ws open, sending hello")
            authed.set(false)
            webSocket.send(Commands.hello(config.device))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val event = try {
                DaemonEvent.fromJson(gson.fromJson(text, JsonObject::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "bad frame: $text", e)
                return
            }
            if (event is DaemonEvent.Welcome) {
                connected.set(true)
                authed.set(true)
                backoffMs.set(1000)
                onState(ClientState.AUTHENTICATED)
            }
            onEvent(event)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "ws failure: ${t.message}")
            teardown()
            scheduleRetry()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "ws closed $code $reason")
            teardown()
            scheduleRetry()
        }
    }

    private fun teardown() {
        connected.set(false)
        authed.set(false)
        onState(ClientState.DISCONNECTED)
    }

    private fun scheduleRetry() {
        if (stopped.get()) return
        val wait = backoffMs.get()
        onState(ClientState.DISCONNECTED)
        retryJob = scope.launch {
            delay(wait)
            if (!isActive || stopped.get()) return@launch
            backoffMs.set((wait * 2).coerceAtMost(30_000L))
            connectNow()
        }
    }

    companion object {
        private const val TAG = "PocketClient"
    }
}
