package com.bsg.alm.pda.core

import android.annotation.SuppressLint
import android.content.Context
import android.content.RestrictionsManager
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings.Secure
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.bsg.alm.pda.BuildConfig
import java.security.SecureRandom

/** 스캐너 연동 방식. 기종마다 스캔값을 넘기는 방식이 달라 설정으로 고른다 */
enum class ScanMode { BROADCAST, KEYBOARD, CAMERA }

/**
 * 앱 설정과 비밀값. Android Keystore로 암호화한 SharedPreferences에 둔다(09 6.5).
 *  - 기기 시리얼·API 주소는 MDM 관리형 구성(app_restrictions)이 있으면 그것이 우선
 *  - DB 암호(SQLCipher)는 처음 실행 때 만든 32바이트 난수
 */
class Settings(private val ctx: Context) {
    val prefs: SharedPreferences by lazy {
        val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(ctx, "alm_secure", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    }

    private fun managed(key: String): String? {
        val rm = ctx.getSystemService(Context.RESTRICTIONS_SERVICE) as? RestrictionsManager ?: return null
        return rm.applicationRestrictions?.getString(key)?.trim()?.takeIf { it.isNotEmpty() }
    }

    val managedDeviceSerial: Boolean get() = managed("deviceSerial") != null

    var apiBase: String
        get() = managed("apiBase") ?: prefs.getString("apiBase", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.API_BASE
        set(v) = prefs.edit().putString("apiBase", v.trim().trimEnd('/')).apply()

    /** X-Device-Id. MDM 값 → 관리자가 설정 화면에서 넣은 값 → 모델명-ANDROID_ID(파일럿 기본) */
    var deviceSerial: String
        get() = managed("deviceSerial") ?: prefs.getString("deviceSerial", null)?.takeIf { it.isNotBlank() } ?: defaultSerial()
        set(v) = prefs.edit().putString("deviceSerial", v.trim()).apply()

    @SuppressLint("HardwareIds")
    private fun defaultSerial(): String {
        val id = Secure.getString(ctx.contentResolver, Secure.ANDROID_ID) ?: "unknown"
        return sanitizeSerial("${Build.MODEL}-${id.take(12)}")
    }

    var lastEmail: String
        get() = prefs.getString("lastEmail", null) ?: managed("loginEmailDomain")?.let { "@$it" } ?: ""
        set(v) = prefs.edit().putString("lastEmail", v).apply()

    var scanMode: ScanMode
        get() = runCatching { ScanMode.valueOf(prefs.getString("scanMode", null) ?: "") }.getOrDefault(ScanMode.BROADCAST)
        set(v) = prefs.edit().putString("scanMode", v.name).apply()
    /** Scan Tool 등 스캐너 앱의 '방송 출력' 액션·키 */
    var scanAction: String
        get() = prefs.getString("scanAction", null) ?: DEFAULT_SCAN_ACTION
        set(v) = prefs.edit().putString("scanAction", v.trim()).apply()
    var scanExtra: String
        get() = prefs.getString("scanExtra", null) ?: DEFAULT_SCAN_EXTRA
        set(v) = prefs.edit().putString("scanExtra", v.trim()).apply()

    /** 스캔을 바로 보낼지. 끄면 대기열에 모아 두었다가 'Send now'로 보낸다(보내기 전에 지우고 다시 시험할 때) */
    var autoSend: Boolean
        get() = prefs.getBoolean("autoSend", true)
        set(v) = prefs.edit().putBoolean("autoSend", v).apply()

    var continuousScan: Boolean
        get() = prefs.getBoolean("continuous", true)
        set(v) = prefs.edit().putBoolean("continuous", v).apply()

    /** SQLCipher DB 암호 */
    fun dbPassphrase(): ByteArray {
        val hex = prefs.getString("dbKey", null) ?: ByteArray(32).also { SecureRandom().nextBytes(it) }.toHex().also { prefs.edit().putString("dbKey", it).commit() }
        return hex.hexToBytes()
    }

    companion object {
        const val DEFAULT_SCAN_ACTION = "com.bsg.alm.SCAN"
        const val DEFAULT_SCAN_EXTRA = "barcode"
        fun sanitizeSerial(s: String) = s.replace(Regex("[^A-Za-z0-9._:-]"), "-").take(40)
    }
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
fun String.hexToBytes(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
