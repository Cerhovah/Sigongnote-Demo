package com.sigongnote.app

/** Independent gates: a runtime grant or a debug installation is not distribution approval. */
object SmsSyncPolicy {
    private fun digest(value:String)=java.security.MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
    fun installationFingerprint(androidId:String):String {require(androidId.isNotBlank());return digest("sms-install-v1:$androidId")}
    fun messageKey(tenant:String,user:String,installation:String,kind:String,id:Long,time:Long):String = digest("sms-record-v1:$tenant:$user:$installation:$kind:$id:$time")
    const val mime = "application/vnd.sigongnote.message+json"
    const val maxPartBytes = 5 * 1024 * 1024
    fun reconcileDue(previous:Long,now:Long)=previous==0L||now<previous||now-previous>=86_400_000L
    fun ready(policyQualified: Boolean, installerAllowed: Boolean, runtimeGranted: Boolean,
        accountBound: Boolean, scopeActive: Boolean): Boolean =
        policyQualified && installerAllowed && runtimeGranted && accountBound && scopeActive
    fun normalize(value: String): String {
        val compact = value.substringBefore("/TYPE=").filterNot { it == ' ' || it == '-' || it == '(' || it == ')' }
        if (!Regex("\\+?[0-9]{3,15}").matches(compact)) return ""
        return if (compact.startsWith("+82")) "0" + compact.substring(3) else compact
    }
    fun allowedParticipants(addresses: List<String>, selected: Set<String>): Boolean =
        addresses.isNotEmpty() && addresses.all { normalize(it).let { normalized -> normalized.isNotEmpty() && normalized in selected } }
    fun readsMessage(allNew:Boolean,addresses:List<String>,selected:Set<String>):Boolean =
        allNew || allowedParticipants(addresses,selected)
    fun checkpoint(current: Long, seen: Long, stored: Boolean): Long = if (stored) maxOf(current,seen) else current
}
