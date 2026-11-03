package com.sigongnote.app

/** A user-wide storage pause retains sources/copies and survives process restart or logout. */
class CaptureStorageQuota(private val db:CaptureQueueDatabase) {
    fun paused(session:UploadSession)=db.queueDao().quotaPausedCount(session.userId,session.deviceId)>0
    fun pause(session:UploadSession) {
        db.runInTransaction { db.queueDao().pauseStorageAccount(session.userId,session.deviceId,System.currentTimeMillis()) }
    }
    fun resume(session:UploadSession,availableBytes:Long):Boolean {
        db.runInTransaction {
            val now=System.currentTimeMillis()
            db.queueDao().pauseStorageAccount(session.userId,session.deviceId,now)
            db.queueDao().resumeStorageQuota(session.tenantId,session.userId,session.deviceId,availableBytes.coerceAtLeast(0),now)
            db.shareInboxDao().resumeStorageQuota(session.tenantId,session.userId,session.deviceId)
        }
        return db.queueDao().uploadCandidates(session.tenantId,session.userId,session.deviceId).isNotEmpty()
    }
}
