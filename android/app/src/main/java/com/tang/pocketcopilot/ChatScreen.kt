package com.tang.pocketcopilot

import android.graphics.Typeface
import android.text.method.LinkMovementMethod
import android.widget.TextView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.html.HtmlPlugin
import io.noties.markwon.syntax.SyntaxHighlightPlugin
import io.noties.markwon.syntax.VscDarkPlusTheme
import io.noties.prism4j.Prism4j
import kotlin.math.roundToInt

// ---- VS Code Dark 2026 色板（1:1 对齐 PWA 的 --vscode-* 变量）----
private val Bg = Color(0xFF121314)
private val CardBg = Color(0xFF191A1B)
private val Muted = Color(0x22FFFFFF)
private val Border = Color(0xFF2A2B2C)
private val Fg = Color(0xFFBFBFBF)
private val MutedFg = Color(0xFF8C8C8C)
private val UserBubble = Color(0x13FFFFFF)
private val Accent = Color(0xFF297AA0)
private val CodeBg = Color(0xFF242526)
private val Link = Color(0xFF48A0C7)
private val Success = Color(0xFF54B054)

/** 聊天主屏：匹配 PWA 布局（顶栏 + 抽屉 + 消息流 + 输入框） */
@Composable
fun ChatScreen(vm: AppViewModel) {
    val clientState by vm.clientState.collectAsStateWithLifecycle()
    val sessions by vm.sessions.collectAsStateWithLifecycle()
    val focus by vm.focus.collectAsStateWithLifecycle()
    val view by vm.view.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()

    var input by remember { mutableStateOf("") }
    var drawerOpen by remember { mutableStateOf(false) }
    var titleMenuOpen by remember { mutableStateOf(false) }

    val v = view
    val running = v?.streaming == true

    // 当前会话所属项目 + 同项目会话列表（标题下拉切换用，匹配 PWA）
    val activeProject = remember(sessions, focus) {
        sessions.firstOrNull { it.id == focus }?.project
    }
    val titleMenuList = remember(sessions, activeProject) {
        if (activeProject == null) emptyList()
        else sessions.filter { it.project == activeProject }
    }
    val displayTitle = remember(sessions, focus) {
        sessions.firstOrNull { it.id == focus }?.title?.ifBlank { null }
            ?: if (clientState == PocketClient.ClientState.AUTHENTICATED) "Pocket Copilot" else "连接中…"
    }

    val listState = rememberLazyListState()
    val messageCount = v?.messages?.size ?: 0
    // reverseLayout:索引 0 = 最新消息,天然锚定在视口底部(键盘弹出/收起时保持可见)。
    // 切换会话时直接跳到最新消息(否则沿用上一会话的滚动位置,看起来像"落后");
    // 同会话内用户已在底部时,新消息到来或流式更新自动跟随
    var lastFocus by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(focus, messageCount, running) {
        if (messageCount == 0) return@LaunchedEffect
        if (lastFocus != focus) {
            lastFocus = focus
            listState.scrollToItem(0)
            return@LaunchedEffect
        }
        if (listState.firstVisibleItemIndex == 0) {
            listState.animateScrollToItem(0)
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Bg)) {
        // imePadding:边到边模式下窗口不随键盘收缩,需手动为 IME 留空间
        Column(modifier = Modifier.fillMaxSize().imePadding()) {
            // ---- 顶栏：菜单按钮 + 居中标题（可下拉切换同项目会话）----
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Muted)
                        .clickable { drawerOpen = true },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Menu, contentDescription = "打开会话列表", tint = Fg)
                }
                Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(enabled = titleMenuList.size > 1) {
                                titleMenuOpen = !titleMenuOpen
                            }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        Text(
                            displayTitle,
                            style = MaterialTheme.typography.titleMedium.copy(fontSize = 15.sp),
                            fontWeight = FontWeight.SemiBold,
                            color = Fg,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 220.dp),
                        )
                        if (titleMenuList.size > 1) {
                            Spacer(Modifier.width(4.dp))
                            Icon(
                                Icons.Filled.ArrowDropDown,
                                contentDescription = "切换会话",
                                tint = MutedFg,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                    }
                    DropdownMenu(
                        expanded = titleMenuOpen,
                        onDismissRequest = { titleMenuOpen = false },
                    ) {
                        titleMenuList.forEach { s ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        s.title.ifBlank { s.id.take(8) },
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                },
                                onClick = {
                                    titleMenuOpen = false
                                    if (s.id != focus) vm.select(s.id)
                                },
                            )
                        }
                    }
                }
                StatusDot(clientState)
            }

            // ---- 错误条 ----
            if (error != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF3A1D1D))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(error!!, color = Color(0xFFF48771), fontSize = 12.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = { vm.dismissError() }) {
                        Icon(Icons.Filled.Close, contentDescription = "关闭", tint = Color(0xFFF48771))
                    }
                }
            }

            // ---- 消息区（weight 占满剩余高度，给输入区留出空间）----
            Box(
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentAlignment = Alignment.Center,
            ) {
            if (clientState != PocketClient.ClientState.AUTHENTICATED) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(8.dp))
                        Text(
                            when (clientState) {
                                PocketClient.ClientState.CONNECTING -> "连接中…"
                                else -> "未连接（自动重连中）"
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MutedFg,
                        )
                    }
                }
            } else if (v == null || v.messages.isEmpty()) {
                // 空状态：居中图标 + 引导文案（匹配 PWA EmptyState）
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.padding(24.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(56.dp)
                                .clip(CircleShape)
                                .background(Muted),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Filled.Chat,
                                contentDescription = null,
                                tint = Accent,
                                modifier = Modifier.size(28.dp),
                            )
                        }
                        Spacer(Modifier.height(14.dp))
                        Text(
                            "向 Copilot 发送第一条消息",
                            style = MaterialTheme.typography.titleMedium,
                            color = Fg,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "从左侧选择一个会话，或直接输入消息发送到 VS Code",
                            style = MaterialTheme.typography.bodySmall,
                            color = MutedFg,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.widthIn(max = 280.dp),
                        )
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    reverseLayout = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 720.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // reverseLayout 把 index 0 钉在底部,故反转消息列表使最新消息位于 index 0(底部),
                    // 上滑查看更早消息;新消息追加后自动锚定在底部
                    items(v.messages.reversed(), key = { it.hashCode() }) { msg ->
                        when (msg) {
                            is PhoneMessage.User -> UserBubble(msg.text)
                            is PhoneMessage.Assistant -> AssistantMessage(msg.parts, streaming = running)
                        }
                    }
                    // 排队消息(紧跟最新消息之后,位于列表顶部)
                    items(v.pending.reversed(), key = { "pending-" + it.id }) { p ->
                        Text(
                            "⏳ ${p.text}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MutedFg,
                        )
                    }
                }
            }
            }

            // ---- 输入区：圆角框 + 圆形发送按钮（匹配 PWA InputFooter）----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 720.dp)
                    .align(Alignment.CenterHorizontally)
                    .navigationBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                if (running) {
                    Text(
                        "Copilot 正在工作，现在发送的消息将排队",
                        style = MaterialTheme.typography.bodySmall,
                        color = MutedFg,
                        modifier = Modifier.padding(start = 8.dp, bottom = 6.dp),
                    )
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(16.dp))
                        .background(CardBg)
                        .border(1.dp, Border, RoundedCornerShape(16.dp))
                        .padding(start = 14.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    BasicTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier
                            .weight(1f)
                            .padding(bottom = 8.dp),
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = Fg),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                        maxLines = 4,
                        decorationBox = { inner ->
                            if (input.isEmpty()) {
                                Text("发送消息…", color = MutedFg, style = MaterialTheme.typography.bodyMedium)
                            }
                            inner()
                        },
                    )
                    Box(
                        modifier = Modifier
                            .size(34.dp)
                            .clip(CircleShape)
                            .background(if (input.isNotBlank()) Accent else Muted)
                            .clickable(enabled = input.isNotBlank()) {
                                vm.send(input)
                                input = ""
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.Send,
                            contentDescription = "发送",
                            tint = if (input.isNotBlank()) Color.White else MutedFg,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }

        // ---- 抽屉遮罩（淡入淡出）----
        AnimatedVisibility(
            visible = drawerOpen,
            modifier = Modifier.fillMaxSize(),
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0x80000000))
                    .clickable { drawerOpen = false },
            )
        }
        // ---- 会话抽屉：项目分组（匹配 PWA Sidebar）----
        AnimatedVisibility(
            visible = drawerOpen,
            modifier = Modifier
                .align(Alignment.TopStart)
                .fillMaxHeight()
                .width(280.dp),
            enter = slideInHorizontally(initialOffsetX = { -it }),
            exit = slideOutHorizontally(targetOffsetX = { -it }),
        ) {
            Sidebar(
                sessions = sessions,
                focus = focus,
                onPick = { id ->
                    vm.select(id)
                    drawerOpen = false
                },
            )
        }
    }
}

@Composable
private fun Sidebar(
    sessions: List<PhoneSession>,
    focus: String?,
    onPick: (String) -> Unit,
) {
    val activeProject = remember(sessions, focus) {
        sessions.firstOrNull { it.id == focus }?.project
    }
    // 按项目分组，组内按修改时间倒序，组间按最近活动倒序（匹配 PWA）
    val groups = remember(sessions) {
        sessions
            .groupBy { it.project ?: "(未命名项目)" }
            .map { (project, list) ->
                Triple(project, list.sortedByDescending { it.modifiedAt }, list.firstOrNull()?.modifiedAt ?: "")
            }
            .sortedByDescending { it.third }
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(CardBg)
            .border(width = 1.dp, color = Border),
    ) {
        Text(
            "会话",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = Fg,
            modifier = Modifier.padding(start = 16.dp, top = 14.dp, end = 16.dp, bottom = 10.dp),
        )
        if (groups.isEmpty()) {
            Text(
                "暂无项目",
                style = MaterialTheme.typography.bodySmall,
                color = MutedFg,
                modifier = Modifier.padding(16.dp),
            )
        }
        LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(8.dp)) {
            items(groups, key = { it.first }) { (project, list, _) ->
                val active = project == activeProject
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (active) Muted else Color.Transparent)
                        .clickable { onPick(list.first().id) }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    Text(
                        project,
                        style = MaterialTheme.typography.bodyLarge,
                        color = Fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val recent = list.first()
                    Text(
                        "${recent.title.ifBlank { recent.id.take(8) }} · ${list.size} 会话",
                        style = MaterialTheme.typography.labelSmall,
                        color = MutedFg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusDot(status: PocketClient.ClientState) {
    val color = when (status) {
        PocketClient.ClientState.AUTHENTICATED -> Success
        PocketClient.ClientState.CONNECTING -> Color(0xFFFFC107)
        PocketClient.ClientState.DISCONNECTED -> Color(0xFFF48771)
    }
    Box(
        modifier = Modifier
            .padding(start = 4.dp)
            .size(10.dp)
            .background(color, CircleShape),
    )
}

// ---- 消息渲染（匹配 PWA：用户右对齐气泡，助手全宽 + Markdown + 步骤折叠）----

@Composable
private fun UserBubble(text: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Box(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(UserBubble)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(text, color = Fg, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** 助手消息：把 parts 拆成 [文本段, 步骤组, 文本段, ...]，步骤组可折叠（匹配 PWA StepsGroup） */
@Composable
private fun AssistantMessage(parts: List<Part>, streaming: Boolean) {
    val blocks = remember(parts) { groupParts(parts) }
    Column(modifier = Modifier.fillMaxWidth()) {
        blocks.forEachIndexed { i, block ->
            when (block) {
                is Block.Text -> {
                    if (block.text.isNotBlank()) {
                        MarkdownText(block.text)
                    }
                }
                is Block.Steps -> {
                    StepsGroup(block.parts, isLast = i == blocks.lastIndex && streaming)
                }
            }
        }
    }
}

private sealed class Block {
    data class Text(val text: String) : Block()
    data class Steps(val parts: List<Part>) : Block()
}

/** 把连续的 reasoning/tool parts 合并成一个步骤组，text parts 单独成段 */
private fun groupParts(parts: List<Part>): List<Block> {
    val blocks = mutableListOf<Block>()
    var stepBuf = mutableListOf<Part>()
    parts.forEach { part ->
        when (part) {
            is Part.Text -> {
                if (stepBuf.isNotEmpty()) {
                    blocks.add(Block.Steps(stepBuf.toList()))
                    stepBuf = mutableListOf()
                }
                blocks.add(Block.Text(part.text))
            }
            else -> stepBuf.add(part)
        }
    }
    if (stepBuf.isNotEmpty()) blocks.add(Block.Steps(stepBuf.toList()))
    return blocks
}

@Composable
private fun StepsGroup(parts: List<Part>, isLast: Boolean) {
    var expanded by remember { mutableStateOf(false) }
    val done = !isLast
    val title = if (done) "Finished with ${parts.size} steps" else "Working…"
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { expanded = !expanded }
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (done) {
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = Success,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
            } else {
                CircularProgressIndicator(modifier = Modifier.size(12.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(
                title,
                style = MaterialTheme.typography.bodySmall,
                color = MutedFg,
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.Filled.ChevronRight,
                contentDescription = if (expanded) "收起" else "展开",
                tint = MutedFg,
                modifier = Modifier
                    .size(14.dp)
                    .rotate(if (expanded) 90f else 0f),
            )
        }
        if (expanded) {
            Column(
                modifier = Modifier
                    .padding(top = 6.dp, start = 7.dp)
                    .drawBehind {
                        drawLine(
                            color = Border,
                            start = Offset(0f, 0f),
                            end = Offset(0f, size.height),
                            strokeWidth = 1.dp.toPx(),
                        )
                    }
                    .padding(start = 12.dp),
            ) {
                parts.forEach { part ->
                    when (part) {
                        is Part.Reasoning -> {
                            if (part.text.isNotBlank()) {
                                Row(
                                    modifier = Modifier.padding(vertical = 3.dp),
                                    verticalAlignment = Alignment.Top,
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .padding(top = 6.dp)
                                            .size(6.dp)
                                            .background(MutedFg, CircleShape),
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        part.text,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MutedFg,
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }
                        }
                        is Part.Tool -> {
                            Row(
                                modifier = Modifier.padding(vertical = 3.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                ToolIcon(part.name)
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    part.label,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Fg,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Text(
                                    part.status,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MutedFg,
                                )
                            }
                        }
                        is Part.Text -> {}
                    }
                }
            }
        }
    }
}

/** 工具图标（匹配 PWA ICON_RULES：readFile→文档，edit→编辑，terminal→终端，browser→地球...） */
@Composable
private fun ToolIcon(name: String) {
    val icon = when {
        name.contains("readfile", true) || name.contains("view", true) || name.contains("list", true) -> Icons.Filled.Description
        name.contains("edit", true) || name.contains("create", true) -> Icons.Filled.Edit
        name.contains("terminal", true) || name.contains("powershell", true) || name.contains("shell", true) -> Icons.Filled.Terminal
        name.contains("browser", true) || name.contains("web", true) || name.contains("page", true) -> Icons.Filled.Public
        name.contains("search", true) || name.contains("grep", true) || name.contains("glob", true) -> Icons.Filled.Search
        else -> Icons.Filled.Menu
    }
    Icon(icon, contentDescription = null, tint = MutedFg, modifier = Modifier.size(14.dp))
}

/** 色值 → 0xAARRGGBB int（Markwon 主题用） */
private fun Color.argb(): Int {
    val a = (alpha * 255).roundToInt() and 0xFF
    val r = (red * 255).roundToInt() and 0xFF
    val g = (green * 255).roundToInt() and 0xFF
    val b = (blue * 255).roundToInt() and 0xFF
    return (a shl 24) or (r shl 16) or (g shl 8) or b
}

/**
 * VS Code Dark 主题插件：Markwon 4.x 通过 MarkwonPlugin#configureTheme 定制主题
 * （MarkwonTheme.Builder 构造函数为包私有，Builder 无 .theme() 方法）。
 */
private class VscDarkThemePlugin : AbstractMarkwonPlugin() {
    override fun configureTheme(builder: MarkwonTheme.Builder) {
        builder
            .linkColor(Link.argb())
            .codeBackgroundColor(CodeBg.argb())
            .codeBlockBackgroundColor(CodeBg.argb())
            .codeTextColor(Fg.argb())
            .codeBlockTextColor(Fg.argb())
            .codeTypeface(Typeface.MONOSPACE)
            .codeBlockTypeface(Typeface.MONOSPACE)
            .codeBlockMargin(0)
            .headingTextSizeMultipliers(floatArrayOf(1.23f, 1.08f, 1f, 1f, 1f, 1f))
            .blockQuoteWidth(3)
            .blockQuoteColor(Border.argb())
            .listItemColor(Fg.argb())
            .thematicBreakColor(Border.argb())
    }
}

/** Markdown 渲染（Markwon + TextView，匹配 PWA 的 react-markdown 排版） */
@Composable
private fun MarkdownText(text: String) {
    val context = LocalContext.current
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(VscDarkThemePlugin())
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TablePlugin.create(context))
            .usePlugin(HtmlPlugin.create())
            .usePlugin(
                SyntaxHighlightPlugin.create(
                    Prism4j(GrammarLocatorDef()),
                    VscDarkPlusTheme(),
                ),
            )
            .build()
    }
    AndroidView(
        factory = { ctx ->
            TextView(ctx).apply {
                setTextColor(Fg.argb())
                setTextSize(13f)
                setLineSpacing(0f, 1.5f)
                movementMethod = LinkMovementMethod.getInstance()
                setPadding(0, 8, 0, 0)
            }
        },
        update = { tv ->
            markwon.setMarkdown(tv, text)
        },
        modifier = Modifier.fillMaxWidth(),
    )
}
