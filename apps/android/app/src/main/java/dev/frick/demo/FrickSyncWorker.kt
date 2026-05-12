package dev.frick.demo

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.frick.client.FrickClient
import java.util.concurrent.TimeUnit

/**
 * Background sync drain for the Android demo. WorkManager wakes the
 * worker periodically (every ~15 minutes, the OS minimum) and we run
 * `FrickClient.flushPendingAppends()` against the live socket. The
 * pending-append queue is durable in SQLite ([FrickSQLiteStorage]) so
 * any messages typed offline catch up on the next opportunity.
 *
 * Constraint: requires unmetered network so we don't burn mobile data
 * on a background drain. Apps that want to drain on cellular can drop
 * the constraint when scheduling.
 *
 * Registered from [MainActivity.onCreate] via [FrickSyncWorker.schedule].
 */
class FrickSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val client = FrickClient(applicationContext)
        return try {
            client.flushPendingAppends()
            Result.success()
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            // Most failure modes (no network, server 5xx) are transient —
            // ask WorkManager to back-off and retry on its own schedule.
            Result.retry()
        }
    }

    companion object {
        const val UNIQUE_NAME = "frick.sync.pending-appends"

        /**
         * Register the periodic worker. Idempotent — uses
         * [ExistingPeriodicWorkPolicy.KEEP] so re-running on every cold
         * start doesn't duplicate the schedule.
         */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequestBuilder<FrickSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
