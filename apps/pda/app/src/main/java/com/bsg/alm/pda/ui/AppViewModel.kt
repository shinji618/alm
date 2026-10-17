package com.bsg.alm.pda.ui

import android.app.Application
import android.media.AudioManager
import android.media.ToneGenerator
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.bsg.alm.pda.AlmApp
import com.bsg.alm.pda.data.Judge
import com.bsg.alm.pda.data.Photo
import com.bsg.alm.pda.data.RoomEntity
import com.bsg.alm.pda.data.ScanOutcome
import com.bsg.alm.pda.data.TaskEntity
import com.bsg.alm.pda.data.WorkItem
import com.bsg.alm.pda.net.ApiException
import com.bsg.alm.pda.scan.ScanEvent
import com.bsg.alm.pda.sync.SyncWorker
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/** 화면(01 기능정의서 PDA-01~08) */
enum class Screen(val id: String) {
    LOGIN("PDA-01"), TASKS("PDA-02"), ROOM("PDA-03"), SCAN("PDA-04"), CONFIRM("PDA-05"), UNREG("PDA-06"), STATUS("PDA-07"), QUEUE("PDA-08"), SETTINGS("SET")
}

/** 스캔 결과 카드 */
data class LastResult(val kind: String, val title: String, val message: String, val tag: String? = null, val good: Boolean = true)

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val a = app as AlmApp
    val repo = a.repo
    val settings = a.settings
    val scanner = a.scanner

    val screen = MutableStateFlow(if (repo.auth.isSignedIn && repo.auth.userId != null) Screen.TASKS else Screen.LOGIN)
    val campaignId = MutableStateFlow<String?>(null)
    val room = MutableStateFlow<RoomEntity?>(null)
    val last = MutableStateFlow<LastResult?>(null)
    val confirmItem = MutableStateFlow<WorkItem?>(null)
    val busy = MutableStateFlow(false)
    val message = MutableStateFlow<String?>(null)
    /** 확인 화면 없이 연속 스캔(끄면 스캔할 때마다 확인 화면) */
    val continuous = MutableStateFlow(settings.continuousScan)
    val status = repo.status
    private val beep = runCatching { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80) }.getOrNull()

    private val uid get() = repo.auth.userId ?: ""
    val tasks: Flow<List<TaskEntity>> get() = repo.dao.tasks(uid)
    val pendingCount: Flow<Int> get() = repo.dao.pendingCount(uid)
    val queue get() = repo.dao.queue(uid)
    fun rooms(): Flow<List<RoomEntity>> = campaignId.flatMapLatest { c -> if (c == null) flowOf(emptyList()) else repo.dao.rooms(c) }
    fun myTasks(): Flow<List<TaskEntity>> = campaignId.flatMapLatest { c -> if (c == null) flowOf(emptyList()) else repo.dao.tasksOf(uid, c) }
    fun roomItems(): Flow<List<WorkItem>> = room.flatMapLatest { r -> if (r == null) emptyFlow() else repo.dao.itemsInRoom(uid, r.campaignId, r.roomId) }
    fun recent() = room.flatMapLatest { r -> if (r == null) flowOf(emptyList()) else repo.dao.recentScans(uid, r.campaignId, r.roomId) }

    init {
        viewModelScope.launch { scanner.events.collect { onScan(it) } }
    }

    fun go(s: Screen) { screen.value = s }
    fun toast(m: String) { message.value = m }

    // ---------------- 로그인·동기화 ----------------
    fun afterLogin(result: Result<Unit>) = viewModelScope.launch {
        busy.value = true
        val r = result.mapCatching { repo.afterLogin() }
        busy.value = false
        r.onSuccess { go(Screen.TASKS) }.onFailure { toast(errorText(it)) }
    }

    fun sync(full: Boolean = false, quiet: Boolean = false) = viewModelScope.launch {
        if (repo.status.value.running) return@launch
        val r = repo.sync(full)
        r.onFailure { e ->
            if (e is com.bsg.alm.pda.auth.AuthManager.NotSignedIn) { toast("Session expired. Sign in again."); go(Screen.LOGIN) }
            else if (!quiet || !(e is ApiException && e.offline)) toast(errorText(e))
        }
        if (!quiet) r.onSuccess { toast("Work lists updated") }
    }

    fun signOut() = viewModelScope.launch {
        val left = repo.signOut()
        campaignId.value = null; room.value = null; last.value = null
        if (left > 0) toast("$left item(s) not sent yet. They stay encrypted on this device until you sign in again.")
        go(Screen.LOGIN)
    }

    // ---------------- 작업·룸 ----------------
    fun openCampaign(id: String) { campaignId.value = id; room.value = null; last.value = null; go(Screen.ROOM) }

    fun selectRoom(r: RoomEntity) = viewModelScope.launch {
        room.value = r
        last.value = LastResult("ROOM", "Room set", "Now counting in ${r.roomCode} · ${r.name}")
        val t = repo.dao.taskForRoom(uid, r.campaignId, r.roomId)
        if (t != null && t.status == "NOT_STARTED") repo.updateTask(t, "START", false)
        go(Screen.SCAN)
    }

    private suspend fun currentTask(): TaskEntity? {
        val r = room.value ?: return null
        // 다른 담당 룸에서 스캔해도 기록은 남긴다: 작업은 내 룸 작업 중 하나(같은 캠페인)로 보낸다
        return repo.dao.taskForRoom(uid, r.campaignId, r.roomId) ?: repo.dao.tasksOfNow(uid, r.campaignId).firstOrNull()
    }

    // ---------------- 스캔 ----------------
    fun manual(code: String) { if (code.isNotBlank()) scanner.emit(ScanEvent(code.trim(), "MANUAL")) }

    private fun onScan(e: ScanEvent) = viewModelScope.launch {
        if (screen.value == Screen.LOGIN || screen.value == Screen.SETTINGS) return@launch
        if (screen.value == Screen.UNREG) { unregBarcode.value = e.code; return@launch }
        val c = campaignId.value ?: run { toast("Open a count task first"); tone(false); return@launch }
        val out = runCatching { repo.scan(c, currentTask(), room.value?.roomId, e.code, e.method) }.getOrElse { toast(errorText(it)); return@launch }
        show(out)
        SyncWorker.kick(getApplication())
    }

    private fun show(o: ScanOutcome) {
        val it = o.item
        val r = when (o.result) {
            "ROOM" -> { room.value = o.roomChanged; viewModelScope.launch { o.roomChanged?.let { selectRoom(it) } }; return }
            "NO_ROOM" -> LastResult("NO_ROOM", "Select a room first", "Scan the room label at the door or pick it from the list.", good = false)
            Judge.FOUND -> LastResult(o.result, "Found", "${it?.assetTag} · ${it?.description}${it?.assignedUserName?.let { u -> " · $u" } ?: ""}", it?.assetTag)
            Judge.MISPLACED -> LastResult(o.result, "Found in a different room", "Register says ${it?.expectedRoomCode}. Counted here in ${room.value?.roomCode}.", it?.assetTag, good = false)
            Judge.DUPLICATE -> LastResult(o.result, "Already counted", "${it?.assetTag} was already counted here. Time updated.", it?.assetTag)
            Judge.OUT_OF_SCOPE -> LastResult(o.result, "Out of scope", "${o.tag} is not part of this count. Recorded for review.", o.tag, good = false)
            Judge.RETIRED_ASSET -> LastResult(o.result, "Retired asset found", "${o.tag} is retired. Take a photo and set it aside.", o.tag, good = false)
            else -> LastResult(Judge.UNREGISTERED, "Not on this device's lists", "${o.tag} — the server will check it. If the item has no ALM label, register it with a photo.", o.tag, good = false)
        }
        last.value = r
        tone(r.good)
        if (!continuous.value && it != null && Judge.countsItem(o.result)) { confirmItem.value = it; go(Screen.CONFIRM) }
    }

    private fun tone(ok: Boolean) {
        runCatching { beep?.startTone(if (ok) ToneGenerator.TONE_PROP_ACK else ToneGenerator.TONE_PROP_NACK, if (ok) 120 else 300) }
    }

    fun openConfirm(tag: String) = viewModelScope.launch {
        val c = campaignId.value ?: return@launch
        repo.dao.itemByTag(uid, c, tag)?.let { confirmItem.value = it; go(Screen.CONFIRM) }
    }

    fun saveConfirm(item: WorkItem, condition: String?, relabel: Boolean, note: String?, photos: List<Photo>) = viewModelScope.launch {
        val c = campaignId.value ?: return@launch
        val r = room.value ?: return@launch
        val t = currentTask() ?: return@launch
        repo.confirm(c, t, r.roomId, item, condition, relabel, note, photos)
        SyncWorker.kick(getApplication())
        toast("Saved ${item.assetTag}")
        go(Screen.SCAN)
    }

    // ---------------- 미등록 ----------------
    val unregBarcode = MutableStateFlow("")
    fun openUnreg(barcode: String? = null) { unregBarcode.value = barcode ?: ""; go(Screen.UNREG) }
    fun saveUnreg(categoryId: String?, description: String, serial: String?, barcode: String?, photos: List<Photo>) = viewModelScope.launch {
        val c = campaignId.value ?: return@launch
        val r = room.value ?: return@launch
        val no = runCatching { repo.reportUnregistered(c, r.roomId, categoryId, description, serial, barcode, photos) }.getOrElse { toast(errorText(it)); return@launch }
        SyncWorker.kick(getApplication())
        last.value = LastResult("UNREG", "Registered as $no", "$description · photo saved. The server will assign the UNREG number.")
        go(Screen.SCAN)
    }

    // ---------------- 룸 완료 ----------------
    fun completeRoom(task: TaskEntity, force: Boolean) = viewModelScope.launch {
        busy.value = true
        val r = repo.updateTask(task, "COMPLETE", force)
        busy.value = false
        val e = r.exceptionOrNull()
        when {
            e == null -> toast("${task.roomCode} completed")
            e is ApiException && e.offline -> toast("${task.roomCode} marked complete. It will be sent when online.")
            else -> toast(errorText(e))
        }
    }

    fun retry(id: Long) = viewModelScope.launch { repo.dao.retry(id); SyncWorker.kick(getApplication()) }
    fun sendNow() = viewModelScope.launch { runCatching { repo.flush() }.onFailure { toast(errorText(it)) }.onSuccess { toast("Sent") } }

    suspend fun categories() = repo.dao.codes("category")
    suspend fun conditions() = repo.dao.codes("condition")

    fun errorText(e: Throwable?): String = when (e) {
        null -> ""
        is ApiException -> if (e.offline) "No connection. Saved on this device and will be sent later." else "${e.message}${e.code?.let { " ($it)" } ?: ""}"
        is com.bsg.alm.pda.auth.AuthManager.NotSignedIn -> "Session expired. Sign in again."
        else -> e.message ?: e.toString()
    }

    override fun onCleared() { beep?.release() }
}
