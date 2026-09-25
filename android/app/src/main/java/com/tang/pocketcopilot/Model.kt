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
    /** 稳定消息 id（daemon 端 ${turnId}-user / ${turnId}-asst），供列表 key 跨快照复用 */
    abstract val id: String

    data class User(override val id: String, val text: String, val queued: Boolean = false) : PhoneMessage()
    data class Assistant(override val id: String, val parts: List<Part>, val done: Boolean) : PhoneMessage()

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
    val projectUri: String? = null,
    val archived: Boolean = false,
)

/** 可新建会话的项目（镜像 PhoneProject） */
data class PhoneProject(val uri: String, val name: String)

/** 新建会话的可选配置项（镜像 SessionConfigOption） */
data class SessionConfigOption(
    val key: String,
    val label: String,
    val value: String?,
    val options: List<String>,
)

/** 某项目的会话配置（新建会话确认弹窗用，镜像 PhoneSessionConfig） */
data class PhoneSessionConfig(
    val projectUri: String,
    val options: List<SessionConfigOption>,
)

// ---------------------------------------------------------------------------
// = daemon → 手机（事件）                                                     =
// ---------------------------------------------------------------------------

sealed class DaemonEvent {
    data class Welcome(val sessions: List<PhoneSession>, val focus: String?) : DaemonEvent()
    data class Sessions(val items: List<PhoneSession>) : DaemonEvent()
    data class Focus(val id: String?) : DaemonEvent()
    data class Projects(val items: List<PhoneProject>) : DaemonEvent()
    data class SessionCreated(val id: String) : DaemonEvent()
    data class ConfigResolved(val config: PhoneSessionConfig) : DaemonEvent()
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
            "focus" -> Focus(
                o.get("id")?.takeIf { !it.isJsonNull }?.asString,
            )
            "projects" -> Projects(
                o.getAsJsonArray("items")?.mapNotNull { p ->
                    val po = p.asJsonObject
                    val uri = po.get("uri")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null
                    PhoneProject(uri, po.get("name")?.takeIf { !it.isJsonNull }?.asString.orEmpty())
                }.orEmpty(),
            )
            "sessionCreated" -> SessionCreated(
                o.get("id")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            )
            "configResolved" -> {
                val c = o.getAsJsonObject("config")
                ConfigResolved(
                    PhoneSessionConfig(
                        projectUri = c.get("projectUri")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                        options = c.getAsJsonArray("options")?.mapNotNull { ito ->
                            val oo = ito.asJsonObject
                            SessionConfigOption(
                                key = oo.get("key")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                                label = oo.get("label")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
                                value = oo.get("value")?.takeIf { !it.isJsonNull }?.asString,
                                options = oo.getAsJsonArray("options")
                                    ?.mapNotNull { ito -> ito.takeIf { e -> e.isJsonPrimitive }?.asString }
                                    .orEmpty(),
                            )
                        }.orEmpty(),
                    ),
                )
            }
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
            projectUri = o.get("projectUri")?.takeIf { !it.isJsonNull }?.asString,
            archived = o.get("archived")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
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
    /** 在焦点会话所属项目下新建会话 */
    fun newSession() = gson.toJson(mapOf("t" to "newSession"))
    /** 在指定项目下新建会话（config 为手机确认后的配置） */
    fun newSessionIn(projectUri: String, config: Map<String, Any>? = null) =
        gson.toJson(
            buildMap {
                put("t", "newSessionIn")
                put("projectUri", projectUri)
                if (config != null) put("config", config)
            },
        )
    /** 请求解析项目的会话配置（新建会话确认弹窗用） */
    fun resolveConfig(projectUri: String) = gson.toJson(mapOf("t" to "resolveConfig", "projectUri" to projectUri))
    /** 标记 / 取消标记会话完成 */
    fun setArchived(id: String, archived: Boolean) = gson.toJson(mapOf("t" to "setArchived", "id" to id, "archived" to archived))
    /** 请求可新建会话的项目列表 */
    fun listProjects() = gson.toJson(mapOf("t" to "listProjects"))
}

val gson = Gson()
