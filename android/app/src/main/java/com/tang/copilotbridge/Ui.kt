package com.tang.copilotbridge

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** VS Code Dark 2026 主题（匹配 PWA 的 --vscode-* 变量） */
private val VscodeDark = darkColorScheme(
    background = Color(0xFF121314),
    surface = Color(0xFF191A1B),
    surfaceVariant = Color(0xFF2A2B2C),
    onBackground = Color(0xFFBFBFBF),
    onSurface = Color(0xFFBFBFBF),
    onSurfaceVariant = Color(0xFF8C8C8C),
    outline = Color(0xFF2A2B2C),
    primary = Color(0xFF297AA0),
    onPrimary = Color.White,
)

/** 应用根：无连接配置 → 配对屏；有配置 → 聊天屏 */
@Composable
fun BridgeRoot(vm: AppViewModel) {
    MaterialTheme(colorScheme = VscodeDark) {
        val config by vm.config.collectAsStateWithLifecycle()
        Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF121314)) {
            if (config == null) {
                PairingScreen(vm)
            } else {
                ChatScreen(vm)
            }
        }
    }
}
