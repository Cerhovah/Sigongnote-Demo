package com.sigongnote.app

/** A local byte limit is not proof of carrier MMS support. */
object MmsAttachmentPolicy {
    const val maxBytes=1024L*1024
    fun fits(bytes: Long)=bytes in 1..maxBytes
}
