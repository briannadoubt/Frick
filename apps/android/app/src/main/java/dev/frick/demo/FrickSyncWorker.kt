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
import dev.frick.client.SQLiteFrickStorage
import java.util.concurrent.TimeUnit

/**
 * Background sync drain for the Android demo. WorkManager wakes the
 * worker periodically (every ~15 minutes, the OS minimum) and we run
 * `FrickClient.flushPendingAppends()` to replay queued appends over
 * HTTP. The pending-append queue is durable in SQLite ([SQLiteFrickStorage]) so
 * any messages typed offline catch up on the next opportunity.
 *
 * Constraint: requires a connected network. This permits metered
 * networks; apps that want Wi-Fi-only drains can switch the scheduled
 * constraint to [NetworkType.UNMETERED].
 *
 * Registered from [MainActivity.onCreate] via [FrickSyncWorker.schedule].
 */
class FrickSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        // FrickClient's positional ctor takes `baseUrl: String`, not a
        // Context — wire the SQLite-backed storage explicitly so the
        // drain reads the same pending-append queue the foreground VM
        // does, while using the demo's configured server endpoint.
        val client = FrickClient(baseUrl = DemoBaseUrl, storage = SQLiteFrickStorage(applicationContext))
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
