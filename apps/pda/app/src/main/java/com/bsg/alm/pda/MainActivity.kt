package com.bsg.alm.pda

import android.os.Bundle
import android.os.SystemClock
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.bsg.alm.pda.ui.AlmTheme
import com.bsg.alm.pda.ui.AppViewModel
import com.bsg.alm.pda.ui.BottomNav
import com.bsg.alm.pda.ui.ConfirmScreen
import com.bsg.alm.pda.ui.LockScreen
import com.bsg.alm.pda.ui.LoginScreen
import com.bsg.alm.pda.ui.QueueScreen
import com.bsg.alm.pda.ui.RoomScreen
import com.bsg.alm.pda.ui.ScanScreen
import com.bsg.alm.pda.ui.Screen
import com.bsg.alm.pda.ui.SettingsScreen
import com.bsg.alm.pda.ui.StatusScreen
import com.bsg.alm.pda.ui.TasksScreen
import com.bsg.alm.pda.ui.UnregScreen
import kotlinx.coroutines.launch

/**
 * 단일 액티비티. 화면 전환은 AppViewModel.screen.
 * 앱 잠금(09 6.5): 앱을 다시 열거나 15분 동안 쓰지 않으면 기기 PIN·생체로 다시 확인(공용 기기에서 앞 사용자로 스캔 방지)
 */
class MainActivity : AppCompatActivity() {
    private val vm: AppViewModel by viewModels()
    private val locked = mutableStateOf(false)
    private var lastActive = 0L
    private var stoppedAt = 0L
    private var previous: Screen = Screen.TASKS

    private val login = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        lifecycleScope.launch { vm.afterLogin(vm.repo.auth.handleResult(r.data)) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locked.value = vm.repo.auth.isSignedIn
        setContent {
            AlmTheme {
                val screen by vm.screen.collectAsState()
                val st by vm.status.collectAsState()
                val pending by vm.pendingCount.collectAsState(initial = 0)
                val campaign by vm.campaignId.collectAsState()
                val room by vm.room.collectAsState()
                val msg by vm.message.collectAsState()
                val isLocked by locked
                LaunchedEffect(msg) { msg?.let { Toast.makeText(this@MainActivity, it, Toast.LENGTH_LONG).show(); vm.message.value = null } }
                if (isLocked && screen != Screen.LOGIN) { LockScreen(vm.repo.auth.displayName) { unlock() }; return@AlmTheme }
                BackHandler(enabled = screen != Screen.TASKS && screen != Screen.LOGIN) {
                    vm.go(when (screen) { Screen.SCAN -> Screen.ROOM; Screen.CONFIRM, Screen.UNREG, Screen.STATUS -> Screen.SCAN; Screen.SETTINGS -> previous; else -> Screen.TASKS })
                }
                val showNav = screen in setOf(Screen.TASKS, Screen.ROOM, Screen.SCAN, Screen.QUEUE, Screen.STATUS)
                Scaffold(bottomBar = { if (showNav) BottomNav(screen, pending, campaign != null, room != null) { vm.go(it) } }) { pad ->
                    Column(Modifier.fillMaxSize().padding(pad)) {
                        when (screen) {
                            Screen.LOGIN -> LoginScreen(vm) { email -> startLogin(email) }
                            Screen.TASKS -> { previous = Screen.TASKS; TasksScreen(vm, st.online, pending) }
                            Screen.ROOM -> RoomScreen(vm, st.online, pending)
                            Screen.SCAN -> ScanScreen(vm, st.online, pending)
                            Screen.CONFIRM -> ConfirmScreen(vm, st.online, pending)
                            Screen.UNREG -> UnregScreen(vm, st.online, pending)
                            Screen.STATUS -> StatusScreen(vm, st.online, pending)
                            Screen.QUEUE -> QueueScreen(vm, st.online, pending)
                            Screen.SETTINGS -> SettingsScreen(vm) { vm.go(if (vm.repo.auth.isSignedIn) previous else Screen.LOGIN) }
                        }
                    }
                }
            }
        }
    }

    private fun startLogin(email: String) {
        vm.settings.lastEmail = email
        lifecycleScope.launch {
            vm.busy.value = true
            runCatching { vm.repo.authConfig(email) }
                .onSuccess { cfg -> login.launch(vm.repo.auth.loginIntent(cfg, email)) }
                .onFailure { vm.toast(vm.errorText(it)) }
            vm.busy.value = false
        }
    }

    override fun onResume() {
        super.onResume()
        vm.scanner.start()
        val now = SystemClock.elapsedRealtime()
        val idle = lastActive > 0 && now - lastActive > LOCK_AFTER_MS
        // 다른 앱으로 1분 넘게 나갔다 오면 잠금(사진·카메라 스캔·로그인 창에서 돌아올 때는 잠그지 않음)
        val reopened = stoppedAt > 0 && now - stoppedAt > REOPEN_LOCK_MS
        stoppedAt = 0
        if (vm.repo.auth.isSignedIn && (idle || reopened)) locked.value = true
        if (vm.repo.auth.isSignedIn && !locked.value) vm.sync(quiet = true)
    }

    override fun onPause() {
        super.onPause()
        vm.scanner.stop()
        lastActive = SystemClock.elapsedRealtime()
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) stoppedAt = SystemClock.elapsedRealtime()
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        val now = SystemClock.elapsedRealtime()
        if (lastActive > 0 && now - lastActive > LOCK_AFTER_MS && vm.repo.auth.isSignedIn) locked.value = true
        lastActive = now
    }

    private fun unlock() {
        val bm = BiometricManager.from(this)
        val allowed = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        if (bm.canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
            // 화면 잠금이 없는 기기: 잠금 없이 통과하되 알린다(운영 기기는 MDM으로 화면 잠금 필수)
            vm.toast("This device has no screen lock. Ask IT to set a PIN.")
            locked.value = false; lastActive = SystemClock.elapsedRealtime(); vm.sync(quiet = true); return
        }
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                locked.value = false; lastActive = SystemClock.elapsedRealtime(); vm.sync(quiet = true)
            }
        }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Unlock ALM Count")
            .setSubtitle(vm.repo.auth.displayName ?: "").setAllowedAuthenticators(allowed).build())
    }

    companion object { const val LOCK_AFTER_MS = 15 * 60 * 1000L; const val REOPEN_LOCK_MS = 60 * 1000L }
}
