package com.sigongnote.app

import java.net.URI

/** Only storage PUTs prepared by the configured account service leave the bundled work UI. */
object WorkUploadPolicy {
    fun allows(value:String,origin:String,method:String):Boolean = try {
        val target=URI(value);val configured=URI(origin)
        method in setOf("PUT","OPTIONS") && target.scheme=="https" && configured.scheme=="https" &&
            target.host!=null && target.host==configured.host && target.port==configured.port &&
            target.userInfo==null && target.fragment==null &&
            target.rawPath.startsWith("/storage/v1/object/upload/sign/sigongnote-originals/") &&
            target.rawQuery?.split('&')?.any { it.startsWith("token=")&&it.length>6 }==true
    } catch(_:Exception) { false }
}
