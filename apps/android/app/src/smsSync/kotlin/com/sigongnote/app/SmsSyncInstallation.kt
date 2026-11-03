package com.sigongnote.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import kotlinx.serialization.json.*

object SmsSyncInstallation {
    fun fingerprint(context:Context)=SmsSyncPolicy.installationFingerprint(requireNotNull(Settings.Secure.getString(context.contentResolver,Settings.Secure.ANDROID_ID)))
    @Suppress("DEPRECATION")
    fun certificateHash(context:Context):String {
        val info=context.packageManager.getPackageInfo(context.packageName,if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES)
        val signatures=if(Build.VERSION.SDK_INT>=28)info.signingInfo?.apkContentsSigners else info.signatures
        val signature=signatures?.singleOrNull()?:throw SecurityException("SMS_INSTALLATION_MISMATCH")
        return java.security.MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString(""){"%02x".format(it)}
    }
    fun requireAccess(context:Context,access:JsonObject,generation:Int){
        if(access["ready"]?.jsonPrimitive?.booleanOrNull!=true||access["generation"]?.jsonPrimitive?.intOrNull!=generation)throw SecurityException("SMS_POLICY_GATED")
        val hash=certificateHash(context)
        if(access["application_id"]?.jsonPrimitive?.content!=context.packageName||access["certificate_sha256"]?.jsonPrimitive?.content!=hash||access["installation_fingerprint"]?.jsonPrimitive?.content!=fingerprint(context)||java.time.Instant.parse(access.getValue("expires_at").jsonPrimitive.content).toEpochMilli()<=System.currentTimeMillis())throw SecurityException("SMS_INSTALLATION_MISMATCH")
    }
}
