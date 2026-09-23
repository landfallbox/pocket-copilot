package com.tang.pocketcopilot

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** 配对屏：扫码（CameraX + ML Kit）或手动输入 host/port/device */
@Composable
fun PairingScreen(vm: AppViewModel) {
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("8765") }
    var device by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }

    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) scanning = true
    }

    if (scanning) {
        QrScannerView(
            onResult = { raw ->
                scanning = false
                val c = parsePairUri(raw)
                if (c != null) vm.connect(c)
            },
            onCancel = { scanning = false },
        )
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Pocket Copilot", style = MaterialTheme.typography.headlineMedium)
        Text(
            "扫描电脑端二维码，或手动输入连接信息",
            style = MaterialTheme.typography.bodyMedium,
        )

        Spacer24()

        Button(
            onClick = { cameraPermission.launch(Manifest.permission.CAMERA) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("扫码配对") }

        Spacer24()
        HorizontalDivider()
        Spacer24()

        OutlinedTextField(
            value = host,
            onValueChange = { host = it },
            label = { Text("Host（Tailscale IP 或局域网 IP）") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = port,
            onValueChange = { port = it },
            label = { Text("Port") },
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
        )
        OutlinedTextField(
            value = device,
            onValueChange = { device = it },
            label = { Text("Device Token") },
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
        )

        OutlinedButton(
            onClick = {
                val p = port.toIntOrNull() ?: 8765
                if (host.isNotBlank() && device.isNotBlank()) {
                    vm.connect(ConnConfig(host.trim(), p, device.trim()))
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 16.dp),
        ) { Text("连接") }
    }
}

@Composable
private fun Spacer24() {
    androidx.compose.foundation.layout.Spacer(Modifier.height(24.dp))
}

/** 解析 pocket-copilot://pair?host=..&port=..&device=.. */
fun parsePairUri(raw: String): ConnConfig? {
    val uri = android.net.Uri.parse(raw)
    if (uri.scheme != "pocket-copilot" || uri.host != "pair") return null
    val host = uri.getQueryParameter("host") ?: return null
    val port = uri.getQueryParameter("port")?.toIntOrNull() ?: 8765
    val device = uri.getQueryParameter("device") ?: return null
    return ConnConfig(host, port, device)
}
