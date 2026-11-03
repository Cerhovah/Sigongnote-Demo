package com.sigongnote.app

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/** A bounded carrier hand-off. Never accepts arbitrary paths or external callers. */
class MmsTransferProvider : ContentProvider() {
    companion object {
        private val name = Regex("[a-f0-9]{64}\\.pdu")

        fun uri(context: Context, digest: String): Uri {
            require(name.matches("$digest.pdu"))
            return Uri.Builder().scheme("content")
                .authority("${context.packageName}.mms-transfer")
                .appendPath("$digest.pdu").build()
        }

        fun file(context: Context, digest: String): File {
            require(name.matches("$digest.pdu"))
            return File(File(context.cacheDir,"mms-transfers").apply { mkdirs() },"$digest.pdu")
        }
    }

    override fun onCreate() = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val component = uri.pathSegments.singleOrNull()
        if (component == null || !name.matches(component)) throw FileNotFoundException()
        val target = File(File(requireNotNull(context).cacheDir,"mms-transfers").apply {
            mkdirs()
        },component)
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "w", "wt" -> ParcelFileDescriptor.MODE_WRITE_ONLY or
                ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw FileNotFoundException()
        }
        return ParcelFileDescriptor.open(target,flags)
    }

    override fun getType(uri: Uri): String? = "application/vnd.wap.mms-message"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(uri: Uri, values: ContentValues?, selection: String?,
        selectionArgs: Array<out String>?): Int = 0
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
