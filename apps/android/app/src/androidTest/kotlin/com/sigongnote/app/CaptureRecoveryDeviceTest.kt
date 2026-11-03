package com.sigongnote.app

import android.system.ErrnoException
import android.system.OsConstants
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.IOException
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** The host runs seed, force-stop/idle/offline, then verify with one fixture ID. */
@RunWith(AndroidJUnit4::class)
class CaptureRecoveryDeviceTest {
    @Test fun queuedFixtureSurvivesProcessRestart() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val id = arguments.getString("c13FixtureId") ?: UUID.randomUUID().toString()
        val mode = arguments.getString("c13Mode") ?: "local"
        val context = instrumentation.targetContext
        val database = (context.applicationContext as SigongnoteApp).queue
        val queue = database.queueDao()
        if (mode == "cleanup") {
            database.openHelper.writableDatabase.execSQL(
                "DELETE FROM capture_queue WHERE captureId = ? AND state = 'paused_logout'",
                arrayOf(id))
            assertNull(queue.get(id))
            return
        }
        if (mode != "verify") {
            queue.insertIfAbsent(CaptureQueueItem(id,id,id,id,id,1,"paused_logout",
                null,null,null,System.currentTimeMillis(),System.currentTimeMillis()))
        }
        val observed = queue.get(id)
        assertNotNull("local queue row must survive force-stop",observed)
        assertEquals("paused_logout",observed?.state)
        assertEquals(id,observed?.captureId)
        if (mode == "local") {
            database.openHelper.writableDatabase.execSQL(
                "DELETE FROM capture_queue WHERE captureId = ? AND state = 'paused_logout'",
                arrayOf(id))
        }
        if (mode == "verify") {
            val airplane = android.provider.Settings.Global.getInt(context.contentResolver,
                android.provider.Settings.Global.AIRPLANE_MODE_ON,0)
            if (arguments.getString("c13ExpectOffline") == "true") {
                assertEquals(1,airplane)
                val manager = context.getSystemService(ConnectivityManager::class.java)
                val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
                assertFalse(capabilities?.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
            }
        }
    }

    @Test fun noSpaceIsClassifiedWithoutConfusingOtherIoFailures() {
        assertTrue(ShareStorageFailure.isNoSpace(IOException("synthetic",
            ErrnoException("write",OsConstants.ENOSPC))))
        assertFalse(ShareStorageFailure.isNoSpace(IOException("synthetic")))
    }
}
