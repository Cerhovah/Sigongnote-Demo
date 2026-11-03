package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class CaptureQueueTest {
    private val tenant = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private val user = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
    private val device = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

    private class FakeDao : CaptureQueueDao {
        var transitionCalls = 0
        var resumed = 0
        var owner = listOf("", "", "")
        override fun insert(item: CaptureQueueItem) = Unit
        override fun insertIfAbsent(item: CaptureQueueItem): Long = 1
        override fun get(captureId: String): CaptureQueueItem? = null
        override fun pendingCount(): Int = 0
        override fun blockedCount(): Int = 0
        override fun quotaPausedCount(user:String,device:String):Int = error("Use Room integration test")
        override fun pauseStorageAccount(user:String,device:String,now:Long):Int = error("Use Room integration test")
        override fun resumeStorageQuota(tenant:String,user:String,device:String,available:Long,now:Long):Int = error("Use Room integration test")
        override fun revokedPending(maxItems: Int): List<CaptureQueueItem> = emptyList()
        override fun deferFailedPurge(id: String, generation: Int, now: Long): Int = 0
        override fun revokedPendingCount(): Int = 0
        override fun markRevokedPurged(id: String, generation: Int, now: Long): Int = 0
        override fun uploadCandidates(tenant: String, user: String,
            device: String): List<CaptureQueueItem> = emptyList()
        override fun refreshReadyCopy(captureId: String, sha256: String, name: String,
            now: Long): Int = 0
        override fun requeueInterrupted(now: Long, before: Long): Int = 0
        override fun heartbeat(captureId: String, generation: Int, now: Long): Int = 0
        override fun clearAcknowledgedCopy(captureId: String): Int = 0
        override fun stopForMembership(tenant: String, user: String, device: String,
            now: Long): Int = 0
        override fun transition(captureId: String, generation: Int, current: String,
            next: String, now: Long): Int { transitionCalls++; return 1 }
        override fun stopForRevocation(sourceId: String, generation: Int, tenantId: String,
            userId: String, deviceId: String, now: Long): Int = 0
        override fun stopForNotificationScope(packageName: String, hash: String, now: Long): Int = 0
        override fun stopForNotificationPackage(packageName: String, now: Long): Int = 0
        override fun pauseForLogout(now: Long): Int = 0
        override fun resumeBound(tenantId: String, userId: String, deviceId: String, now: Long): Int {
            resumed++
            return if (owner == listOf(tenantId, userId, deviceId)) 1 else 0
        }
        override fun otherAccountCount(tenantId: String, userId: String, deviceId: String): Int =
            if (owner == listOf(tenantId, userId, deviceId)) 0 else 1
    }

    @Test fun queueTransitionsPreserveRevocationBoundary() {
        assertTrue(QueueTransitions.canMove("discovered", "staging"))
        assertFalse(QueueTransitions.canMove("discovered", "acknowledged"))
        assertTrue(QueueTransitions.canMove("ready", "revoked_pending_purge"))
        assertFalse(QueueTransitions.canMove("revoked_pending_purge", "uploading"))
        assertTrue(QueueTransitions.canMove("revoked_pending_purge", "revoked_purged"))
        assertFalse(QueueTransitions.canMove("acknowledged", "staging"))
    }

    @Test fun forbiddenTransitionDoesNotReachDao() {
        val dao = FakeDao()
        val store = CaptureQueueStore(dao)
        assertEquals(0, store.move("capture", 1, "discovered", "acknowledged", 1))
        assertEquals(0, dao.transitionCalls)
        assertEquals(1, store.move("capture", 1, "discovered", "staging", 1))
        assertEquals(1, dao.transitionCalls)
    }

    @Test fun sameAccountCanRevalidateButDifferentAccountSeesPending() {
        val dao = FakeDao()
        dao.owner = listOf(tenant, user, device)
        val store = CaptureQueueStore(dao)
        assertTrue(QueueTransitions.canMove("paused_logout", "needs_revalidation"))
        assertEquals(1, store.resume(tenant, user, device, 1))
        assertEquals(0, store.resume(tenant, "different", device, 1))
        assertEquals(1, store.otherAccountCount(tenant, "different", device))
    }

    @Test fun nativeDraftRequiresBoundSourceGeneration() {
        val id = "0f8fad5b-d9cb-469f-a165-70867728950e"
        val source = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
        val hash = "a".repeat(64)
        assertEquals(source, NativeIngestionDraft(source, 1, id, hash, 1, "image/jpeg").sourceId)
        assertThrows(IllegalArgumentException::class.java) {
            NativeIngestionDraft(source, 0, id, hash, 1, "image/jpeg")
        }
        assertThrows(IllegalArgumentException::class.java) {
            NativeIngestionDraft("", 1, id, hash, 1, "image/jpeg")
        }
    }
}
