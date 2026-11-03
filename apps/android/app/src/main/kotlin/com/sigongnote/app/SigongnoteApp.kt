package com.sigongnote.app

import android.app.Application
import androidx.room.Room
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors

/** Capture storage survives WebView/Activity teardown for the process lifetime. */
class SigongnoteApp : Application() {
    val queue: CaptureQueueDatabase by lazy {
        Room.databaseBuilder(applicationContext,CaptureQueueDatabase::class.java,
            "capture-queue.db").addMigrations(ShareInboxMigration(applicationContext),
            FolderMigration(applicationContext),NotificationMigration(applicationContext),
            ShareRetentionMigration(applicationContext),FolderBindingMigration(applicationContext),
            NotificationUploadMigration(applicationContext),FolderScopeMigration(applicationContext),FolderScanMigration(applicationContext),CaptureCopyReceiptMigration()).build()
    }
    val setupExecutor = Executors.newSingleThreadExecutor()
    val scanExecutor = Executors.newSingleThreadExecutor()
    val notificationExecutor = Executors.newSingleThreadExecutor()
    val uploadExecutor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        scanExecutor.execute { queue.folderDao().recoverInterrupted() }
        val manager = WorkManager.getInstance(this)
        manager.enqueueUniquePeriodicWork("capture-maintenance",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<CaptureMaintenanceWorker>(15,TimeUnit.MINUTES).build())
        manager.enqueueUniqueWork("capture-maintenance-startup",ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<CaptureMaintenanceWorker>().build())
        CaptureUploadWork.schedule(this)
        if(BuildConfig.FLAVOR=="smsSync")runCatching {
            Class.forName("com.sigongnote.app.SmsSyncWork").getMethod("schedule",android.content.Context::class.java).invoke(null,this)
        }
    }
}
