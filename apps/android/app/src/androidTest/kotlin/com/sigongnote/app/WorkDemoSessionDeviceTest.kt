package com.sigongnote.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Opt-in only: `adb shell am instrument -w -e keepDemoSession true -e class
 * com.sigongnote.app.WorkDemoSessionDeviceTest#keepSyntheticSessionForManualCheck ...` run on its own.
 * Stores the synthetic lab session in the isolated test app so a person can open "시공노트 새화면(시험)"
 * and try the new screen by hand. Never runs in an ordinary pass and never touches the owner's app.
 */
@RunWith(AndroidJUnit4::class)
class WorkDemoSessionDeviceTest {
    @Test fun keepSyntheticSessionForManualCheck() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("keepDemoSession") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "com.sigongnote.app.devtest")
        try {
            val raw = context.openFileInput("work-fixture-session.json").bufferedReader().use { it.readText() }
            val session = UploadSession.decode(raw, true)
            val loopback = Regex("""^http://127\.0\.0\.1:\d+/?$""")
            check(listOf(session.apiBaseUrl, session.supabaseOrigin, session.storageOrigin).all { loopback.matches(it) })
            TokenVault(context).store(raw)
        } finally {
            context.deleteFile("work-fixture-session.json")
        }
    }
}
