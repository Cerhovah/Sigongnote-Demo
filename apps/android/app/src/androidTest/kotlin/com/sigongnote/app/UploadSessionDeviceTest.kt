package com.sigongnote.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UploadSessionDeviceTest {
    @Test fun nativeVaultBindsSessionAndErasesPendingCredentialsOnLogout() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = TokenVault(context)
        val capture = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val session = UploadSession("http://127.0.0.1:3001","http://127.0.0.1:54321",
            "http://127.0.0.1:54321",
            "fixture-publishable","fixture-token","fixture-refresh",Long.MAX_VALUE,
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",1,1)
        try {
            vault.store(session.encode())
            vault.storeProgress(capture,"fixture-signed-location")
            assertEquals(session,UploadSession.decode(vault.read()!!,true))
            assertEquals("fixture-signed-location",vault.readProgress(capture))
            val raw = context.getSharedPreferences("native_credentials",0).all.values
                .joinToString(" ")
            assertFalse(raw.contains("fixture-token"))
            assertFalse(raw.contains("fixture-signed-location"))
            vault.store(session.copy(accessToken = "rotated-token").encode())
            assertEquals("fixture-signed-location",vault.readProgress(capture))
            vault.clearSession()
            assertNull(vault.read())
            assertEquals("fixture-signed-location",vault.readProgress(capture))
            vault.store(session.encode())
            assertEquals("fixture-signed-location",vault.readProgress(capture))
            vault.store(session.copy(userId = "55555555-5555-4555-8555-555555555555").encode())
            assertNull(vault.readProgress(capture))
            val attempt = UploadAttempt.fresh().copy(location="fixture-signed-location")
            vault.storeProgress(capture,attempt.encode())
            vault.logout()
            assertNull(vault.read())
            val after = UploadAttempt.decode(vault.readProgress(capture)!!)
            assertEquals(attempt.prepareKey,after.prepareKey)
            assertNull(after.location)
            assertThrows(IllegalStateException::class.java) {
                vault.storeProgress(capture,attempt.encode())
            }
        } finally { vault.clear() }
        assertNull(vault.read())
        assertNull(vault.readProgress(capture))
    }
}
