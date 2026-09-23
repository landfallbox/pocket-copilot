package com.tang.copilotbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * 前台 Service：保活连接进程 + 常驻通知展示连接状态。
 * 连接逻辑在 [BridgeController]，Service 只负责保活与状态展示。
 * START_STICKY：进程被系统杀掉后 Service 自动重启，onCreate 里重新 init 控制器触发重连。
 */
class BridgeService : Service() {

    private var scope: CoroutineScope? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        // 同步立即提升为前台（标准做法，确保在前台豁免窗口内生效）
        // 若系统拒绝（极端后台限制），连接仍由 Controller 维持，仅失去保活/通知
        try {
            ServiceCompat.startForeground(
                this, NOTIF_ID,
                buildNotification(BridgeClient.ClientState.CONNECTING),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } catch (e: RuntimeException) {
            android.util.Log.w("BridgeService", "startForeground 失败: ${e.message}")
        }
        val ctl = BridgeController.get(this)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main).also { s ->
            s.launch {
                val c = ctl.initOnce()
                if (c == null) {
                    // 无已保存配置：短暂显示后立即退出
                    stopSelf()
                    return@launch
                }
                combine(ctl.clientState, ctl.config) { state, cfg -> state to cfg }
                    .collectLatest { (state, cfg) ->
                        // 配置被清除（用户断开）时停止 Service
                        if (cfg == null) {
                            stopSelf()
                            return@collectLatest
                        }
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.notify(NOTIF_ID, buildNotification(state))
                    }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope?.cancel()
        scope = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "连接状态", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun buildNotification(state: BridgeClient.ClientState): Notification {
        val text = when (state) {
            BridgeClient.ClientState.AUTHENTICATED -> "已连接"
            BridgeClient.ClientState.CONNECTING -> "连接中…"
            BridgeClient.ClientState.DISCONNECTED -> "已断开（自动重连中）"
        }
        val launch = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Copilot Bridge")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setOngoing(true)
            .setContentIntent(launch)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "bridge-status"
        private const val NOTIF_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, BridgeService::class.java))
        }
    }
}
