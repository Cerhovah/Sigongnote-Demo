package com.sigongnote.app

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import java.security.MessageDigest

data class FolderEntry(
    val documentId: String,
    val displayName: String,
    val mime: String,
    val size: Long?,
    val modifiedAtEpochMs: Long?,
)

class FolderScanGap(val reason: String) : Exception()

/** Only opaque provider IDs live in memory; Room stores their hashes. */
class FolderInventory(private val resolver: ContentResolver) {
    fun visit(treeUri: Uri, parent: String, consumer: (FolderNode)->Boolean): Boolean {
        val children=DocumentsContract.buildChildDocumentsUriUsingTree(treeUri,parent)
        val projection=arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        val cursor=resolver.query(children,projection,null,null,null) ?: throw FolderScanGap("provider_no_cursor")
        cursor.use { rows ->
            if(rows.extras.getBoolean(DocumentsContract.EXTRA_LOADING,false))throw FolderScanGap("provider_loading")
            val idColumn=rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameColumn=rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeColumn=rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val sizeColumn=rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
            val modifiedColumn=rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
            while(rows.moveToNext()) {
                val id=rows.getString(idColumn) ?: throw FolderScanGap("missing_document_id")
                val name=rows.getString(nameColumn) ?: ""
                if(name.startsWith('.') || name.startsWith("~$"))continue
                val mime=rows.getString(mimeColumn) ?: "application/octet-stream"
                val entry=FolderEntry(id,name,mime,if(rows.isNull(sizeColumn))null else rows.getLong(sizeColumn),
                    if(rows.isNull(modifiedColumn))null else rows.getLong(modifiedColumn))
                if(!consumer(FolderNode(entry,mime==DocumentsContract.Document.MIME_TYPE_DIR)))return false
            }
        }
        return true
    }

    fun currentMetadata(treeUri: Uri, documentId: String): Pair<Long?,Long?> {
        val document = DocumentsContract.buildDocumentUriUsingTree(treeUri,documentId)
        val columns = arrayOf(DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        val cursor = resolver.query(document,columns,null,null,null)
            ?: throw FolderScanGap("provider_no_cursor")
        cursor.use { rows ->
            if (!rows.moveToFirst()) throw FolderScanGap("document_moved")
            val sizeColumn = rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
            val modifiedColumn = rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
            return Pair(if (rows.isNull(sizeColumn)) null else rows.getLong(sizeColumn),
                if (rows.isNull(modifiedColumn)) null else rows.getLong(modifiedColumn))
        }
    }
}

object FolderScanPolicy {
    private const val initialDays = 30L
    fun documentIdHash(documentId: String): String = MessageDigest.getInstance("SHA-256")
        .digest(documentId.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    fun stable(first: FolderEntry, second: FolderEntry): Boolean =
        first.size != null && first.size > 0 && first.modifiedAtEpochMs != null &&
            first.modifiedAtEpochMs > 0 && first.size == second.size &&
            first.modifiedAtEpochMs == second.modifiedAtEpochMs

    fun inInitialWindow(entry: FolderEntry, selectedAtEpochMs: Long): Boolean =
        entry.modifiedAtEpochMs != null &&
            entry.modifiedAtEpochMs >= selectedAtEpochMs - initialDays * 24 * 60 * 60 * 1000
}
