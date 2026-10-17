package com.bsg.alm.pda.scan

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import androidx.core.content.ContextCompat
import com.bsg.alm.pda.core.Settings
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/** 스캔 1건. method = openapi ScanIn.inputMethod(TRIGGER·CAMERA·MANUAL) */
data class ScanEvent(val code: String, val method: String)

/**
 * 하드웨어 스캐너 연동. 산업용 PDA 스캐너 앱(Farset G47의 Scan Tool 등)은 보통 두 가지로 값을 넘긴다.
 *  - 방송 출력(Broadcast): 설정한 액션으로 인텐트를 보내고, 값은 정해진 키(extra)에 담는다 → 여기서 받는다
 *  - 키보드 입력(Keyboard): 포커스된 입력칸에 글자를 치고 Enter → 스캔 화면 입력칸이 받는다(ScanScreen)
 * 기종마다 액션·키 이름이 달라서, 설정한 값 + 널리 쓰이는 이름을 함께 듣고, 키를 모르면 문자열 extra를 찾아 쓴다.
 */
class Scanner(private val ctx: Context, private val settings: Settings) {
    private val _events = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events: SharedFlow<ScanEvent> = _events
    /** 마지막으로 받은 방송(설정 화면의 '스캐너 시험'용: 액션·키 확인) */
    private val _lastRaw = MutableStateFlow<String?>(null)
    val lastRaw: StateFlow<String?> = _lastRaw
    private var registered: BroadcastReceiver? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val extras = intent.extras
            _lastRaw.value = describe(intent.action, extras)
            val code = extract(extras, settings.scanExtra)?.trim()?.trimEnd('\r', '\n')
            if (!code.isNullOrEmpty()) emit(ScanEvent(code, "TRIGGER"))
        }
    }

    fun emit(e: ScanEvent) { _events.tryEmit(e) }

    /** 화면이 보일 때만 듣는다(MainActivity onResume/onPause) */
    fun start() {
        if (registered != null) return
        val f = IntentFilter()
        (listOf(settings.scanAction) + KNOWN_ACTIONS).filter { it.isNotBlank() }.distinct().forEach { f.addAction(it) }
        ContextCompat.registerReceiver(ctx, receiver, f, ContextCompat.RECEIVER_EXPORTED)
        registered = receiver
    }

    fun stop() {
        registered?.let { runCatching { ctx.unregisterReceiver(it) } }
        registered = null
    }

    fun restart() { stop(); start() }

    companion object {
        /** 산업용 PDA에서 흔한 방송 액션(Urovo·iData·Newland·Chainway·Zebra 등) */
        val KNOWN_ACTIONS = listOf(
            "android.intent.ACTION_DECODE_DATA", "com.android.server.scannerservice.broadcast", "nlscan.action.SCANNER_RESULT",
            "com.scanner.broadcast", "com.android.scanner.broadcast", "scan.rcv.message", "com.barcode.sendBroadcast",
            "com.symbol.datawedge.api.RESULT_ACTION", "com.bsg.alm.SCAN",
        )
        /** 흔한 값 키 */
        val KNOWN_EXTRAS = listOf(
            "barcode", "barcode_string", "scannerdata", "SCAN_BARCODE1", "data", "barocode", "BARCODE", "value", "scan_data",
            "com.symbol.datawedge.data_string", "decode_data",
        )

        fun extract(extras: Bundle?, preferred: String): String? {
            if (extras == null) return null
            fun str(k: String): String? = when (val v = extras.get(k)) {
                is String -> v
                is ByteArray -> String(v, Charsets.UTF_8)
                is CharSequence -> v.toString()
                else -> null
            }
            (listOf(preferred) + KNOWN_EXTRAS).forEach { k -> str(k)?.takeIf { it.isNotBlank() }?.let { return it } }
            // 키를 모르면 문자열 값 하나를 쓴다(길이 정보 등 숫자 값은 건너뜀)
            return extras.keySet().mapNotNull { str(it) }.firstOrNull { it.isNotBlank() }
        }

        fun describe(action: String?, extras: Bundle?): String {
            val parts = extras?.keySet()?.joinToString(", ") { k ->
                @Suppress("DEPRECATION") val v = extras.get(k)
                "$k=" + when (v) { is ByteArray -> "bytes(${v.size})"; else -> v.toString().take(60) }
            } ?: ""
            return "action=$action\n$parts"
        }

        @Suppress("unused") val sdk = Build.VERSION.SDK_INT
    }
}
