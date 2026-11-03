package com.sigongnote.app

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract

object FolderHandleAccess {
    fun decode(raw:String):FolderCaptureHandle=FolderCaptureHandle.decode(raw) { DocumentsContract.getTreeDocumentId(Uri.parse(it)) }
    fun open(source:FolderSource):FolderCaptureHandle=decode(FolderHandleVault().open(source.encryptedTreeUri))
    fun grant(source:FolderSource):Uri=Uri.parse(open(source).grantUri)
    fun root(raw:String):String=decode(raw).rootDocumentId
    fun overlaps(resolver:ContentResolver,first:FolderCaptureHandle,second:FolderCaptureHandle):Boolean {
        val a=Uri.parse(first.grantUri);val b=Uri.parse(second.grantUri)
        if(a.authority!=b.authority)return false
        if(first.rootDocumentId==second.rootDocumentId)return true
        // These IDs were observed as immediate children of the same parent, so they are siblings.
        if(first.parentDocumentId!=null && first.parentDocumentId==second.parentDocumentId && first.grantUri==second.grantUri)return false
        if(first.rootDocumentId==second.parentDocumentId || second.rootDocumentId==first.parentDocumentId)return true
        return try {
            val firstUri=DocumentsContract.buildDocumentUriUsingTree(a,first.rootDocumentId)
            val secondUri=DocumentsContract.buildDocumentUriUsingTree(b,second.rootDocumentId)
            DocumentsContract.isChildDocument(resolver,firstUri,secondUri)||DocumentsContract.isChildDocument(resolver,secondUri,firstUri)
        }catch(_:Exception){true} // Unknown overlap cannot create another recursive capture.
    }
}
