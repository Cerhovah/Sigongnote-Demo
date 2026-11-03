package com.sigongnote.app

import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic emulator UI only. Never grants roles, sends SMS, or touches a physical phone. */
@RunWith(AndroidJUnit4::class)
class SmsFocusDeviceTest {
    private fun views(root: View): List<View> = listOf(root) +
        if(root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun visible(activity: android.app.Activity) = views(activity.window.decorView).filter { it.isShown }
    private fun tap(activity: android.app.Activity, label: String) {
        val button=visible(activity).filterIsInstance<Button>().single { it.text.toString()==label }
        assertTrue(button.height >= (48 * activity.resources.displayMetrics.density).toInt())
        button.performClick()
    }
    private fun step(scenario: ActivityScenario<SmsRoleActivity>, action: (SmsRoleActivity) -> Unit) {
        val laidOut=java.util.concurrent.CountDownLatch(1)
        scenario.onActivity { activity -> action(activity);activity.window.decorView.postOnAnimation { activity.window.decorView.post { laidOut.countDown() } } }
        assertTrue(laidOut.await(3,java.util.concurrent.TimeUnit.SECONDS))
    }
    @Test fun inboxComposerSettingsAndDraftRecoveryStaySeparate() {
        assumeTrue(Build.HARDWARE in setOf("ranchu","goldfish"))
        ActivityScenario.launch(SmsRoleActivity::class.java).use { scenario ->
            step(scenario) { activity ->
                assertEquals(0,visible(activity).filterIsInstance<EditText>().size)
                tap(activity,"새 문자")
                val fields=visible(activity).filterIsInstance<EditText>()
                assertEquals(2,fields.size)
                fields[0].setText("000");fields[1].setText("fixture unsent draft")
            }
            scenario.recreate()
            step(scenario) { activity ->
                val fields=visible(activity).filterIsInstance<EditText>()
                assertEquals("000",fields[0].text.toString())
                assertEquals("fixture unsent draft",fields[1].text.toString())
                tap(activity,"← 문자함")
            }
            step(scenario) { activity ->
                assertEquals(0,visible(activity).filterIsInstance<EditText>().size)
                tap(activity,"설정·도움말")
            }
            step(scenario) { activity ->
                tap(activity,"사용법")
            }
            step(scenario) { activity ->
                assertTrue(visible(activity).filterIsInstance<android.widget.TextView>().any { it.text.contains("사진 문자 받기는 아직 확인 중") })
                tap(activity,"문자함 보기")
            }
        }
    }
    @Test fun permissionScreenHasOneNextActionAndAnExitWithoutOpeningOsPrompts() {
        assumeTrue(Build.HARDWARE in setOf("ranchu","goldfish"))
        ActivityScenario.launch(SmsPermissionActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertEquals(3,visible(activity).filterIsInstance<Button>().size)
                assertTrue(visible(activity).filterIsInstance<android.widget.TextView>().any { it.text.contains("문자 원문은 서버로 보내지 않아요") })
                tap(activity,"나중에 할게요")
            }
        }
    }
}
