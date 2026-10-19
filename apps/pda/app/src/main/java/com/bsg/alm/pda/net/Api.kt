package com.bsg.alm.pda.net

import com.bsg.alm.pda.BuildConfig
import com.bsg.alm.pda.auth.AuthManager
import com.bsg.alm.pda.core.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** 서버 오류(problem+json). status 0 = 통신 실패(오프라인) */
class ApiException(val status: Int, val code: String?, message: String) : IOException(message) {
    val offline get() = status == 0
}

val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }

/**
 * ALM PDA API 호출. 모든 호출에 Bearer 토큰·X-Device-Id·상관 ID를 붙인다(09 6.5·7장).
 * 401이면 토큰을 다시 받아 한 번 더 시도한다.
 */
class Api(private val settings: Settings, private val auth: AuthManager) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS)
        .build()
    private val JSON = "application/json".toMediaType()

    suspend fun authConfig(email: String): PdaAuthConfig = withContext(Dispatchers.IO) {
        val url = "${settings.apiBase}/auth/pda-config".toHttpUrl().newBuilder().addQueryParameter("email", email).build()
        exec(Request.Builder().url(url).get().build(), serializer())
    }

    suspend fun me(): PdaMe = get("/pda/me")
    suspend fun registerDevice(model: String?): DeviceOut =
        send("PUT", "/pda/devices/${settings.deviceSerial}", DeviceRegister(settings.deviceSerial, model, BuildConfig.VERSION_NAME))
    suspend fun tasks(): PdaTaskList = get("/pda/tasks")
    suspend fun worklist(campaignId: String, since: String?, cursor: String?): WorklistPage =
        get("/pda/campaigns/$campaignId/worklist", "since" to since, "cursor" to cursor, "limit" to "2000")
    suspend fun tagIndex(campaignId: String, since: String?, cursor: String?): TagIndexPage =
        get("/pda/campaigns/$campaignId/tag-index", "since" to since, "cursor" to cursor)
    suspend fun rooms(campaignId: String): PdaRoomList = get("/pda/rooms", "campaignId" to campaignId)
    suspend fun codes(): PdaCodes = get("/pda/codes")
    suspend fun updateTask(taskId: String, body: TaskUpdate, idem: String): PdaTask = send("PATCH", "/pda/tasks/$taskId", body, idem)
    suspend fun scans(body: ScanBatch): ScanBatchResult = send("POST", "/pda/scans:batch", body)
    suspend fun unregistered(body: UnregisteredBatch): UnregisteredBatchResult = send("POST", "/pda/unregistered:batch", body)
    suspend fun presign(body: PresignRequest): PresignResponse = send("POST", "/pda/attachments:presign", body)
    /** PDA-09 자산 조회. 태그는 경로 한 칸으로 인코딩(슬래시 등) */
    suspend fun asset(tag: String): PdaAssetDetail {
        val u = "${settings.apiBase}/pda/assets".toHttpUrl().newBuilder().addPathSegment(tag).build()
        return authed(serializer()) { Request.Builder().url(u).get() }
    }

    /** 사진을 S3에 직접 올린다(발급받은 URL·헤더 그대로) */
    suspend fun upload(p: PresignResponse, file: File, contentType: String) = withContext(Dispatchers.IO) {
        val b = Request.Builder().url(p.uploadUrl).put(file.readBytes().toRequestBody(contentType.toMediaType()))
        p.headers.forEach { (k, v) -> b.header(k, v) }
        try {
            http.newCall(b.build()).execute().use { r -> if (!r.isSuccessful) throw ApiException(r.code, null, "Photo upload failed (${r.code})") }
        } catch (e: ApiException) { throw e } catch (e: IOException) { throw ApiException(0, null, "No connection") }
    }

    private suspend inline fun <reified T> get(path: String, vararg q: Pair<String, String?>): T {
        val u = "${settings.apiBase}$path".toHttpUrl().newBuilder()
        q.forEach { (k, v) -> if (v != null) u.addQueryParameter(k, v) }
        return authed(serializer()) { Request.Builder().url(u.build()).get() }
    }

    private suspend inline fun <reified B, reified T> send(method: String, path: String, body: B, idem: String? = null): T {
        val payload = json.encodeToString(serializer<B>(), body).toRequestBody(JSON)
        return authed(serializer()) {
            Request.Builder().url("${settings.apiBase}$path").method(method, payload as RequestBody).also { if (idem != null) it.header("Idempotency-Key", idem) }
        }
    }

    private suspend fun <T> authed(ser: KSerializer<T>, build: () -> Request.Builder): T {
        for (attempt in 0..1) {
            val token = auth.accessToken()
            val req = build().header("Authorization", "Bearer $token").header("X-Device-Id", settings.deviceSerial)
                .header("X-Correlation-Id", UUID.randomUUID().toString()).header("Accept", "application/json").build()
            try {
                return withContext(Dispatchers.IO) { exec(req, ser) }
            } catch (e: ApiException) {
                if (e.status == 401 && attempt == 0) { auth.invalidateAccess(); continue }
                throw e
            }
        }
        throw ApiException(401, "ALM-E402", "Sign in again")
    }

    private fun <T> exec(req: Request, ser: KSerializer<T>): T {
        val resp = try { http.newCall(req).execute() } catch (e: IOException) { throw ApiException(0, null, "No connection") }
        resp.use { r ->
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) {
                val p = runCatching { json.decodeFromString(Problem.serializer(), text) }.getOrNull()
                throw ApiException(r.code, p?.code, p?.detail ?: p?.message ?: p?.title ?: "Server error (${r.code})")
            }
            return json.decodeFromString(ser, text)
        }
    }
}
