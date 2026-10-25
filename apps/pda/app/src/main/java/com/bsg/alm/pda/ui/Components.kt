package com.bsg.alm.pda.ui

import androidx.compose.ui.unit.Density
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.MeetingRoom
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Navy = Color(0xFF0F172A)
val Blue = Color(0xFF0F4C81)
val Ok = Color(0xFF15803D)
val Warn = Color(0xFFB45309)
val Bad = Color(0xFFB91C1C)
val Muted = Color(0xFF64748B)

val AlmColors: ColorScheme = lightColorScheme(primary = Blue, secondary = Navy, error = Bad)

@Composable
fun AlmTheme(content: @Composable () -> Unit) {
    // 한 화면에 1.3배 더 많이 보이도록 화면 배율을 1/1.3으로 줄인다(글자·간격·버튼 모두). 바꾸려면 UI_SCALE만 고친다
    val d = LocalDensity.current
    CompositionLocalProvider(LocalDensity provides Density(d.density * UI_SCALE, d.fontScale)) {
        MaterialTheme(colorScheme = AlmColors, content = content)
    }
}

const val UI_SCALE = 1f / 1.3f

/** 화면 머리: 화면 ID·캠페인 + 제목 + 오프라인·대기 건수 */
@Composable
fun Header(screenId: String, title: String, sub: String? = null, online: Boolean, pending: Int, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Column(Modifier.fillMaxWidth().background(Navy).padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("$screenId${sub?.let { " · $it" } ?: ""}", color = Color(0xFF94A3B8), fontSize = 12.sp, modifier = Modifier.weight(1f))
            if (!online) Pill("Offline", Warn)
            if (pending > 0) { Spacer(Modifier.width(6.dp)); Pill("$pending to send", Blue) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) IconButton(onClick = onBack, modifier = Modifier.size(36.dp)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
            Text(title, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            actions()
        }
    }
}

@Composable
fun Pill(text: String, color: Color) {
    Box(Modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text(text, color = if (color == Blue) Color(0xFF93C5FD) else color, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun Progress(done: Int, total: Int, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LinearProgressIndicator(progress = { if (total == 0) 0f else done.toFloat() / total }, modifier = Modifier.weight(1f))
        Text("$done/$total", fontSize = 13.sp, color = Muted)
    }
}

@Composable
fun Card(onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(vertical = 4.dp).let { if (onClick != null) it.clickable(onClick = onClick) else it },
        shape = RoundedCornerShape(10.dp), tonalElevation = 1.dp, shadowElevation = 1.dp) {
        Column(Modifier.padding(12.dp)) { content() }
    }
}

@Composable
fun BottomNav(current: Screen, pending: Int, hasCampaign: Boolean, hasRoom: Boolean, go: (Screen) -> Unit, lookup: () -> Unit = { go(Screen.LOOKUP) }) {
    NavigationBar {
        NavigationBarItem(selected = current == Screen.TASKS, onClick = { go(Screen.TASKS) }, icon = { Icon(Icons.Default.Checklist, null) }, label = { Text("Tasks") })
        NavigationBarItem(selected = current == Screen.ROOM, enabled = hasCampaign, onClick = { go(Screen.ROOM) }, icon = { Icon(Icons.Default.MeetingRoom, null) }, label = { Text("Rooms") })
        NavigationBarItem(selected = current == Screen.SCAN, enabled = hasRoom, onClick = { go(Screen.SCAN) }, icon = { Icon(Icons.Default.QrCodeScanner, null) }, label = { Text("Scan") })
        NavigationBarItem(selected = current == Screen.LOOKUP, onClick = lookup, icon = { Icon(Icons.Default.Search, null) }, label = { Text("Lookup") })
        NavigationBarItem(selected = current == Screen.QUEUE, onClick = { go(Screen.QUEUE) }, label = { Text("Queue") }, icon = {
            BadgedBox(badge = { if (pending > 0) Badge { Text("$pending") } }) { Icon(Icons.Default.CloudUpload, null) }
        })
    }
}

fun resultColor(r: String?): Color = when (r) {
    "FOUND", "DUPLICATE", "ROOM", "UNREG" -> Ok
    "MISPLACED", "OUT_OF_SCOPE", "NO_ROOM" -> Warn
    "RETIRED_ASSET", "UNREGISTERED", "NOT_FOUND" -> Bad
    else -> Muted
}

fun resultLabel(r: String?): String = when (r) {
    "FOUND" -> "Found"; "MISPLACED" -> "Different room"; "OUT_OF_SCOPE" -> "Out of scope"; "UNREGISTERED" -> "Unregistered"
    "DUPLICATE" -> "Already counted"; "RETIRED_ASSET" -> "Retired"; "PENDING" -> "Not counted"; "NOT_FOUND" -> "Not found"; null -> ""; else -> r
}
