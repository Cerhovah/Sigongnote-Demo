package com.sigongnote.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class IdentityLinkDeviceTest {
    @Test fun encryptedLinkFlowSurvivesVaultRecreationAndRejectsReplay() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName=="com.sigongnote.app.devtest")
        val vault=TokenVault(context)
        val target=IdentityLinkTarget("https://api.example.test","https://auth.example.test","fixture-user","fixture-company","fixture-device",1)
        val flow=GoogleLoginFlow.create(provider="custom:naver").copy(linkTarget=target)
        try {
            vault.saveLoginFlow(flow);assertTrue(vault.hasPendingIdentityLink())
            val raw=context.getSharedPreferences("native_credentials",0).all.values.joinToString(" ")
            assertFalse(raw.contains(flow.verifier));assertFalse(raw.contains("fixture-user"))
            val callback="${context.packageName}.auth://callback"
            val returned="$callback?state=${flow.state}&code=fixture-code"
            val restored=TokenVault(context).consumeLoginFlow(returned,callback)
            assertFalse(vault.hasPendingIdentityLink());assertEquals(flow,restored.first);assertEquals("fixture-code",restored.second)
            assertThrows(IllegalArgumentException::class.java) {vault.consumeLoginFlow(returned,callback)}
        } finally {vault.clear()}
    }
    @Test fun logoutPreventsCredentialReplacementAndClearsWorkspaceDraft() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName=="com.sigongnote.app.devtest")
        val vault=TokenVault(context)
        try {
            vault.store("fixture-session")
            val login=AccountLogin("a","r","fixture-user",Long.MAX_VALUE)
            vault.workspaceDraft(login,"https://api.example.test","fixture-company")
            vault.logout()
            assertFalse(vault.replaceIfUnchanged("fixture-session","replacement"))
            assertNull(vault.read());assertFalse(vault.hasWorkspaceDraft(login,"https://api.example.test"))
        } finally {vault.clear()}
    }
}
