package com.sigongnote.app

import org.junit.Assert.*
import org.junit.Test

class FolderBatchPolicyTest {
    @Test fun recordingBatchStartsNowEvenWhenDiscoveredUnderOrdinaryParent() {
        val now=1800000000000L
        assertEquals(now,FolderBatchPolicy.historyStart(FolderBatchPolicy.kind("통화 녹음","folder"),now))
        assertEquals(now,FolderBatchPolicy.historyStart(FolderBatchPolicy.kind("하위 폴더","call_recording"),now))
        assertEquals(now,FolderBatchPolicy.historyStart("folder",now))
        assertEquals(now,FolderBatchPolicy.historyStart("photos",now))
    }
    private fun folder(id:String,name:String)=FolderNode(FolderEntry(id,name,"directory",null,null),true)
    private fun reader(nodes:List<FolderNode>)=FolderChildrenReader{parent,consumer->
        assertEquals("parent",parent)
        var complete=true
        for(node in nodes)if(!consumer(node)){complete=false;break}
        complete
    }
    @Test fun childIdsRemainDistinctAndOneRescanFindsNewFoldersWithoutCapturingParent() {
        val nodes=listOf(folder("site-a","가람"),folder("site-b","가람"),folder("common","공통자료"),
            FolderNode(FolderEntry("document","납품서.pdf","application/pdf",10,1),false))
        val projects=listOf(FolderProject("project-a","가람"),FolderProject("project-b","가람"))
        val first=FolderBatchPolicy.discover("parent",reader(nodes),projects){null}
        assertEquals(3,first.folders.size);assertFalse(first.folders.any{it.providerId=="parent"})
        assertEquals(2,first.folders.count{it.name=="가람"&&it.scope=="unassigned"})
        assertEquals("company_common",first.folders.single{it.providerId=="common"}.scope)
        val next=FolderBatchPolicy.discover("parent",reader(nodes+folder("new-site","새 현장")),projects){null}
        assertEquals(first.folders.map{it.providerId}.toSet(),next.folders.filter{it.providerId!="new-site"}.map{it.providerId}.toSet())
        assertEquals("unassigned",next.folders.single{it.providerId=="new-site"}.scope)
        assertEquals("project" to "unique",FolderBatchPolicy.suggest("가람",listOf(FolderProject("unique","가람"))))
    }
    @Test fun deniedAndAlreadyCoveredChildrenDoNotBlockReadableChildren() {
        val result=FolderBatchPolicy.discover("parent",reader(listOf(folder("allowed","열림"),folder("denied","닫힘"),folder("covered","연결됨"))),emptyList()){
            when(it.documentId){"denied"->throw SecurityException();"covered"->"already_covered";else->null}
        }
        assertTrue(result.partial);assertNull(result.folders.single{it.providerId=="allowed"}.issue)
        assertEquals("permission_denied",result.folders.single{it.providerId=="denied"}.issue)
        assertEquals("already_covered",result.folders.single{it.providerId=="covered"}.issue)
    }
    @Test fun childHandlePersistsParentGrantAndOpaqueProviderIdentityWithoutSchemaMigration() {
        val parent="content://synthetic.provider/tree/parent"
        val handle=FolderCaptureHandle(parent,"child-opaque-id","unassigned","parent","현장 자료",true)
        val restored=FolderCaptureHandle.decode(handle.encode()){error("Must not decode a child as a tree root")}
        assertEquals(parent,restored.grantUri);assertEquals("child-opaque-id",restored.rootDocumentId)
        assertEquals("unassigned",restored.bindingScopeMode);assertEquals("현장 자료",restored.displayName);assertTrue(restored.externalAiConsent)
        assertEquals(handle.documentKey(),restored.documentKey())
        val direct=FolderCaptureHandle.decode("content://synthetic.provider/tree/child-opaque-id"){"child-opaque-id"}
        assertEquals(handle.documentKey(),direct.documentKey());assertNull(direct.bindingScopeMode);assertFalse(direct.externalAiConsent)
        val repaired=direct.copy(grantUri=parent,parentDocumentId="parent",bindingScopeMode="company_common",displayName="복구 폴더")
        val roundtrip=FolderCaptureHandle.decode(repaired.encode()){error("v2 handle expected")}
        assertEquals(direct.documentKey(),roundtrip.documentKey());assertEquals(parent,roundtrip.grantUri);assertFalse(roundtrip.externalAiConsent)
        assertNotEquals(handle.documentKey(),FolderCaptureHandle("content://other.provider/tree/parent","child-opaque-id","unassigned").documentKey())
    }
    @Test fun discoveryLimitIsVisibleRatherThanSilentlyClaimingComplete() {
        val nodes=(0..FolderBatchPolicy.MAX_FOLDERS).map{folder("child-$it","현장 $it")}
        val result=FolderBatchPolicy.discover("parent",reader(nodes),emptyList()){null}
        assertEquals(FolderBatchPolicy.MAX_FOLDERS,result.folders.size);assertTrue(result.partial)
    }
}
