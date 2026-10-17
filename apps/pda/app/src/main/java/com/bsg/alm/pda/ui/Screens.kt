package com.bsg.alm.pda.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.bsg.alm.pda.BuildConfig
import com.bsg.alm.pda.core.ScanMode
import com.bsg.alm.pda.data.CodeEntity
import com.bsg.alm.pda.data.Photo
import com.bsg.alm.pda.data.QueueItem
import com.bsg.alm.pda.data.TaskEntity
import com.bsg.alm.pda.data.WorkItem
import com.bsg.alm.pda.scan.ScanEvent
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val hm = SimpleDateFormat("HH:mm", Locale.US)
private val mdhm = SimpleDateFormat("MM/dd HH:mm", Locale.US)

// ---------------- PDA-01 로그인 ----------------
@Composable
fun LoginScreen(vm: AppViewModel, onLogin: (String) -> Unit) {
    var email by remember { mutableStateOf(vm.settings.lastEmail) }
    val busy by vm.busy.collectAsState()
    Column(Modifier.fillMaxSize().background(Navy).padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("BSG AMERICA · PDA-01", color = Color(0xFF94A3B8), fontSize = 12.sp)
        Text("Physical count", color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text("Sign in with your company account. Your count tasks download to this device so you can keep scanning without a signal.",
            color = Color(0xFFCBD5E1), fontSize = 14.sp)
        Spacer(Modifier.height(24.dp))
        Box(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(12.dp)).padding(16.dp)) {
            Column {
                OutlinedTextField(email, { email = it.trim() }, label = { Text("Work email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { if (email.contains('@')) onLogin(email) }))
                Spacer(Modifier.height(12.dp))
                Button(onClick = { onLogin(email) }, enabled = !busy && Regex("^[^@\\s]+@[^@\\s]+\\.[a-zA-Z]{2,}$").matches(email), modifier = Modifier.fillMaxWidth()) {
                    if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp) else Text("Sign in")
                }
                TextButton(onClick = { vm.go(Screen.SETTINGS) }) { Text("Device settings") }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text("Device ${vm.settings.deviceSerial} · v${BuildConfig.VERSION_NAME}", color = Color(0xFF64748B), fontSize = 12.sp)
    }
}

// ---------------- PDA-02 내 작업 ----------------
@Composable
fun TasksScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val tasks by vm.tasks.collectAsState(initial = emptyList())
    val st by vm.status.collectAsState()
    val campaigns = tasks.groupBy { it.campaignId }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-02", "My count tasks", vm.repo.auth.displayName, online, pending) {
            IconButton(onClick = { vm.sync() }) { Icon(Icons.Default.Refresh, "Sync", tint = Color.White) }
            IconButton(onClick = { vm.go(Screen.SETTINGS) }) { Icon(Icons.Default.Settings, "Settings", tint = Color.White) }
            IconButton(onClick = { vm.signOut() }) { Icon(Icons.AutoMirrored.Filled.Logout, "Sign out", tint = Color.White) }
        }
        if (st.running) Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text("  Downloading work lists…")
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            if (campaigns.isEmpty() && !st.running) item {
                Text("No count tasks assigned to you. Pull to refresh with the ⟳ button, or ask your asset manager to assign a room.",
                    color = Muted, modifier = Modifier.padding(vertical = 24.dp))
            }
            items(campaigns.entries.toList(), key = { it.key }) { (cid, ts) ->
                val t = ts.first()
                val total = ts.sumOf { it.expectedCount }
                val done = ts.sumOf { it.expectedCount - it.pendingCount }
                Card(onClick = { vm.openCampaign(cid) }) {
                    Row { Text(t.campaignCode, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f)); Text("due ${t.dueDate.drop(5)}", color = Muted, fontSize = 13.sp) }
                    Text(t.campaignName, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                    Text("${t.siteCode} · ${ts.size} room(s) · key date ${t.keyDate.drop(5)}", color = Muted, fontSize = 13.sp)
                    Spacer(Modifier.height(6.dp)); Progress(done, total)
                }
            }
            item {
                Text("Last sync ${st.lastSyncAt?.let { mdhm.format(Date(it)) } ?: "—"}${st.error?.let { " · $it" } ?: ""}",
                    color = if (st.error != null) Warn else Muted, fontSize = 12.sp, modifier = Modifier.padding(vertical = 12.dp))
            }
        }
    }
}

// ---------------- PDA-03 룸 선택 ----------------
@Composable
fun RoomScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val tasks by vm.myTasks().collectAsState(initial = emptyList())
    val rooms by vm.rooms().collectAsState(initial = emptyList())
    val my = tasks.associateBy { it.roomId }
    var showAll by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-03", "Select room", tasks.firstOrNull()?.campaignCode, online, pending, onBack = { vm.go(Screen.TASKS) })
        Column(Modifier.padding(12.dp)) {
            Text("Scan the room label at the door, or pick a room.", color = Muted)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = !showAll, onClick = { showAll = false }, label = { Text("My rooms (${tasks.size})") })
                Spacer(Modifier.size(8.dp))
                FilterChip(selected = showAll, onClick = { showAll = true }, label = { Text("All rooms on site") })
            }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            val list = if (showAll) rooms else rooms.filter { my.containsKey(it.roomId) }
            items(list, key = { it.roomId }) { r ->
                val t = my[r.roomId]
                Card(onClick = { vm.selectRoom(r) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(r.roomCode, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                            Text("${r.name}${r.floor?.let { " · $it" } ?: ""}", color = Muted, fontSize = 13.sp)
                        }
                        if (t != null) Column(horizontalAlignment = Alignment.End) {
                            Pill(taskLabel(t.status), if (t.status == "COMPLETED") Ok else if (t.status == "IN_PROGRESS") Blue else Muted)
                            Text("${t.expectedCount - t.pendingCount}/${t.expectedCount}", fontSize = 13.sp, color = Muted)
                        } else Text("not assigned", fontSize = 12.sp, color = Muted)
                    }
                }
            }
        }
    }
}

fun taskLabel(s: String) = when (s) { "NOT_STARTED" -> "Not started"; "IN_PROGRESS" -> "In progress"; "COMPLETED" -> "Completed"; else -> s }

// ---------------- PDA-04 스캔 ----------------
@Composable
fun ScanScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val room by vm.room.collectAsState()
    val last by vm.last.collectAsState()
    val items by vm.roomItems().collectAsState(initial = emptyList())
    val recent by vm.recent().collectAsState(initial = emptyList())
    val continuous by vm.continuous.collectAsState()
    var input by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val camera = rememberLauncherForActivityResult(ScanContract()) { r -> r.contents?.let { vm.scanner.emit(ScanEvent(it, "CAMERA")) } }
    val r = room ?: return
    val counted = items.count { it.localResult != null || it.result != "PENDING" }
    LaunchedEffect(r.roomId) { runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-04", r.roomCode, r.name, online, pending, onBack = { vm.go(Screen.ROOM) }) {
            TextButton(onClick = { vm.go(Screen.STATUS) }) { Text("Status", color = Color.White) }
        }
        Column(Modifier.padding(12.dp).weight(1f)) {
            Progress(counted, items.size)
            Spacer(Modifier.height(8.dp))
            val l = last
            Box(Modifier.fillMaxWidth().background(resultColor(l?.kind).copy(alpha = 0.12f), RoundedCornerShape(10.dp))
                .clickable(enabled = l?.tag != null) { l?.tag?.let { vm.openConfirm(it) } }.padding(14.dp)) {
                if (l == null) Column {
                    Text("Ready", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text("Press the side scan key, or type a tag below.", color = Muted)
                } else Column {
                    Text(l.title, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = resultColor(l.kind))
                    Text(l.message)
                    if (l.tag != null && l.kind != "UNREGISTERED" && l.kind != "RETIRED_ASSET" && l.kind != "OUT_OF_SCOPE")
                        Text("Tap for condition & photo", color = Blue, fontSize = 13.sp)
                    if (l.kind == "UNREGISTERED") TextButton(onClick = { vm.openUnreg(l.tag) }) { Text("Register with photo") }
                }
            }
            Spacer(Modifier.height(8.dp))
            // 키보드 입력형 스캐너(Scan Tool '키보드 출력')도 이 칸으로 들어온다: Enter = 스캔
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(input, { v ->
                    if (v.endsWith("\n")) { vm.scanner.emit(ScanEvent(v.trim(), if (vm.settings.scanMode == ScanMode.KEYBOARD) "TRIGGER" else "MANUAL")); input = "" } else input = v
                }, label = { Text("Tag or room label") }, singleLine = true, modifier = Modifier.weight(1f).focusRequester(focus),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        if (input.isNotBlank()) vm.scanner.emit(ScanEvent(input.trim(), if (vm.settings.scanMode == ScanMode.KEYBOARD) "TRIGGER" else "MANUAL"))
                        input = ""
                    }))
                Spacer(Modifier.size(8.dp))
                IconButton(onClick = { camera.launch(ScanOptions().setBeepEnabled(true).setOrientationLocked(true).setPrompt("Scan asset tag")) }) {
                    Icon(Icons.Default.PhotoCamera, "Camera scan")
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Continuous scanning", fontWeight = FontWeight.Medium)
                    Text("Off = open each asset after scan", fontSize = 12.sp, color = Muted)
                }
                Switch(continuous, { vm.continuous.value = it; vm.settings.continuousScan = it })
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Recent scans", fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = { vm.openUnreg() }) { Text("+ No label") }
            }
            LazyColumn(Modifier.weight(1f)) {
                if (recent.isEmpty()) item { Text("No scans in this room yet.", color = Muted, modifier = Modifier.padding(8.dp)) }
                items(recent, key = { it.id }) { q -> QueueRow(q, onClick = { vm.openConfirm(q.label) }, onDelete = { vm.discard(q.id) }) }
            }
        }
    }
}

@Composable
fun QueueRow(q: QueueItem, onClick: (() -> Unit)? = null, onRetry: (() -> Unit)? = null, onDelete: (() -> Unit)? = null) {
    val result = q.serverResult ?: q.localResult
    Row(Modifier.fillMaxWidth().let { if (onClick != null) it.clickable(onClick = onClick) else it }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(q.label, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
            val sub = listOfNotNull(q.detail.takeIf { it.isNotBlank() }, if (q.type == "SCAN") resultLabel(result) else if (q.type == "UNREG") "Unregistered${q.serverResult?.let { " → $it" } ?: ""}" else null)
            if (sub.isNotEmpty()) Text(sub.joinToString(" · "), fontSize = 12.sp, color = Muted, maxLines = 1)
            if (q.error != null && q.state != QueueItem.SENT) Text(q.error, fontSize = 12.sp, color = Bad, maxLines = 2)
        }
        Column(horizontalAlignment = Alignment.End) {
            Pill(when (q.state) { QueueItem.SENT -> "Sent"; QueueItem.REJECTED -> "Rejected"; else -> "Waiting" },
                when (q.state) { QueueItem.SENT -> Ok; QueueItem.REJECTED -> Bad; else -> Warn })
            Text(hm.format(Date(q.createdAt)), fontSize = 12.sp, color = Muted)
            if (onRetry != null && q.state == QueueItem.REJECTED) TextButton(onClick = onRetry) { Text("Retry") }
            if (onDelete != null && q.state != QueueItem.SENT) TextButton(onClick = onDelete) { Text("Remove", color = Bad) }
        }
    }
    HorizontalDivider()
}

// ---------------- 사진(PDA-05·06 공통) ----------------
@Composable
fun PhotoStrip(vm: AppViewModel, photos: MutableList<Photo>, max: Int = 5) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var pendingRaw by remember { mutableStateOf<File?>(null) }
    val take = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val raw = pendingRaw ?: return@rememberLauncherForActivityResult
        pendingRaw = null
        if (ok) scope.launch {
            runCatching { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { Photos.shrink(raw, vm.repo.photoDir()) } }
                .onSuccess { photos.add(Photo(it.path)) }.onFailure { vm.toast(it.message ?: "Photo failed") }
        } else raw.delete()
    }
    val perm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (!granted) vm.toast("Camera permission is needed for photos") }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        photos.forEach { p ->
            val bmp = remember(p.path) { runCatching { BitmapFactory.decodeFile(p.path, BitmapFactory.Options().apply { inSampleSize = 8 }) }.getOrNull() }
            Box(Modifier.size(64.dp).clickable { photos.remove(p); File(p.path).delete() }) {
                if (bmp != null) Image(bmp.asImageBitmap(), "Photo (tap to remove)", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            }
        }
        if (photos.size < max) OutlinedButton(onClick = {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { perm.launch(Manifest.permission.CAMERA); return@OutlinedButton }
            val (uri, f) = Photos.newCaptureUri(ctx, vm.repo.photoDir()); pendingRaw = f; take.launch(uri)
        }) { Icon(Icons.Default.PhotoCamera, null); Text(" Photo") }
    }
}

// ---------------- PDA-05 자산 확인 ----------------
@Composable
fun ConfirmScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val item = vm.confirmItem.collectAsState().value ?: return
    var conds by remember { mutableStateOf<List<CodeEntity>>(emptyList()) }
    LaunchedEffect(Unit) { conds = vm.conditions().ifEmpty { listOf(CodeEntity("condition", "GOOD", "Good"), CodeEntity("condition", "DAMAGED", "Damaged"), CodeEntity("condition", "UNUSED", "Unused")) } }
    var condition by remember { mutableStateOf(item.localCondition ?: "GOOD") }
    var relabel by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    val photos = remember { mutableStateListOf<Photo>() }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-05", item.assetTag, "Confirm asset", online, pending, onBack = { vm.go(Screen.SCAN) })
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState()).weight(1f)) {
            Text(item.description, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Text(listOfNotNull(item.categoryName, item.model, item.serialNo?.let { "S/N $it" }).joinToString(" · "), color = Muted)
            Text("Registered room ${item.expectedRoomCode}${item.assignedUserName?.let { " · user $it" } ?: ""}", color = Muted)
            Spacer(Modifier.height(12.dp))
            Text("Condition", fontWeight = FontWeight.Medium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { conds.forEach { c -> FilterChip(selected = condition == c.id, onClick = { condition = c.id }, label = { Text(c.label) }) } }
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(relabel, { relabel = it }); Text("Label is damaged — print a new one") }
            OutlinedTextField(note, { note = it.take(200) }, label = { Text("Note") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Text("Photos", fontWeight = FontWeight.Medium)
            PhotoStrip(vm, photos)
        }
        Button(onClick = { vm.saveConfirm(item, condition, relabel, note, photos.toList()) }, modifier = Modifier.fillMaxWidth().padding(12.dp)) { Text("Save") }
    }
}

// ---------------- PDA-06 미등록 ----------------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UnregScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val room = vm.room.collectAsState().value
    val scanned by vm.unregBarcode.collectAsState()
    var cats by remember { mutableStateOf<List<CodeEntity>>(emptyList()) }
    LaunchedEffect(Unit) { cats = vm.categories() }
    var category by remember { mutableStateOf<CodeEntity?>(null) }
    var open by remember { mutableStateOf(false) }
    var desc by remember { mutableStateOf("") }
    var serial by remember { mutableStateOf("") }
    val photos = remember { mutableStateListOf<Photo>() }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-06", "Register unknown item", room?.roomCode, online, pending, onBack = { vm.go(Screen.SCAN) })
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState()).weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("For items with no ALM label. A photo is required. The asset manager decides later whether to register it.", color = Muted)
            ExposedDropdownMenuBox(open, { open = it }) {
                OutlinedTextField(category?.label ?: "", {}, readOnly = true, label = { Text("Category") }, modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) })
                ExposedDropdownMenu(open, { open = false }) {
                    cats.forEach { c -> DropdownMenuItem(text = { Text(c.label) }, onClick = { category = c; open = false }) }
                }
            }
            OutlinedTextField(desc, { desc = it.take(100) }, label = { Text("Description *") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(serial, { serial = it.take(40) }, label = { Text("Serial number") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (scanned.isNotBlank()) Text("Scanned value: $scanned", fontFamily = FontFamily.Monospace, color = Muted)
            Text("Photos *", fontWeight = FontWeight.Medium)
            PhotoStrip(vm, photos)
        }
        Button(onClick = { vm.saveUnreg(category?.id, desc, serial, scanned, photos.toList()) }, enabled = desc.isNotBlank() && photos.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().padding(12.dp)) { Text("Save") }
    }
}

// ---------------- PDA-07 룸 현황·완료 ----------------
@Composable
fun StatusScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val room = vm.room.collectAsState().value ?: return
    val items by vm.roomItems().collectAsState(initial = emptyList())
    val tasks by vm.myTasks().collectAsState(initial = emptyList())
    val task: TaskEntity? = tasks.firstOrNull { it.roomId == room.roomId }
    var tab by remember { mutableStateOf("PENDING") }
    var ask by remember { mutableStateOf(false) }
    val left = items.filter { it.localResult == null && it.result == "PENDING" }
    val done = items.filter { it.localResult != null || it.result != "PENDING" }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-07", "Room status", room.roomCode, online, pending, onBack = { vm.go(Screen.SCAN) })
        Column(Modifier.padding(12.dp)) {
            Progress(done.size, items.size)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(tab == "PENDING", { tab = "PENDING" }, label = { Text("Not counted (${left.size})") })
                FilterChip(tab == "DONE", { tab = "DONE" }, label = { Text("Counted (${done.size})") })
            }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            items(if (tab == "PENDING") left else done, key = { it.countItemId }) { w: WorkItem ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(w.assetTag, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
                        Text("${w.description}${w.assignedUserName?.let { " · $it" } ?: ""}", fontSize = 12.sp, color = Muted, maxLines = 1)
                    }
                    Text(resultLabel(w.localResult ?: w.result), color = resultColor(w.localResult ?: w.result), fontSize = 13.sp)
                }
                HorizontalDivider()
            }
        }
        if (task != null) Button(onClick = { if (left.isNotEmpty()) ask = true else vm.completeRoom(task, false) }, enabled = task.status != "COMPLETED",
            modifier = Modifier.fillMaxWidth().padding(12.dp)) { Text(if (task.status == "COMPLETED") "Room completed" else "Complete room") }
    }
    if (ask && task != null) AlertDialog(onDismissRequest = { ask = false },
        title = { Text("${left.size} asset(s) not counted") },
        text = { Text("If you complete the room now, these will be reported as not found when counting ends. You can still scan them later.") },
        confirmButton = { TextButton(onClick = { ask = false; vm.completeRoom(task, true) }) { Text("Complete anyway") } },
        dismissButton = { TextButton(onClick = { ask = false }) { Text("Keep counting") } })
}

// ---------------- PDA-08 전송 대기열 ----------------
@Composable
fun QueueScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val q by vm.queue.collectAsState(initial = emptyList())
    val auto by vm.autoSend.collectAsState()
    var ask by remember { mutableStateOf(false) }
    val unsent = q.count { it.state != QueueItem.SENT }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-08", "Upload queue", null, online, pending) {
            TextButton(onClick = { vm.sendNow() }) { Text("Send now", color = Color.White) }
        }
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Send automatically", fontWeight = FontWeight.Medium)
                    Text(if (auto) "Scans are sent as soon as there is a connection." else "Holding: scans stay on this device until you tap Send now. You can remove them before sending.",
                        fontSize = 12.sp, color = if (auto) Muted else Warn)
                }
                Switch(auto, { vm.setAutoSend(it) })
            }
            OutlinedButton(onClick = { ask = true }, enabled = unsent > 0, modifier = Modifier.fillMaxWidth()) { Text("Clear unsent ($unsent)", color = if (unsent > 0) Bad else Muted) }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            if (q.isEmpty()) item { Text("Nothing to send.", color = Muted) }
            items(q, key = { it.id }) { x -> QueueRow(x, onRetry = { vm.retry(x.id) }, onDelete = { vm.discard(x.id) }) }
        }
    }
    if (ask) AlertDialog(onDismissRequest = { ask = false },
        title = { Text("Clear $unsent unsent item(s)?") },
        text = { Text("Scans, unregistered reports and room updates that have not been sent are deleted from this device, and the assets go back to not counted. Items already sent stay in ALM.") },
        confirmButton = { TextButton(onClick = { ask = false; vm.discardAll() }) { Text("Clear", color = Bad) } },
        dismissButton = { TextButton(onClick = { ask = false }) { Text("Cancel") } })
}

// ---------------- 설정(관리자·스캐너 시험) ----------------
@Composable
fun SettingsScreen(vm: AppViewModel, onBack: () -> Unit) {
    val s = vm.settings
    var mode by remember { mutableStateOf(s.scanMode) }
    var action by remember { mutableStateOf(s.scanAction) }
    var extra by remember { mutableStateOf(s.scanExtra) }
    var api by remember { mutableStateOf(s.apiBase) }
    var serial by remember { mutableStateOf(s.deviceSerial) }
    val raw by vm.scanner.lastRaw.collectAsState()
    var test by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { vm.scanner.events.collect { test = "${it.method}: ${it.code}" } }
    Column(Modifier.fillMaxSize()) {
        Header("SET", "Device settings", null, true, 0, onBack = onBack)
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState()).weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Scanner", fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ScanMode.entries.forEach { m -> FilterChip(mode == m, { mode = m }, label = { Text(m.name.lowercase().replaceFirstChar { it.uppercase() }) }) }
            }
            Text(when (mode) {
                ScanMode.BROADCAST -> "In the scanner app (Scan Tool), set output to Broadcast / Intent and use the action and key below."
                ScanMode.KEYBOARD -> "In the scanner app, set output to Keyboard input with an Enter suffix. Scans go into the tag field on the scan screen."
                ScanMode.CAMERA -> "Use the camera button on the scan screen."
            }, fontSize = 13.sp, color = Muted)
            OutlinedTextField(action, { action = it }, label = { Text("Broadcast action") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(extra, { extra = it }, label = { Text("Data key (extra)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Text("Scanner test — press the scan key:", fontWeight = FontWeight.Medium)
            Text(test.ifBlank { "(no scan yet)" }, fontFamily = FontFamily.Monospace)
            Text("Last broadcast received:\n${raw ?: "(none)"}", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
            HorizontalDivider()
            Text("Server & device", fontWeight = FontWeight.Bold)
            OutlinedTextField(api, { api = it }, label = { Text("API base URL") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(serial, { serial = it }, label = { Text("Device serial (X-Device-Id)") }, singleLine = true, enabled = !s.managedDeviceSerial, modifier = Modifier.fillMaxWidth())
            if (s.managedDeviceSerial) Text("Set by your device management (MDM).", fontSize = 12.sp, color = Muted)
            Text("${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} · app ${BuildConfig.VERSION_NAME}", fontSize = 12.sp, color = Muted)
        }
        Button(onClick = {
            s.scanMode = mode; s.scanAction = action; s.scanExtra = extra; s.apiBase = api
            if (!s.managedDeviceSerial) s.deviceSerial = com.bsg.alm.pda.core.Settings.sanitizeSerial(serial)
            vm.scanner.restart(); vm.toast("Settings saved"); onBack()
        }, modifier = Modifier.fillMaxWidth().padding(12.dp)) { Text("Save") }
    }
}

// ---------------- 앱 잠금(09 6.5) ----------------
@Composable
fun LockScreen(name: String?, onUnlock: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    Column(Modifier.fillMaxSize().background(Navy).padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Locked", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text("Confirm it's you${name?.let { ", $it" } ?: ""}", color = Color(0xFFCBD5E1))
        Spacer(Modifier.height(16.dp))
        Button(onClick = onUnlock) { Text("Unlock") }
    }
}
