package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class CaptureOrphanPolicyTest {
    @Test fun onlyOldUnreferencedEncryptedPrivateCopiesCanBeRemoved() {
        val now = 7_200_000L
        assertTrue(CaptureOrphanPolicy.shouldDelete("orphan.sealed",1,emptySet(),now))
        assertTrue(CaptureOrphanPolicy.shouldDelete("staging-orphan.tmp",1,emptySet(),now))
        assertFalse(CaptureOrphanPolicy.shouldDelete("kept.sealed",1,setOf("kept.sealed"),now))
        assertFalse(CaptureOrphanPolicy.shouldDelete("new.sealed",now,emptySet(),now))
        assertFalse(CaptureOrphanPolicy.shouldDelete("important.pdf",1,emptySet(),now))
        assertFalse(CaptureOrphanPolicy.shouldDelete("other.tmp",1,emptySet(),now))
    }
}
