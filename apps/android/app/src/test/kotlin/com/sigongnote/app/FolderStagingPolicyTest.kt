package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class FolderStagingPolicyTest {
    @Test fun acknowledgedCopiesCountAndRecentFilesHaveReservedSpace() {
        val gib=1024L*1024*1024;val now=100L*24*60*60*1000
        assertEquals("app_copy_cap",FolderStagingPolicy.capacity(19*gib/10,1,1,now,10*gib,20*gib))
        assertNull(FolderStagingPolicy.capacity(19*gib/10,1,now,now,10*gib,20*gib))
        assertEquals("app_copy_cap",FolderStagingPolicy.capacity(2*gib,1,now,now,10*gib,20*gib))
        assertEquals("device_low",FolderStagingPolicy.capacity(0,1,now,now,gib,20*gib))
    }
    @Test fun legacyBaselineExcludesOnlyUnchangedInitialHistoricalFiles() {
        val source=FolderSource("s","sealed",1,"selected",0,null,null,0,0,0,0,null,null,null,100L*24*60*60*1000)
        val old=FolderEntry("old","old.pdf","application/pdf",1,1)
        assertTrue(FolderStagingPolicy.legacyOutside(source,old,null))
        val marker=FolderPending("s","hash",-1,1,1)
        assertTrue(FolderStagingPolicy.legacyOutside(source.copy(scanGeneration=1),old,marker))
        assertFalse(FolderStagingPolicy.legacyOutside(source.copy(scanGeneration=1),old,null))
        assertFalse(FolderStagingPolicy.legacyOutside(source.copy(scanGeneration=1),old.copy(size=2),marker))
        assertFalse(FolderStagingPolicy.legacyOutside(source.copy(historyMode="all"),old,marker))
    }
}
