package com.bsg.alm.pda

import android.app.Application
import androidx.work.Configuration
import androidx.work.WorkManager
import com.bsg.alm.pda.auth.AuthManager
import com.bsg.alm.pda.core.Settings
import com.bsg.alm.pda.data.AlmDb
import com.bsg.alm.pda.data.Repository
import com.bsg.alm.pda.net.Api
import com.bsg.alm.pda.scan.Scanner
import com.bsg.alm.pda.sync.SyncWorker

/** 앱 전역 객체(간단한 수동 DI) */
class AlmApp : Application() {
    lateinit var settings: Settings; private set
    lateinit var auth: AuthManager; private set
    lateinit var repo: Repository; private set
    lateinit var scanner: Scanner; private set

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        auth = AuthManager(this, settings)
        val db = AlmDb.open(this, settings.dbPassphrase())
        repo = Repository(this, settings, auth, Api(settings, auth), db)
        scanner = Scanner(this, settings)
        WorkManager.initialize(this, Configuration.Builder().build())
        SyncWorker.schedule(this)
    }
}
