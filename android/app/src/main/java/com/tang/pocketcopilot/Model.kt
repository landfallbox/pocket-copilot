package com.tang.pocketcopilot

import com.google.gson.Gson
import com.google.gson.JsonObject

/**
 * 与 daemon 的简化手机协议（镜像 src/phone/protocol.ts，字段名必须一致）。
 * JSON over WebSocket，单连接双向。
 */

// ---------------------------------------------------------------------------
// = 展示模型（daemon → 手机）                                                 =
// ---------------------------------------------------------------------------

/** 助手消息内的一个片段：文本 / 思考 / 工具调用 */
sealed class Part {
    data class Text(val text: String) : Part()
    data class Reasoning(val text: String) : Part()
    data class Tool(val name: String, val label: String, val status: String) : Part()

    companion object {
        fun fromJson(o: JsonObject): Part? = when (o.get("k")?.takeIf { !it.isJsonNull }?.asString) {
            "text" -> o.get("text")?.takeIf { !it.isJsonNull }?.asString?.let { Text(it) }
            "reasoning" -> o.get("text")?.takeIf { !it.isJsonNull }?.asString?.let { Reasoning(it) }
            "tool" -> Tool(
                o.get("name")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                o.get("label")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                o.get("status")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            )
            else -> null
        }
    }
}

/** 展示消息（由 AHP ChatState 转换而来） */
sealed class PhoneMessage {
    data class User(val id: String, val text: String, val queued: Boolean = false) : PhoneMessage()
    data class Assistant(val id: String, val parts: List<Part>, val done: Boolean) : PhoneMessage()

    companion object {
        fun fromJson(o: JsonObject): PhoneMessage? =
            if (o.get("role")?.takeIf { !it.isJsonNull }?.asString == "user") {
                User(
                    o.get("id")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                    o.get("text")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                    o.get("queued")?.asBoolean ?: false,
                )
            } else {
                val parts = o.getAsJsonArray("parts")
                    ?.mapNotNull { Part.fromJson(it.asJsonObject) }
                    .orEmpty()
                Assistant(
                    o.get("id")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                    parts,
                    o.get("done")?.asBoolean ?: true,
                )
            }
    }
}

/** 焦点会话的视图快照（daemon 节流推送，手机零 diff 逻辑） */
data class ChatView(
    val streaming: Boolean,
    val messages: List<PhoneMessage>,
    val pending: List<PendingMsg>,
)

data class PendingMsg(val id: String, val text: String)

/** 会话摘要（供手机会话列表渲染） */
data class PhoneSession(
    val id: String,
    val title: String,
    val status: String,
    val activity: String? = null,
    val modifiedAt: String,
    val project: String? = null,
)

// ---------------------------------------------------------------------------
// = daemon → 手机（事件）                                                     =
// ---------------------------------------------------------------------------

sealed class DaemonEvent {
    data class Welcome(val sessions: List<PhoneSession>, val focus: String?) : DaemonEvent()
    data class Sessions(val items: List<PhoneSession>) : DaemonEvent()
    data class Chat(val id: String, val v: Long, val view: ChatView) : DaemonEvent()
    data class Host(val ok: Boolean) : DaemonEvent()
    data class Error(val msg: String) : DaemonEvent()

    companion object {
        fun fromJson(o: JsonObject): DaemonEvent = when (o.get("t")?.asString) {
            "welcome" -> Welcome(
                o.getAsJsonArray("sessions")?.map { sessionFromJson(it.asJsonObject) }.orEmpty(),
                o.get("focus")?.takeIf { !it.isJsonNull }?.asString,
            )
            "sessions" -> Sessions(
                o.getAsJsonArray("items")?.map { sessionFromJson(it.asJsonObject) }.orEmpty(),
            )
            "chat" -> {
                val vc = o.getAsJsonObject("view")
                Chat(
                    o.get("id")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                    o.get("v")?.asLong ?: 0L,
                    ChatView(
                        streaming = vc.get("streaming")?.asBoolean ?: false,
                        messages = vc.getAsJsonArray("messages")
                            ?.mapNotNull { PhoneMessage.fromJson(it.asJsonObject) }
                            .orEmpty(),
                        pending = vc.getAsJsonArray("pending")
                            ?.mapNotNull {
                                val p = it.asJsonObject
                                val id = p.get("id")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null
                                PendingMsg(id, p.get("text")?.takeIf { !it.isJsonNull }?.asString.orEmpty())
                            }
                            .orEmpty(),
                    ),
                )
            }
            "host" -> Host(o.get("ok")?.asBoolean ?: false)
            "error" -> Error(o.get("msg")?.takeIf { !it.isJsonNull }?.asString.orEmpty())
            else -> Error("unknown event")
        }

        private fun sessionFromJson(o: JsonObject): PhoneSession = PhoneSession(
            id = o.get("id").asString,
            title = o.get("title")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            status = o.get("status")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            activity = o.get("activity")?.takeIf { !it.isJsonNull }?.asString,
            modifiedAt = o.get("modifiedAt")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            project = o.get("project")?.takeIf { !it.isJsonNull }?.asString,
        )
    }
}

// ---------------------------------------------------------------------------
// = 手机 → daemon（命令）                                                     =
// ---------------------------------------------------------------------------

object Commands {
    fun hello(device: String) = gson.toJson(mapOf("t" to "hello", "device" to device))
    fun select(id: String) = gson.toJson(mapOf("t" to "select", "id" to id))
    fun send(text: String) = gson.toJson(mapOf("t" to "send", "text" to text))
}

val gson = Gson()
