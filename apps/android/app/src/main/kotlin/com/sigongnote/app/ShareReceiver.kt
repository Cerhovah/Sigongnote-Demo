package com.sigongnote.app

import android.content.ContentResolver
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import android.system.ErrnoException
import android.system.OsConstants
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/** An explicit Android share is staged locally; account/source binding happens later. */
class ShareReceiver(
    private val resolver: ContentResolver,
    private val dao: ShareInboxDao,
    private val writer: ShareCopyWriter,
    private val copyDirectory: File,
    private val verifyExisting: ((ShareInboxItem) -> Boolean)? = null,
) {
    fun receive(intent: Intent, captureId: String? = null): Int {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return 0
        val batchId = UUID.randomUUID().toString()
        val uris = linkedSetOf<Uri>()
        try {
            intent.data?.let(uris::add)
            if (intent.action == Intent.ACTION_SEND) {
                @Suppress("DEPRECATION")
                (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let(uris::add)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.forEach(uris::add)
            }
            intent.clipData?.let { clips ->
                for (index in 0 until clips.itemCount) clips.getItemAt(index).uri?.let(uris::add)
            }
        } catch (_: RuntimeException) {
            failed(batchId, "application/octet-stream", "invalid_share")
            return 0
        }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val itemCount = uris.size + if (text.isNullOrEmpty()) 0 else 1
        if(captureId!=null)require(Regex("[a-f0-9-]{36}").matches(captureId) && itemCount==1 && uris.single().authority==BuildConfig.APPLICATION_ID+".capture")
        if (itemCount == 0 || itemCount > ShareInputPolicy.maxItems) {
            failed(batchId, "application/octet-stream", if (itemCount == 0) "empty_share" else "too_many_items")
            return 0
        }
        var copied = 0
        if (!text.isNullOrEmpty()) {
            val bytes = text.toByteArray(Charsets.UTF_8)
            copied += stage(batchId, "text/plain", ShareInputPolicy.maxTextBytes) {
                ByteArrayInputStream(bytes)
            }
        }
        for (uri in uris) {
            if(uri.authority==BuildConfig.APPLICATION_ID+".outgoing")continue // Generated output must not loop into collection.
            val name = displayName(uri)
            val resolvedType = try { resolver.getType(uri) }
                catch (_: RuntimeException) { null }
            val mime = (resolvedType ?: intent.type ?: "application/octet-stream")
                .substringBefore(';').lowercase()
            val limit = ShareInputPolicy.limit(mime, name)
            if (uri.scheme != ContentResolver.SCHEME_CONTENT || limit == null) {
                failed(batchId, mime, "unsupported_type_or_uri")
                continue
            }
            copied += stage(batchId, mime, limit, captureId ?: UUID.randomUUID().toString()) {
                resolver.openInputStream(uri) ?: throw FileNotFoundException()
            }
        }
        return copied
    }

    private fun displayName(uri: Uri): String? {
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return null
        return try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor: Cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (_: RuntimeException) { null }
    }

    private fun stage(batchId: String, mime: String, maxBytes: Long, id:String=UUID.randomUUID().toString(), open: () -> java.io.InputStream): Int {
        val existing=dao.item(id)
        if(existing==null)dao.insert(ShareInboxItem(id, batchId, "receiving", mime, null, null, null, null,System.currentTimeMillis()))
        else {
            if(existing.state=="staged_unbound" && verifyExisting!=null && !verifyExisting.invoke(existing))dao.markUploadFailed(id,"copy_integrity_failed")
            if(dao.retryCapture(id)!=1 && existing.state!="receiving")return 0
        }
        var sealed: SealedCopy? = null
        try {
            sealed = writer.seal(open(), maxBytes)
            return if (ShareInboxCommitter(dao, copyDirectory, verifyExisting).commit(id, sealed)) 1 else 0
        } catch (error: Exception) {
            sealed?.let { File(copyDirectory, it.fileName).delete() }
            val code = when {
                ShareStorageFailure.isNoSpace(error) -> "storage_full"
                error is ShareTooLarge -> "too_large"
                error is ShareEmpty -> "empty_file"
                error is SecurityException || error is FileNotFoundException -> "permission_or_file_lost"
                else -> "copy_failed"
            }
            dao.markFailed(id, code)
            return 0
        }
    }

    private fun failed(batchId: String, mime: String, code: String) {
        dao.insert(ShareInboxItem(UUID.randomUUID().toString(), batchId, "failed_visible",
            mime, null, null, null, code, System.currentTimeMillis()))
    }
}

object ShareStorageFailure {
    fun isNoSpace(error: Throwable): Boolean =
        generateSequence(error) { it.cause }.any {
            it is ErrnoException && it.errno == OsConstants.ENOSPC
        }
}
