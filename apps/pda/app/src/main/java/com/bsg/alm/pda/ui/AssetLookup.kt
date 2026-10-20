package com.bsg.alm.pda.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import kotlinx.coroutines.delay
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bsg.alm.pda.core.ScanMode
import com.bsg.alm.pda.data.WorkItem
import com.bsg.alm.pda.net.PdaAssetDetail
import com.bsg.alm.pda.scan.ScanEvent
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.text.NumberFormat
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * PDA-09 자산 조회(2026-10-19). 자산태그를 찍으면(측면 스캔 키·카메라·직접 입력) 서버에서 상세를 받아 보여 준다. 실사 기록은 남기지 않는다.
 * 범위 밖 자산은 태그·상태·사이트만(limited). 오프라인이면 이 기기에 내려받은 작업목록 사본으로 보여 준다.
 */
@Composable
fun AssetLookupScreen(vm: AppViewModel, online: Boolean, pending: Int) {
    val state by vm.lookup.collectAsState()
    val room by vm.room.collectAsState()
    var input by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val camera = rememberLauncherForActivityResult(ScanContract()) { r -> r.contents?.let { vm.scanner.emit(ScanEvent(it, "CAMERA")) } }
    // 키보드 입력형 스캐너를 위해 칸에 포커스는 두되, 화면 키보드는 숨긴다(상세를 가리지 않게). 칸을 누르면 다시 나온다
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() }; delay(150); keyboard?.hide() }
    LaunchedEffect(state) { if (state !is Lookup.Idle) keyboard?.hide() }
    Column(Modifier.fillMaxSize()) {
        Header("PDA-09", "Asset lookup", null, online, pending, onBack = { vm.go(vm.lookupBack) })
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Text("Scan any asset label to see its details. Nothing is recorded as counted.", color = Muted, fontSize = 13.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                // 키보드 입력형 스캐너도 이 칸으로 들어온다: Enter = 조회
                OutlinedTextField(input, { v ->
                    if (v.endsWith("\n")) { vm.lookup(v.trim()); input = "" } else input = v
                }, label = { Text("Asset tag") }, singleLine = true, modifier = Modifier.weight(1f).focusRequester(focus),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = {
                        if (input.isNotBlank()) vm.scanner.emit(ScanEvent(input.trim(), if (vm.settings.scanMode == ScanMode.KEYBOARD) "TRIGGER" else "MANUAL"))
                        input = ""
                        keyboard?.hide()
                    }))
                Spacer(Modifier.size(8.dp))
                IconButton(onClick = { camera.launch(ScanOptions().setBeepEnabled(true).setOrientationLocked(true).setPrompt("Scan asset tag")) }) {
                    Icon(Icons.Default.PhotoCamera, "Camera scan")
                }
            }
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
            when (val s = state) {
                Lookup.Idle -> Notice("Ready", "Press the side scan key, use the camera, or type a tag.", Muted)
                is Lookup.Loading -> Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text("  Looking up ${s.tag}…")
                }
                is Lookup.NotFound -> Notice("Not an ALM asset", "${s.tag} is not registered in ALM. If it is a room label, open a count task and scan it there.", Bad)
                is Lookup.Failed -> Notice("Could not look up ${s.tag}", s.message, Bad)
                is Lookup.Local -> LocalDetail(s.item)
                // 실사 중 스캔 화면에서 온 경우에만 실사 확인(PDA-05)으로 이어 준다
                is Lookup.Found -> AssetDetail(s.asset, onCount = if (vm.lookupBack == Screen.SCAN && room != null) { t -> vm.openConfirm(t) } else null,
                    onOpen = { t -> vm.lookup(t) })
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun Notice(title: String, body: String, color: Color) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).background(color.copy(alpha = 0.10f), RoundedCornerShape(10.dp)).padding(14.dp)) {
        Text(title, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = color)
        Text(body)
    }
}

@Composable
private fun AssetDetail(a: PdaAssetDetail, onCount: ((String) -> Unit)?, onOpen: (String) -> Unit = {}) {
    Spacer(Modifier.height(4.dp))
    Text(a.assetTag, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 22.sp)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Pill(statusLabel(a.status), statusColor(a.status))
        a.stage?.let { Spacer(Modifier.width(6.dp)); Pill(stageLabel(it), Muted) }
    }
    if (a.limited) {
        Notice("Limited details", "This asset is outside your count tasks and your access. Site ${a.siteCode ?: "—"}. Ask the asset manager for more.", Warn)
        return
    }
    a.description?.let { Text(it, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp)) }
    Text(listOfNotNull(a.categoryName, a.model).joinToString(" · "), color = Muted)

    // Bundle: 구성품은 소속 Bundle로, Bundle은 구성품으로 이동할 수 있다
    a.bundle?.let { b ->
        Notice("Bundle component", bundleNote(b.assetTag, b.sapAssetNo), Blue)
        TextButton(onClick = { onOpen(b.assetTag) }) { Text("Open bundle ${b.assetTag}") }
    }
    if (a.isBundle) {
        Notice("Bundle asset", "SAP sees this bundle as one asset. Count its components one by one — the bundle label itself is not counted.", Blue)
        Section("Components (${a.componentCount ?: a.components.size})")
        if (a.components.isEmpty()) Text("No components.", color = Muted)
        a.components.forEach { c ->
            Row(Modifier.fillMaxWidth().clickable { onOpen(c.assetTag) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.assetTag, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
                    Text(listOfNotNull(c.description, c.roomCode).joinToString(" · "), color = Muted, fontSize = 12.sp)
                }
                Pill(statusLabel(c.status), statusColor(c.status))
            }
            HorizontalDivider()
        }
        if ((a.componentCount ?: 0) > a.components.size) Text("Showing the first ${a.components.size}.", color = Muted, fontSize = 12.sp)
    }

    a.count?.let { c ->
        Section("Current count")
        Field("Campaign", c.campaignCode)
        Field("Registered room", c.expectedRoomCode)
        Field("Result", resultLabel(c.result), resultColor(c.result))
        c.countedAt?.let { Field("Counted", dateTime(it)) }
        if (onCount != null && c.result == "PENDING") TextButton(onClick = { onCount(a.assetTag) }) { Text("Open in count (condition & photo)") }
    }

    Section("Identification")
    Field("Serial number", a.serialNo)
    Field("Hostname", a.hostname)
    Field("SAP asset", a.sapAssetNo?.let { listOfNotNull(a.companyCode, it).joinToString(" / ") })

    Section("Location & user")
    Field("Site", listOfNotNull(a.siteCode, a.siteName).joinToString(" · ").ifBlank { null })
    Field("Room", listOfNotNull(a.roomCode, a.roomName).joinToString(" · ").ifBlank { null })
    Field("Cost center", listOfNotNull(a.costCenterCode, a.costCenterName).joinToString(" · ").ifBlank { null })
    Field("User", a.assignedUserName)

    Section("Dates & value")
    Field("Capitalized", a.capitalizedOn)
    Field("Purchased", a.purchaseDate)
    Field("Warranty ends", a.warrantyEndDate)
    a.acquisitionValue?.let { Field("Acquisition value", money(it)) }
    a.netBookValue?.let { Field("Net book value", money(it)) }
    Field("Last counted", a.lastCountedAt?.let { "${dateTime(it)}${a.lastCountedRoomCode?.let { r -> " · $r" } ?: ""}${a.lastCountCampaign?.let { c -> " · $c" } ?: ""}" } ?: "Never")

    if (a.events.isNotEmpty()) {
        Section("Recent history")
        a.events.forEach { e ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(eventLabel(e.eventType), fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                Text("${dateTime(e.occurredAt)}${e.actorName?.let { " · $it" } ?: ""}", color = Muted, fontSize = 12.sp)
            }
            HorizontalDivider()
        }
    }
}

@Composable
private fun LocalDetail(w: WorkItem) {
    Notice("Offline — device copy", "Showing what this device downloaded for the count. Connect to see full details.", Warn)
    Text(w.assetTag, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 22.sp)
    Pill(statusLabel(w.assetStatus), statusColor(w.assetStatus))
    Text(w.description, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp))
    Text(listOfNotNull(w.categoryName, w.model).joinToString(" · "), color = Muted)
    Section("Count")
    Field("Registered room", w.expectedRoomCode)
    Field("Result", resultLabel(w.localResult ?: w.result), resultColor(w.localResult ?: w.result))
    Field("Serial number", w.serialNo)
    Field("User", w.assignedUserName)
}

@Composable
private fun Section(title: String) {
    Text(title, fontWeight = FontWeight.Bold, color = Blue, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp))
    HorizontalDivider()
}

@Composable
private fun Field(label: String, value: String?, color: Color = Color.Unspecified) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Muted, modifier = Modifier.weight(0.42f))
        Text(value ?: "—", color = color, fontWeight = FontWeight.Medium, modifier = Modifier.weight(0.58f))
    }
}

private val dtFmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.US)
private fun dateTime(s: String): String = runCatching { OffsetDateTime.parse(s).atZoneSameInstant(java.time.ZoneId.systemDefault()).format(dtFmt) }.getOrDefault(s)
private fun money(v: Double): String = NumberFormat.getCurrencyInstance(Locale.US).format(v)

fun bundleNote(tag: String, sapNo: String?) =
    "Part of bundle $tag. Managed in ALM only — SAP sees the bundle${sapNo?.let { " ($it)" } ?: ""} as one asset."

fun statusLabel(s: String) = when (s) {
    "ON_ORDER" -> "On order"; "IN_STOCK" -> "In stock"; "IN_USE" -> "In use"; "IN_REPAIR" -> "In repair"; "MISSING" -> "Missing"
    "RETIRED" -> "Retired"; "DISPOSED" -> "Disposed"; else -> s
}
fun statusColor(s: String): Color = when (s) { "IN_USE" -> Ok; "IN_STOCK", "ON_ORDER" -> Color(0xFF1D4ED8); "IN_REPAIR" -> Warn; "MISSING", "RETIRED", "DISPOSED" -> Bad; else -> Muted }
fun stageLabel(s: String) = s.lowercase().replaceFirstChar { it.uppercase() }
fun eventLabel(e: String) = when (e) {
    "CREATED" -> "Registered"; "UPDATED" -> "Updated"; "STATUS_CHANGED" -> "Status changed"; "ASSIGNED" -> "Checked out"; "RETURNED" -> "Checked in"
    "TRANSFERRED" -> "Transferred"; "REPAIR_IN" -> "Sent to repair"; "REPAIR_OUT" -> "Back from repair"; "COUNTED" -> "Counted"; "LABEL_PRINTED" -> "Label printed"
    "SAP_POSTED" -> "Posted to SAP"; "SAP_SYNCED" -> "Synced from SAP"; "RETIRED" -> "Retired"; "DISPOSED" -> "Disposed"; else -> e
}
