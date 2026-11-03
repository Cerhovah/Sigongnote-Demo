package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class FolderSourcePolicyTest {
    private fun source(kind: String="folder") = FolderSource("local","sealed",1,"selected",0,
        null,null,0,0,0,0,null,null,null,100,kind=kind,historyMode="all")
    @Test fun wholeHistoryAndSourcePurposeSurviveCopySelection() {
        val old = FolderEntry("opaque","invoice.pdf","application/pdf",123,1)
        assertTrue(FolderSourcePolicy.allows(source(),old))
        assertFalse(FolderSourcePolicy.allows(source().copy(historyMode="since",historySinceEpochMs=2),old))
        assertFalse(FolderSourcePolicy.allows(source().copy(scopeMode="mixed_hold"),old))
        val audio=old.copy(displayName="call.m4a",mime="application/octet-stream")
        assertTrue(FolderSourcePolicy.allows(source().copy(historyMode="legacy_recent"),audio))
        assertFalse(FolderSourcePolicy.allows(source(),audio))
        assertTrue(FolderSourcePolicy.allows(source("call_recording"),audio))
        assertFalse(FolderSourcePolicy.allows(source("photos"),old))
        assertTrue(FolderSourcePolicy.allows(source("photos"),old.copy(mime="image/jpeg")))
        assertEquals(FolderSourcePolicy.requestKey("a","source"),FolderSourcePolicy.requestKey("a","source"))
        assertNotEquals(FolderSourcePolicy.requestKey("a","source"),FolderSourcePolicy.requestKey("a","binding"))
    }
}
