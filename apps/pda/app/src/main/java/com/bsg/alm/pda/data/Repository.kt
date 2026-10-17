package com.bsg.alm.pda.data

import android.content.Context
import android.os.Build
import com.bsg.alm.pda.auth.AuthManager
import com.bsg.alm.pda.core.Settings
import com.bsg.alm.pda.net.Api
import com.bsg.alm.pda.net.ApiException
import com.bsg.alm.pda.net.PresignRequest
import com.bsg.alm.pda.net.ScanBatch
import com.bsg.alm.pda.net.ScanIn
import com.bsg.alm.pda.net.TaskUpdate
import com.bsg.alm.pda.net.UnregisteredBatch
import com.bsg.alm.pda.net.UnregisteredIn
import com.bsg.alm.pda.net.json
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.UUID

/** 사진 1장(로컬 파일 + 업로드 뒤 받은 첨부 id) */
@Serializable data class Photo(val path: String, val attachmentId: String? = null)

data class SyncStatus(val running: Boolean = false, val lastSyncAt: Long? = null, val error: String? = null, val online: Boolean = true)

/** 스캔 결과(화면 표시용) */
data class ScanOutcome(val tag: String, val result: String, val item: WorkItem?, val queueId: Long?, val roomChanged: RoomEntity? = null)

/**
 * PDA 업무 로직: 동기화(작업·작업목록 델타·색인·룸·코드), 오프라인 판정·대기열, 전송(사진 업로드 포함).
 * 모든 데이터는 로그인 사용자(userId) 기준으로 나눈다.
 */
class Repository(private val ctx: Context, private val settings: Settings, val auth: AuthManager, private val api: Api, val db: AlmDb) {
    val dao = db.dao()
    private val syncLock = Mutex()
    private val flushLock = Mutex()
    private val _status = MutableStateFlow(SyncStatus(lastSyncAt = settings.prefs.getLong("lastSyncAt", 0).takeIf { it > 0 }))
    val status: StateFlow<SyncStatus> = _status
    var deviceId: String?
        get() = settings.prefs.getString("deviceId", null)
        private set(v) = settings.prefs.edit().putString("deviceId", v).apply()

    val userId: String get() = auth.userId ?: throw AuthManager.NotSignedIn()

    private fun now(): String = OffsetDateTime.now().toString()

    suspend fun authConfig(email: String) = api.authConfig(email)

    /** 로그인 직후: 사용자 확인(/pda/me) + 기기 등록 → 동기화 */
    suspend fun afterLogin() {
        val me = api.me()
        if (auth.userId != null && auth.userId != me.userId) dao.clearUser(auth.userId!!)
        auth.userId = me.userId
        auth.displayName = me.displayName
        deviceId = api.registerDevice("${Build.MANUFACTURER} ${Build.MODEL}".trim()).deviceId
        sync(full = false)
    }

    // ---------------- 동기화 ----------------
    suspend fun sync(full: Boolean = false): Result<Unit> = syncLock.withLock {
        _status.value = _status.value.copy(running = true, error = null)
        val r = runCatching {
            flush()
            if (deviceId == null) deviceId = api.registerDevice("${Build.MANUFACTURER} ${Build.MODEL}".trim()).deviceId
            val uid = userId
            val tasks = api.tasks().items
            dao.clearTasks(uid)
            dao.upsertTasks(tasks.map { t ->
                TaskEntity(t.taskId, uid, t.campaignId, t.campaignCode, t.campaignName, t.keyDate, t.dueDate, t.roomId, t.roomCode, t.roomName,
                    t.siteCode, t.status, t.expectedCount, t.foundCount, t.pendingCount)
            })
            for (campaignId in tasks.map { it.campaignId }.distinct()) syncCampaign(uid, campaignId, full)
            val codes = api.codes()
            dao.replaceCodes(codes.categories.map { CodeEntity("category", it.id, it.label) } + codes.conditions.map { CodeEntity("condition", it.id, it.label) })
            dao.purgeSent(System.currentTimeMillis() - 24 * 3600_000L)
        }
        val e = r.exceptionOrNull()
        val at = if (e == null) System.currentTimeMillis().also { settings.prefs.edit().putLong("lastSyncAt", it).apply() } else _status.value.lastSyncAt
        _status.value = SyncStatus(running = false, lastSyncAt = at, error = e?.message, online = !(e is ApiException && e.offline))
        r
    }

    private suspend fun syncCampaign(uid: String, campaignId: String, full: Boolean) {
        var s = dao.sync(uid, campaignId)
        if (full) { dao.clearItems(uid, campaignId); dao.clearTags(campaignId); s = null }
        // 작업목록(델타). 토큰 만료(410 E309)면 전체 다시
        val wl = try { pageWorklist(uid, campaignId, s?.worklistToken) } catch (e: ApiException) {
            if (e.status != 410) throw e
            dao.clearItems(uid, campaignId); pageWorklist(uid, campaignId, null)
        }
        val tg = try { pageTags(campaignId, s?.tagToken) } catch (e: ApiException) {
            if (e.status != 410) throw e
            dao.clearTags(campaignId); pageTags(campaignId, null)
        }
        val rooms = api.rooms(campaignId).items
        dao.replaceRooms(campaignId, rooms.map { RoomEntity(campaignId, it.roomId, it.roomCode, it.name, it.floor, it.siteCode, it.barcode) })
        dao.upsertSync(CampaignSync(uid, campaignId, wl, tg, System.currentTimeMillis()))
    }

    private suspend fun pageWorklist(uid: String, campaignId: String, since: String?): String {
        var cursor: String? = null
        var token: String
        do {
            val p = api.worklist(campaignId, since, cursor)
            if (p.removed.isNotEmpty()) dao.deleteItems(p.removed)
            val existing = dao.itemsById(p.items.map { it.countItemId }).associateBy { it.countItemId }
            dao.upsertItems(p.items.map { w ->
                val old = existing[w.countItemId]
                // 기기 결과는 서버가 이미 받았거나(PENDING 아님) 아직 보내지 않은 스캔이 있을 때만 남긴다(재실사로 PENDING이 되면 지움)
                val keepLocal = old?.localCountedAt != null && (w.result != "PENDING" || dao.pendingScansFor(uid, campaignId, w.assetTag) > 0)
                WorkItem(w.countItemId, uid, campaignId, w.assetId, w.assetTag, w.description, w.categoryName, w.model, w.serialNo, w.assetStatus,
                    w.expectedRoomId, w.expectedRoomCode, w.assignedUserName, w.result, w.countedAt,
                    if (keepLocal) old?.localResult else null, if (keepLocal) old?.localRoomId else null,
                    if (keepLocal) old?.localCountedAt else null, old?.localCondition)
            })
            cursor = p.nextCursor
            token = p.syncToken
        } while (cursor != null)
        return token
    }

    private suspend fun pageTags(campaignId: String, since: String?): String {
        var cursor: String? = null
        var token: String
        do {
            val p = api.tagIndex(campaignId, since, cursor)
            dao.upsertTags(p.items.map { TagEntity(campaignId, it.assetTag, it.assetStatus, it.siteCode) })
            cursor = p.nextCursor
            token = p.syncToken
        } while (cursor != null)
        return token
    }

    // ---------------- 스캔 ----------------
    /**
     * 스캔 1건: 룸 바코드면 룸 변경, 아니면 판정 → 대상 갱신 → 대기열(SCAN).
     * UNREGISTERED·OUT_OF_SCOPE·RETIRED_ASSET도 기록으로 보낸다(서버가 다시 판정)
     */
    suspend fun scan(campaignId: String, task: TaskEntity?, roomId: String?, raw: String, method: String,
                     condition: String? = null, confirmed: Boolean? = null, relabel: Boolean? = null, note: String? = null,
                     photos: List<Photo> = emptyList()): ScanOutcome {
        val uid = userId
        val code = raw.trim()
        dao.roomByCode(campaignId, code)?.let { return ScanOutcome(code, "ROOM", null, null, roomChanged = it) }
        if (roomId == null || task == null) return ScanOutcome(code, "NO_ROOM", null, null)
        val item = dao.itemByTag(uid, campaignId, code)
        val tag = if (item == null) dao.tag(campaignId, code) else null
        val counted = item?.localRoomId ?: if (item != null && item.result != "PENDING") item.expectedRoomId.takeIf { item.result == "FOUND" } else null
        val result = Judge.judge(Judge.Input(roomId, item?.assetStatus, item?.expectedRoomId, counted, tag?.assetStatus))
        val at = System.currentTimeMillis()
        if (item != null && (Judge.countsItem(result) || result == Judge.DUPLICATE)) {
            dao.markCounted(item.countItemId, if (result == Judge.DUPLICATE) (item.localResult ?: item.result) else result, roomId, at, condition)
        }
        if (task.status == "NOT_STARTED" || task.status == "COMPLETED") dao.setTaskStatus(task.taskId, "IN_PROGRESS")
        val body = ScanIn(UUID.randomUUID().toString(), campaignId, task.taskId, roomId, code, method, result, condition, confirmed, relabel,
            note?.takeIf { it.isNotBlank() }, null, now())
        val q = dao.enqueue(QueueItem(userId = uid, type = "SCAN", campaignId = campaignId, roomId = roomId,
            label = item?.assetTag ?: code, detail = item?.let { "${it.description}${it.model?.let { m -> " · $m" } ?: ""}" } ?: "",
            payload = json.encodeToString(ScanIn.serializer(), body), photos = photosJson(photos), localResult = result))
        return ScanOutcome(code, result, item, q)
    }

    /** 확인 화면(PDA-05)에서 상태·사진·메모를 붙여 다시 보낸다(같은 자산의 마지막 스캔이 남는다) */
    suspend fun confirm(campaignId: String, task: TaskEntity, roomId: String, item: WorkItem, condition: String?, relabel: Boolean, note: String?, photos: List<Photo>) =
        scan(campaignId, task, roomId, item.assetTag, "MANUAL", condition, true, relabel, note, photos)

    /** 미등록 자산(PDA-06). 임시번호는 기기 번호(시리얼 끝 5자리-순번), 서버가 UNREG-nnnn으로 바꾼다 */
    suspend fun reportUnregistered(campaignId: String, roomId: String, categoryId: String?, description: String, serialNo: String?,
                                   barcode: String?, photos: List<Photo>): String {
        require(photos.isNotEmpty()) { "Take at least one photo" }
        val uid = userId
        val n = dao.unregCount(uid, campaignId) + 1
        val provisional = "${settings.deviceSerial.takeLast(5).uppercase()}-${n.toString().padStart(4, '0')}"
        val body = UnregisteredIn(UUID.randomUUID().toString(), campaignId, roomId, provisional, categoryId, description.trim(),
            serialNo?.trim()?.takeIf { it.isNotEmpty() }, barcode?.trim()?.takeIf { it.isNotEmpty() }, emptyList(), now())
        dao.enqueue(QueueItem(userId = uid, type = "UNREG", campaignId = campaignId, roomId = roomId, label = provisional, detail = description.trim(),
            payload = json.encodeToString(UnregisteredIn.serializer(), body), photos = photosJson(photos), localResult = Judge.UNREGISTERED))
        return provisional
    }

    /** 룸 작업 시작·완료(PDA-07). 완료는 온라인이면 바로 보내 E305(미확인 남음)를 알려준다 */
    suspend fun updateTask(task: TaskEntity, action: String, force: Boolean): Result<Unit> {
        val body = TaskUpdate(action, now(), if (force) true else null)
        dao.setTaskStatus(task.taskId, if (action == "COMPLETE") "COMPLETED" else "IN_PROGRESS")
        dao.enqueue(QueueItem(userId = userId, type = "TASK", campaignId = task.campaignId, roomId = task.roomId, refId = task.taskId,
            label = "${task.roomCode} · ${action.lowercase()}", detail = task.campaignCode, payload = json.encodeToString(TaskUpdate.serializer(), body)))
        return runCatching { flush() }
    }

    // ---------------- 전송 ----------------
    /** 대기열을 순서대로 보낸다. 연속한 스캔은 200건, 미등록은 50건씩 묶는다. 통신이 끊기면 멈추고 다음에 이어서 */
    suspend fun flush() = flushLock.withLock {
        val uid = auth.userId ?: return@withLock
        val dev = deviceId ?: return@withLock
        val items = dao.pending(uid)
        var i = 0
        while (i < items.size) {
            val type = items[i].type
            val max = when (type) { "SCAN" -> 200; "UNREG" -> 50; else -> 1 }
            val group = items.drop(i).takeWhile { it.type == type }.take(max)
            i += group.size
            try {
                when (type) {
                    "SCAN" -> sendScans(dev, group)
                    "UNREG" -> sendUnregistered(dev, group)
                    "TASK" -> sendTask(group.single())
                }
            } catch (e: ApiException) {
                if (e.offline || e.status == 401 || e.status >= 500 || e.status == 429) { group.forEach { dao.queueFailed(it.id, e.message ?: "") }; throw e }
                // 요청 자체가 거부됨(400·403·409 등): 이 묶음은 오류로 두고 다음으로
                group.forEach { dao.setQueueState(it.id, QueueItem.REJECTED, "${e.code ?: e.status}: ${e.message}", null, System.currentTimeMillis()) }
            }
        }
        _status.value = _status.value.copy(online = true)
    }

    private suspend fun sendScans(dev: String, group: List<QueueItem>) {
        val bodies = group.map { q -> json.decodeFromString(ScanIn.serializer(), q.payload).copy(attachmentIds = uploadPhotos(q, "count_item").ifEmpty { null }) }
        val r = api.scans(ScanBatch(dev, bodies))
        val byId = r.results.associateBy { it.clientScanId }
        group.zip(bodies).forEach { (q, b) ->
            val x = byId[b.clientScanId]
            if (x == null || x.status == "REJECTED") dao.setQueueState(q.id, QueueItem.REJECTED, x?.let { "${it.code}: ${it.message}" } ?: "No result", null, System.currentTimeMillis())
            else dao.setQueueState(q.id, QueueItem.SENT, null, x.serverResult, System.currentTimeMillis())
        }
        r.tasks.forEach { dao.setTaskProgress(it.taskId, it.foundCount, it.pendingCount) }
        group.forEach { deletePhotos(it) }
    }

    private suspend fun sendUnregistered(dev: String, group: List<QueueItem>) {
        val bodies = group.map { q -> json.decodeFromString(UnregisteredIn.serializer(), q.payload).copy(attachmentIds = uploadPhotos(q, "count_unregistered")) }
        val r = api.unregistered(UnregisteredBatch(dev, bodies))
        val byId = r.results.associateBy { it.clientScanId }
        group.zip(bodies).forEach { (q, b) ->
            val x = byId[b.clientScanId]
            if (x == null || x.status == "REJECTED") dao.setQueueState(q.id, QueueItem.REJECTED, x?.let { "${it.code}: ${it.message}" } ?: "No result", null, System.currentTimeMillis())
            else dao.setQueueState(q.id, QueueItem.SENT, null, x.tempNo, System.currentTimeMillis())
        }
        group.forEach { deletePhotos(it) }
    }

    private suspend fun sendTask(q: QueueItem) {
        val body = json.decodeFromString(TaskUpdate.serializer(), q.payload)
        val t = api.updateTask(q.refId ?: throw ApiException(404, "ALM-E404", "Task not found on device"), body, "task-${q.id}-${q.createdAt}")
        dao.setTaskStatus(t.taskId, t.status)
        dao.setTaskProgress(t.taskId, t.foundCount, t.pendingCount)
        dao.setQueueState(q.id, QueueItem.SENT, null, t.status, System.currentTimeMillis())
    }

    /** 사진 업로드(한 번 올린 사진은 첨부 id를 저장해 다시 올리지 않는다) */
    private suspend fun uploadPhotos(q: QueueItem, ownerType: String): List<String> {
        val photos = parsePhotos(q.photos)
        if (photos.isEmpty()) return emptyList()
        val done = photos.map { p ->
            if (p.attachmentId != null) p else {
                val f = File(p.path)
                if (!f.exists()) return@map p
                val bytes = f.readBytes()
                val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                val ps = api.presign(PresignRequest(ownerType, f.name, "image/jpeg", bytes.size.toLong(), sha))
                api.upload(ps, f, "image/jpeg")
                p.copy(attachmentId = ps.attachmentId)
            }
        }
        dao.setPhotos(q.id, photosJson(done))
        return done.mapNotNull { it.attachmentId }
    }

    private fun deletePhotos(q: QueueItem) = parsePhotos(q.photos).forEach { File(it.path).delete() }

    fun photosJson(p: List<Photo>) = json.encodeToString(ListSerializer(Photo.serializer()), p)
    fun parsePhotos(s: String): List<Photo> = runCatching { json.decodeFromString(ListSerializer(Photo.serializer()), s) }.getOrDefault(emptyList())

    /** 로그아웃 전에 보내기를 시도하고, 보낸 업무 데이터는 지운다. 미전송 건은 암호화된 채 남는다(그 사용자가 다시 로그인할 때 전송) */
    suspend fun signOut(): Int {
        runCatching { flush() }
        val uid = auth.userId
        val left = uid?.let { dao.pendingNow(it) } ?: 0
        if (uid != null) dao.clearUser(uid)
        auth.signOut()
        return left
    }

    fun photoDir(): File = File(ctx.cacheDir, "photos").apply { mkdirs() }
}
