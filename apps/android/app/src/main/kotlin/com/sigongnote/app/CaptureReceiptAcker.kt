package com.sigongnote.app

import com.sigongnote.contracts.IngestionReceiptResponse

/** A verified server receipt may be recorded even if the local source grant just disappeared. */
class CaptureReceiptAcker(private val db: CaptureQueueDatabase) {
    fun acknowledge(item: CaptureQueueItem, kind: String,
        receipt: IngestionReceiptResponse, predecessorVersion: Int?): Boolean {
        var acknowledged = false
        db.runInTransaction {
            acknowledged = db.queueDao().transition(item.captureId,item.sourceGeneration,
                "uploading","acknowledged",System.currentTimeMillis()) == 1
            if (acknowledged) {
                val recorded = when (kind) {
                    "folder","photos","call_recording" -> db.folderDao().markAcknowledged(item.captureId,
                        receipt.document_id,receipt.revision_id,(predecessorVersion ?: 0) + 1)
                    "notifications" -> db.notificationDao().markAcknowledged(item.captureId)
                    else -> db.shareInboxDao().markAcknowledged(item.captureId)
                }
                check(recorded == 1)
                db.copyReceiptDao().insert(CaptureCopyReceipt(item.captureId,receipt.ingestion_id,receipt.revision_id))
            }
        }
        return acknowledged
    }
}
