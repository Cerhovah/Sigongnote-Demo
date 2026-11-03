package com.sigongnote.app

import android.content.Intent
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class ShareInboxTest {
    private class FakeDao : ShareInboxDao {
        val staged = mutableMapOf<Pair<String, Long>, String>()
        val duplicates = mutableMapOf<String, String>()
        val paths = mutableMapOf<String, String>()
        override fun insert(item: ShareInboxItem) = Unit
        override fun item(id: String): ShareInboxItem? = null
        override fun stagedCount(): Int = staged.size
        override fun uploadableSince(since: Long): List<ShareInboxItem> = emptyList()
        override fun markAcknowledged(id: String): Int = 1
        override fun expiredAcknowledged(before: Long): List<ShareInboxItem> = emptyList()
        override fun otherCopyReferences(name: String, id: String): Int = 0
        override fun markRevokedPurged(id: String): Int = 0
        override fun setRetentionHold(id: String, hold: Boolean): Int = 0
        override fun markAcknowledgedCopyPurged(id: String, name: String): Int = 0
        override fun markUploadFailed(id: String, code: String): Int = 1
        override fun resumeStorageQuota(tenant:String,user:String,device:String):Int = error("Use Room integration test")
        override fun failedCount(): Int = 0
        override fun storageFailedCount(): Int = 0
        override fun receivingCount(): Int = 0
        override fun duplicateCount(): Int = duplicates.size
        override fun pendingResumableCount(): Int = paths.values.count { it == "pending_resumable" }
        override fun stagedBytes(): Long = 0
        override fun findExactStaged(sha256: String, length: Long): String? = staged[sha256 to length]
        override fun markStaged(id: String, name: String, sha256: String, length: Long,
            uploadPath: String): Int {
            staged[sha256 to length] = id
            paths[id] = uploadPath
            return 1
        }
        override fun markFailed(id: String, code: String): Int = 1
        override fun retryCapture(id:String):Int = error("Use Room capture retry")
        override fun failStaleReceiving(before: Long): Int = 0
        override fun referencedCopyNames(): List<String> = emptyList()
        override fun markDuplicate(id: String, existingId: String): Int {
            duplicates[id] = existingId
            return 1
        }
    }

    @Test fun historyIntentDoesNotReceiveAgain() {
        assertTrue(ShareIntentPolicy.shouldReceive(Intent.ACTION_SEND,false,0))
        assertTrue(ShareIntentPolicy.shouldReceive(Intent.ACTION_SEND_MULTIPLE,false,0))
        assertFalse(ShareIntentPolicy.shouldReceive(Intent.ACTION_SEND,false,
            Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
        assertFalse(ShareIntentPolicy.shouldReceive(Intent.ACTION_SEND,true,0))
        assertFalse(ShareIntentPolicy.shouldReceive(Intent.ACTION_MAIN,false,0))
    }

    @Test fun equalBytesKeepOneCopyAndSecondObservation() {
        val directory = Files.createTempDirectory("share-duplicate-test").toFile()
        try {
            val dao = FakeDao()
            val first = directory.resolve("first.sealed").apply { writeText("sealed") }
            val second = directory.resolve("second.sealed").apply { writeText("sealed") }
            val commit = ShareInboxCommitter(dao,directory)
            assertTrue(commit.commit("share-1",SealedCopy(first.name,"a".repeat(64),6)))
            assertFalse(commit.commit("share-2",SealedCopy(second.name,"a".repeat(64),6)))
            assertEquals(1,dao.stagedCount())
            assertEquals(1,dao.duplicateCount())
            assertEquals("share-1",dao.duplicates["share-2"])
            assertTrue(first.exists())
            assertFalse(second.exists())
            assertEquals("direct",dao.paths["share-1"])
            val large = directory.resolve("large.sealed").apply { writeText("sealed") }
            assertTrue(commit.commit("share-3",SealedCopy(large.name,"b".repeat(64),20_000_000)))
            assertEquals("pending_resumable",dao.paths["share-3"])
        } finally { directory.deleteRecursively() }
    }
}
