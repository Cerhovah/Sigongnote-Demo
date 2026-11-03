package com.sigongnote.app

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.provider.Telephony
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.telephony.PhoneNumberUtils
import android.util.Base64
import com.google.android.mms.pdu_alt.PduPersister
import com.google.android.mms.pdu_alt.RetrieveConf
import com.google.android.mms.pdu_alt.SendReq
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Play review is not a client flag. No SMS/Call Log payload leaves this build. */
object SmsPolicyGate {
    const val smsServerUploadApproved = false
    const val callLogAccessApproved = false
    fun canUploadSms(roleHeld: Boolean, scopeApproved: Boolean): Boolean =
        smsServerUploadApproved && roleHeld && scopeApproved
}

internal fun soleMmsRecipient(toCount: Int, ccCount: Int, bccCount: Int): Boolean =
    toCount == 1 && ccCount == 0 && bccCount == 0

private object SmsCaptureVault {
    private const val aesAlias = "sigongnote.sms.capture.aes.v1"
    private const val macAlias = "sigongnote.sms.capture.hmac.v1"

    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun aes(): SecretKey {
        val existing = store().getKey(aesAlias,null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(aesAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build())
        return generator.generateKey()
    }

    private fun macKey(): SecretKey {
        val existing = store().getKey(macAlias,null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256,
            "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(macAlias,KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256).build())
        return generator.generateKey()
    }

    fun id(value: String): String = Mac.getInstance("HmacSHA256").run {
        init(macKey())
        doFinal(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    fun seal(value: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,aes())
        return byteArrayOf(1) + cipher.iv + cipher.doFinal(value)
    }

    fun open(value: ByteArray): ByteArray {
        require(value.size >= 30 && value[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,aes(),GCMParameterSpec(128,value.copyOfRange(1,13)))
        return cipher.doFinal(value.copyOfRange(13,value.size))
    }
}

private class SmsCaptureDatabase(context: Context) :
    SQLiteOpenHelper(context,"sms-business-capture.db",null,1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""CREATE TABLE scopes (
            scope_key TEXT PRIMARY KEY, sealed_address BLOB NOT NULL,
            tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
            since_ms INTEGER NOT NULL, generation INTEGER NOT NULL,
            state TEXT NOT NULL, approved_ms INTEGER NOT NULL,
            last_scan_ms INTEGER, coverage TEXT NOT NULL)""")
        db.execSQL("""CREATE TABLE observations (
            observation_key TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
            generation INTEGER NOT NULL, kind TEXT NOT NULL,
            observed_ms INTEGER NOT NULL, sealed_payload BLOB NOT NULL,
            state TEXT NOT NULL, FOREIGN KEY(scope_key) REFERENCES scopes(scope_key))""")
        db.execSQL("CREATE INDEX observations_scope ON observations(scope_key,observed_ms)")
        db.execSQL("""CREATE TABLE health (
            id INTEGER PRIMARY KEY CHECK(id=1), role_state TEXT NOT NULL,
            gap_start_ms INTEGER, last_role_check_ms INTEGER NOT NULL)""")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw IllegalStateException("Unsupported SMS capture schema")
    }
}

data class SmsBusinessScope(val key: String, val address: String, val sinceMs: Long,
    val generation: Int, val state: String, val coverage: String, val lastScanMs: Long?)
data class SmsBusinessScan(val sms: Int, val mms: Int, val partial: Boolean)

/** Explicit account-bound phone scope; original SMS/MMS remains in Telephony unchanged. */
class SmsBusinessCapture(private val context: Context) {
    private val helper = SmsCaptureDatabase(context.applicationContext)
    private val db get() = helper.writableDatabase

    companion object {
        fun normalize(address: String): String {
            val value = PhoneNumberUtils.normalizeNumber(address.substringBefore("/TYPE="))
            return if (value.startsWith("+82") && value.length > 3)
                "0${value.substring(3)}" else value
        }
    }

    private fun scopeKey(address: String, session: UploadSession): String =
        SmsCaptureVault.id("phone:${session.tenantId}:${session.userId}:${session.deviceId}:" +
            normalize(address))

    fun approve(address: String, sinceMs: Long, session: UploadSession): SmsBusinessScope {
        check(SmsRoleRuntime.canRead(context))
        val normalized = normalize(address)
        require(SmsRoleRuntime.validAddress(normalized) &&
            sinceMs in 1..System.currentTimeMillis())
        val key = scopeKey(normalized,session)
        val prior = scope(key)
        val generation = (prior?.generation ?: 0) + 1
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put("scope_key",key)
            put("sealed_address",SmsCaptureVault.seal(normalized.toByteArray()))
            put("tenant_id",session.tenantId)
            put("user_id",session.userId)
            put("device_id",session.deviceId)
            put("since_ms",sinceMs)
            put("generation",generation)
            put("state","selected")
            put("approved_ms",now)
            putNull("last_scan_ms")
            put("coverage","not_scanned")
        }
        db.insertWithOnConflict("scopes",null,values,SQLiteDatabase.CONFLICT_REPLACE)
        return requireNotNull(scope(key))
    }

    fun revoke(address: String, session: UploadSession): Boolean {
        val key = scopeKey(address,session)
        val current = scope(key) ?: return false
        if (!bound(key,session)) return false
        val values = ContentValues().apply {
            put("state","revoked")
            put("generation",current.generation + 1)
            put("coverage","revoked")
        }
        return db.update("scopes",values,"scope_key=?",arrayOf(key)) == 1
    }

    private fun bound(key: String, session: UploadSession): Boolean =
        db.rawQuery("""SELECT 1 FROM scopes WHERE scope_key=? AND tenant_id=? AND
            user_id=? AND device_id=? LIMIT 1""",arrayOf(key,session.tenantId,
            session.userId,session.deviceId)).use { it.moveToFirst() }

    private fun scope(key: String): SmsBusinessScope? =
        db.rawQuery("""SELECT sealed_address,since_ms,generation,state,coverage,last_scan_ms
            FROM scopes WHERE scope_key=?""",arrayOf(key)).use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            SmsBusinessScope(key,String(SmsCaptureVault.open(cursor.getBlob(0))),
                cursor.getLong(1),cursor.getInt(2),cursor.getString(3),cursor.getString(4),
                if (cursor.isNull(5)) null else cursor.getLong(5))
        }

    fun scopes(session: UploadSession): List<SmsBusinessScope> {
        val keys = mutableListOf<String>()
        db.rawQuery("""SELECT scope_key FROM scopes WHERE tenant_id=? AND user_id=?
            AND device_id=? ORDER BY approved_ms DESC""",
            arrayOf(session.tenantId,session.userId,session.deviceId)).use { cursor ->
            while (cursor.moveToNext()) keys.add(cursor.getString(0))
        }
        return keys.mapNotNull(::scope)
    }

    fun roleChanged() {
        val held = SmsRoleRuntime.canRead(context)
        val now = System.currentTimeMillis()
        db.beginTransaction()
        try {
            val oldGap = db.rawQuery("SELECT gap_start_ms FROM health WHERE id=1",null).use {
                if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null
            }
            val values = ContentValues().apply {
                put("id",1)
                put("role_state",if (held) "connected" else "disconnected")
                if (held) putNull("gap_start_ms") else put("gap_start_ms",oldGap ?: now)
                put("last_role_check_ms",now)
            }
            db.insertWithOnConflict("health",null,values,SQLiteDatabase.CONFLICT_REPLACE)
            if (held && oldGap != null) db.execSQL(
                "UPDATE scopes SET coverage='gap_recheck' WHERE state='selected'")
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    private fun selected(address: String, dateMs: Long, session: UploadSession): SmsBusinessScope? {
        if (!SmsRoleRuntime.canRead(context)) return null
        val scope = scope(scopeKey(address,session)) ?: return null
        return scope.takeIf { it.state == "selected" && dateMs >= it.sinceMs &&
            bound(it.key,session) }
    }

    private fun store(scope: SmsBusinessScope, kind: String, providerId: Long,
        observedMs: Long, payload: ByteArray): Boolean {
        if (!SmsRoleRuntime.canRead(context) || payload.size !in 1..(8 * 1024 * 1024)) return false
        val active = scope(scope.key) ?: return false
        if (active.state != "selected" || active.generation != scope.generation) return false
        val key = SmsCaptureVault.id("$kind:$providerId:${scope.key}:" +
            SmsCaptureVault.id(String(payload,Charsets.UTF_8)))
        val values = ContentValues().apply {
            put("observation_key",key)
            put("scope_key",scope.key)
            put("generation",scope.generation)
            put("kind",kind)
            put("observed_ms",observedMs)
            put("sealed_payload",SmsCaptureVault.seal(payload))
            put("state","local_policy_gated")
        }
        return db.insertWithOnConflict("observations",null,values,
            SQLiteDatabase.CONFLICT_IGNORE) != -1L
    }

    fun captureSms(id: Long, session: UploadSession): Boolean {
        if (!SmsRoleRuntime.canRead(context) || id < 0) return false
        val uri = ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI,id)
        context.contentResolver.query(uri,arrayOf(Telephony.Sms.ADDRESS,Telephony.Sms.BODY,
            Telephony.Sms.DATE,Telephony.Sms.TYPE),null,null,null)?.use { cursor ->
            if (!cursor.moveToFirst()) return false
            val address = cursor.getString(0) ?: return false
            val date = cursor.getLong(2)
            val scope = selected(address,date,session) ?: return false
            val payload = buildJsonObject {
                put("schema",1)
                put("kind","sms")
                put("provider_id",id)
                put("address",address)
                put("body",cursor.getString(1) ?: "")
                put("date_ms",date)
                put("type",cursor.getInt(3))
                put("scope_generation",scope.generation)
            }.toString().toByteArray()
            return store(scope,"sms",id,date,payload)
        }
        return false
    }

    fun captureMms(id: Long, session: UploadSession): Boolean {
        if (!SmsRoleRuntime.canRead(context) || id < 0) return false
        val uri = ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI,id)
        val pdu = readMmsPdu { PduPersister.getPduPersister(context).load(uri) }
        val address = when (pdu) {
            is RetrieveConf -> pdu.from?.string
            // A group message contains other people's content. One approved recipient
            // must never authorize archiving a copy addressed to additional people.
            is SendReq -> pdu.to?.singleOrNull()?.string?.takeIf {
                soleMmsRecipient(pdu.to?.size ?: 0,pdu.cc?.size ?: 0,pdu.bcc?.size ?: 0)
            }
            else -> null
        } ?: return false
        val dateSeconds = context.contentResolver.query(uri,arrayOf(Telephony.Mms.DATE),
            null,null,null)?.use { if (it.moveToFirst()) it.getLong(0) else null } ?: return false
        val dateMs = dateSeconds * 1000
        val scope = selected(address,dateMs,session) ?: return false
        val parts = when (pdu) {
            is RetrieveConf -> pdu.body
            is SendReq -> pdu.body
            else -> null
        } ?: return false
        var total = 0
        val payload = buildJsonObject {
            put("schema",1)
            put("kind","mms")
            put("provider_id",id)
            put("address",address)
            put("date_ms",dateMs)
            put("scope_generation",scope.generation)
            put("parts",buildJsonArray {
                for (index in 0 until parts.partsNum) {
                    val part = parts.getPart(index)
                    val mime = part.contentType?.toString(Charsets.ISO_8859_1) ?: "unknown"
                    val bytes = part.data ?: part.dataUri?.let { partUri ->
                        context.contentResolver.openInputStream(partUri)?.use { stream ->
                            val output = java.io.ByteArrayOutputStream()
                            val buffer = ByteArray(8192)
                            while (true) {
                                val size = stream.read(buffer)
                                if (size < 0) break
                                output.write(buffer,0,size)
                                require(output.size() <= 5 * 1024 * 1024)
                            }
                            output.toByteArray()
                        }
                    } ?: throw IllegalStateException("MMS part unavailable")
                    total += bytes.size
                    require(total <= 5 * 1024 * 1024)
                    add(buildJsonObject {
                        put("index",index)
                        put("mime",mime)
                        put("bytes_base64",Base64.encodeToString(bytes,Base64.NO_WRAP))
                    })
                }
            })
        }.toString().toByteArray()
        return store(scope,"mms",id,dateMs,payload)
    }

    fun scanApproved(session: UploadSession): SmsBusinessScan {
        if (!SmsRoleRuntime.canRead(context)) { roleChanged(); return SmsBusinessScan(0,0,true) }
        roleChanged()
        var sms = 0
        var mms = 0
        var partial = false
        for (scope in scopes(session).filter { it.state == "selected" }) {
            val since = maxOf(scope.sinceMs,(scope.lastScanMs ?: scope.sinceMs) - 5 * 60_000)
            var scanned = 0
            context.contentResolver.query(Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms._ID,Telephony.Sms.ADDRESS,Telephony.Sms.DATE),
                "${Telephony.Sms.DATE} >= ?",arrayOf(since.toString()),
                "${Telephony.Sms.DATE} DESC")?.use { cursor ->
                while (scanned < 5_000 && cursor.moveToNext()) {
                    if (!SmsRoleRuntime.canRead(context)) { partial = true; break }
                    scanned++
                    if (normalize(cursor.getString(1).orEmpty()) != normalize(scope.address)) continue
                    if (captureSms(cursor.getLong(0),session)) sms++
                }
                if (scanned == 5_000 && !cursor.isAfterLast) partial = true
            } ?: run { partial = true }
            scanned = 0
            context.contentResolver.query(Telephony.Mms.CONTENT_URI,
                arrayOf(Telephony.Mms._ID,Telephony.Mms.DATE),
                "${Telephony.Mms.DATE} >= ?",arrayOf((since / 1000).toString()),
                "${Telephony.Mms.DATE} DESC")?.use { cursor ->
                while (scanned < 1_000 && cursor.moveToNext()) {
                    if (!SmsRoleRuntime.canRead(context)) { partial = true; break }
                    scanned++
                    val id = cursor.getLong(0)
                    val addresses = mutableListOf<String>()
                    context.contentResolver.query(Uri.parse("content://mms/$id/addr"),
                        arrayOf("address"),null,null,null)?.use { addr ->
                        while (addr.moveToNext()) addresses.add(addr.getString(0).orEmpty())
                    }
                    if (addresses.none { normalize(it) == normalize(scope.address) }) continue
                    try { if (captureMms(id,session)) mms++ }
                    catch (_: Exception) { partial = true }
                }
                if (scanned == 1_000 && !cursor.isAfterLast) partial = true
            } ?: run { partial = true }
            val values = ContentValues().apply {
                put("coverage",if (partial) "partial" else "complete")
                if (!partial) put("last_scan_ms",System.currentTimeMillis())
            }
            db.update("scopes",values,"scope_key=? AND generation=? AND state='selected'",
                arrayOf(scope.key,scope.generation.toString()))
        }
        return SmsBusinessScan(sms,mms,partial)
    }

    fun observationCount(session: UploadSession): Int = db.rawQuery("""SELECT COUNT(*)
        FROM observations o JOIN scopes s ON s.scope_key=o.scope_key
        WHERE s.tenant_id=? AND s.user_id=? AND s.device_id=?
        AND o.state='local_policy_gated'""",arrayOf(session.tenantId,session.userId,
        session.deviceId)).use { if (it.moveToFirst()) it.getInt(0) else 0 }
}
