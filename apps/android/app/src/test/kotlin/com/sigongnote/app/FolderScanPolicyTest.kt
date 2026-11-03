package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class FolderScanPolicyTest {
    @Test fun onlyStableProviderMetadataCanBeCopied() {
        val before = FolderEntry("opaque", "plan.pdf", "application/pdf", 100, 1_000)
        assertTrue(FolderScanPolicy.stable(before,before))
        assertFalse(FolderScanPolicy.stable(before,before.copy(size = 101)))
        assertFalse(FolderScanPolicy.stable(before,before.copy(modifiedAtEpochMs = 1_001)))
        assertFalse(FolderScanPolicy.stable(before.copy(size = null),before.copy(size = null)))
        assertFalse(FolderScanPolicy.stable(before.copy(modifiedAtEpochMs = null),
            before.copy(modifiedAtEpochMs = null)))
    }

    @Test fun initialWindowAndOpaqueId() {
        val now = 50L * 24 * 60 * 60 * 1000
        val entry = FolderEntry("private/path", "plan.pdf", "application/pdf", 100,
            now - 29L * 24 * 60 * 60 * 1000)
        assertTrue(FolderScanPolicy.inInitialWindow(entry,now))
        assertFalse(FolderScanPolicy.inInitialWindow(entry.copy(
            modifiedAtEpochMs = now - 31L * 24 * 60 * 60 * 1000),now))
        assertFalse(FolderScanPolicy.inInitialWindow(entry.copy(modifiedAtEpochMs = null),now))
        assertEquals(64,FolderScanPolicy.documentIdHash(entry.documentId).length)
        assertFalse(FolderScanPolicy.documentIdHash(entry.documentId).contains("private"))
    }
}
