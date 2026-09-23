package com.tang.pocketcopilot

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage

/**
 * 相机 + ML Kit 条码扫描。扫到结果回调 [onResult]（原始字符串），
 * 解析失败不回调，用户可取消返回手动输入。
 */
@Composable
fun QrScannerView(
    onResult: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    var done by remember { mutableStateOf(false) }

    val scanner = remember { BarcodeScanning.getClient() }

    LaunchedEffect(Unit) {
        try {
            val cameraProvider = withContext(Dispatchers.IO) {
                ProcessCameraProvider.getInstance(context).get()
            }
            val preview = androidx.camera.core.Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(context.mainExecutor) { image ->
                val img = InputImage.fromMediaImage(image.image!!, image.imageInfo.rotationDegrees)
                scanner.process(img)
                    .addOnSuccessListener { barcodes ->
                        image.close()
                        val raw = barcodes.firstOrNull()?.rawValue ?: return@addOnSuccessListener
                        if (!done) {
                            done = true
                            onResult(raw)
                        }
                    }
                    .addOnFailureListener { image.close() }
            }
            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                analysis,
            )
        } catch (e: Exception) {
            // 相机不可用 → 让用户取消回手动输入
            onCancel()
        }
    }

    DisposableEffect(Unit) {
        onDispose { scanner.close() }
    }

    androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxSize(),
        )
        androidx.compose.foundation.layout.Row(
            modifier = Modifier
                .fillMaxSize()
                .align(androidx.compose.ui.Alignment.BottomCenter),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            androidx.compose.material3.Text(
                "对准电脑端二维码",
                modifier = Modifier.weight(1f).padding(16.dp),
            )
            androidx.compose.material3.TextButton(onClick = onCancel) {
                androidx.compose.material3.Text("取消")
            }
        }
    }
}
