package com.bsg.alm.pda.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.bsg.alm.pda.AlmApp
import com.bsg.alm.pda.net.ApiException
import java.util.concurrent.TimeUnit

/** 대기열 전송(통신이 될 때). 15분마다 + 통신이 돌아오면 바로 */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val repo = (applicationContext as AlmApp).repo
        if (!repo.auth.isSignedIn || repo.auth.userId == null) return Result.success()
        if (!(applicationContext as AlmApp).settings.autoSend) return Result.success()
        return try { repo.flush(); Result.success() } catch (e: ApiException) {
            if (e.offline || e.status >= 500 || e.status == 429) Result.retry() else Result.success()
        } catch (e: Exception) { Result.retry() }
    }

    companion object {
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        fun schedule(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("flush", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build())
        }
        /** 스캔 직후 등: 통신이 되면 곧바로 보낸다 */
        fun kick(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork("flush-now", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online).build())
        }
    }
}
