package com.sigongnote.app
import android.content.Intent
import android.webkit.WebView
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkScreenDeviceTest {
    @Test fun largeTextConnectionsKeepControlsReachable(){
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        check(context.packageName=="com.sigongnote.app.devtest")
        val raw=context.openFileInput("work-fixture-session.json").bufferedReader().use{it.readText()}
        check(Regex("""^http://127\.0\.0\.1:\d+/$""").matches(UploadSession.decode(raw,true).apiBaseUrl))
        val vault=TokenVault(context);check(vault.read()==null){"Preserve an existing test-app account"};vault.store(raw)
        val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        fun web(root:android.view.View):WebView? {if(root is WebView)return root;if(root is ViewGroup)for(i in 0 until root.childCount){web(root.getChildAt(i))?.let{return it}};return null}
        fun js(script:String):String {val latch=CountDownLatch(1);var value="";instrumentation.runOnMainSync{web(activity.window.decorView)!!.evaluateJavascript(script){value=it;latch.countDown()}};check(latch.await(5,TimeUnit.SECONDS));return value}
        try {
            var ready=false;repeat(100){if(!ready){Thread.sleep(200);ready=js("Boolean(document.querySelector('#today-next'))")=="true"}}
            assertTrue(ready)
            InstrumentationRegistry.getArguments().getString("expectedViewportWidth")?.let{expected->
                assertEquals("Native CSS viewport must match the requested verification width",expected,js("innerWidth"))
            }
            instrumentation.runOnMainSync{web(activity.window.decorView)!!.settings.textZoom=200}
            Thread.sleep(300)
            js("location.hash='#/more'");Thread.sleep(500)
            assertEquals("Current settings must offer the real connection entry", "true",js("(()=>{let b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='자료 연결');if(!b)return false;b.click();return true})()"))
            var connected=false;repeat(50){if(!connected){Thread.sleep(100);connected=js("Boolean(document.querySelector('.setup-layout h1')?.textContent==='자료 연결')")=="true"}};assertTrue("Connection screen must open from settings",connected)
            assertEquals("Connection screen must fit at 200% text zoom", "true",js("document.documentElement.scrollWidth<=innerWidth+1"))
            assertEquals("Native photo action must remain available", "true",js("Array.from(document.querySelectorAll('.connection-actions button')).some(b=>b.textContent==='사진 찍기'&&!b.disabled)"))
            assertEquals("Optional collection connections must open", "true",js("(()=>{let d=document.querySelector('.connection-actions details');if(!d)return false;d.querySelector('summary').click();return d.open})()"))
            for(label in listOf("사진 폴더","통화 녹음")){
                assertEquals("The $label action must exist", "true",js("(()=>{let b=Array.from(document.querySelectorAll('.connection-actions button')).find(b=>b.textContent==='$label');if(!b)return false;b.scrollIntoView({block:'center'});return !b.disabled})()"))
                Thread.sleep(200)
                assertEquals("$label must stay reachable at 200% text zoom", "true",js("(()=>{let b=Array.from(document.querySelectorAll('.connection-actions button')).find(b=>b.textContent==='$label'),r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1&&b.scrollWidth<=b.clientWidth+1})()"))
            }
            instrumentation.uiAutomation.takeScreenshot().let{screenshot->java.io.File(context.getExternalFilesDir(null),"work-connections-200.png").outputStream().use{screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}}
            assertEquals("Back action must return from connection setup", "true",js("(()=>{let b=document.querySelector('.setup-layout .screen-back');if(!b)b=Array.from(document.querySelectorAll('.setup-layout button')).find(b=>b.textContent.includes('뒤로'));if(!b)return false;b.click();return true})()"))
            var returned=false;repeat(50){if(!returned){Thread.sleep(100);returned=js("Boolean(document.querySelector('.settings'))")=="true"}};assertTrue("Settings remain reachable after connection review",returned)
        } finally {instrumentation.runOnMainSync{web(activity.window.decorView)?.settings?.textZoom=100;activity.finish()};vault.clear()}
    }
    @Test fun firstRunOpensWorkAndShareStillOpensNativeSourceSetup(){
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        check(context.packageName=="com.sigongnote.app.devtest");val vault=TokenVault(context);check(vault.read()==null){"Preserve an existing test-app account"}
        val raw=context.openFileInput("work-fixture-session.json").bufferedReader().use{it.readText()}
        for(action in listOf(Intent.ACTION_MAIN,Intent.ACTION_SEND,"sms-setup")){
            if(action!=Intent.ACTION_MAIN)vault.store(raw)
            val intent=Intent(context,MainActivity::class.java).setAction(if(action=="sms-setup")Intent.ACTION_MAIN else action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if(action=="sms-setup")intent.putExtra("request_sms_setup",true)
            // This test covers setup routing; content-copy behavior has its own native tests.
            if(action==Intent.ACTION_SEND)intent.setType("text/plain")
            val activity=instrumentation.startActivitySync(intent)
            try{
                val expectedPage="${BridgePolicy.trustedOrigin}/assets/"+if(action==Intent.ACTION_MAIN)"work/index.html" else "index.html"
                var url="";val deadline=System.currentTimeMillis()+15_000
                while(url!=expectedPage&&System.currentTimeMillis()<deadline){Thread.sleep(100);instrumentation.runOnMainSync{val root=activity.window.decorView as ViewGroup
                    fun find(view:android.view.View):WebView? {if(view is WebView)return view;if(view is ViewGroup)for(i in 0 until view.childCount){find(view.getChildAt(i))?.let{return it}};return null}
                    url=find(root)?.url.orEmpty().substringBefore('#')}}
                assertEquals("Current entry page must load for $action within 15s",expectedPage,url)
            }finally{instrumentation.runOnMainSync{activity.finish()};vault.clear()}
        }
    }
    @Test fun sharedReactReadsTheSameActualWorkerResult(){
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        check(context.packageName=="com.sigongnote.app.devtest")
        val raw=context.openFileInput("work-fixture-session.json").bufferedReader().use{it.readText()}
        val session=UploadSession.decode(raw,true);check(Regex("""^http://127\.0\.0\.1:\d+/$""").matches(session.apiBaseUrl))
        // Fixture-only metadata is excluded from the product UploadSession model.
        val delivery=org.json.JSONObject(raw).getJSONObject("fixtureEvidence").getJSONObject("delivery")
        val deliveryRevisionId=delivery.getString("revisionId");check(java.util.UUID.fromString(deliveryRevisionId).toString()==deliveryRevisionId)
        val deliveryTitle=org.json.JSONObject.quote(delivery.getString("title"))
        val vault=TokenVault(context);check(vault.read()==null){"Preserve an existing test-app account"};vault.store(raw)
        val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        fun web(root:android.view.View):WebView? {if(root is WebView)return root;if(root is ViewGroup)for(i in 0 until root.childCount){val found=web(root.getChildAt(i));if(found!=null)return found};return null}
        fun js(script:String):String {val latch=CountDownLatch(1);var value="";instrumentation.runOnMainSync{web(activity.window.decorView)!!.evaluateJavascript(script){value=it;latch.countDown()}};check(latch.await(5,TimeUnit.SECONDS));return value}
        // One screen per task: each step opens its own address, then waits for that screen's content.
        fun wait(script:String,needle:String,tries:Int=50):String{var value="";repeat(tries){if(!value.contains(needle)){Thread.sleep(200);value=js(script)}};return value}
        fun go(hash:String){js("location.hash='$hash'");Thread.sleep(300)}
        fun ask(request:String){go("#/ask");assertTrue(wait("String(Boolean(document.querySelector('#work-chat-input')))","true").contains("true"));assertEquals("Fixture request must select the real site", "true",js("(()=>{let s=document.querySelector('.ask-site select'),o=Array.from(s.options).find(o=>o.textContent==='합성 햇살현장');if(!o)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value);s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"));Thread.sleep(200);js("var t=document.querySelector('#work-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'$request');t.dispatchEvent(new Event('input',{bubbles:true}))");Thread.sleep(200);js("document.querySelector('form.ask').requestSubmit()")}
        try{
            assertTrue("Current work screen must reach the real agenda",wait("String(Boolean(document.querySelector('#today-next')))","true",100).contains("true"))
            instrumentation.runOnMainSync{web(activity.window.decorView)!!.settings.textZoom=100}
            Thread.sleep(300)
            instrumentation.uiAutomation.takeScreenshot().let { screenshot ->
                java.io.File(context.getExternalFilesDir(null),"work-today.png").outputStream().use {screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
            }
            go("#/materials/list")
            var text=wait("document.body.innerText","내용을 읽었어요",100)
            assertTrue(text.contains("합성 햇살현장"));assertTrue(text.contains("내용을 읽었어요"));assertFalse(text.contains(session.accessToken))
            go("#/more/status")
            text=wait("document.body.innerText","실제 청구 비용은 아직 정산되지")
            assertTrue(text.contains("실제 청구 비용은 아직 정산되지"))
            // Current agent requests carry an explicit site. Assert actionable evidence, not legacy adapter wording.
            ask("합성 햇살현장 석고보드 찾아줘")
            text=wait("String(Boolean(document.querySelector('.ask-result[aria-busy=false] .item')))","true",450)
            assertTrue("Current API must return completed evidence cards",text.contains("true"))
            val deliverySelector="Array.from(document.querySelectorAll('.ask-result .item')).find(b=>b.querySelector('strong')?.textContent===$deliveryTitle)"
            assertEquals("Expected the synthetic delivery content in: "+js("document.querySelector('.ask-result')?.innerText"), "true", js("(()=>{let b=$deliverySelector;if(!b)return false;b.click();return true})()"))
            val actualRoute=org.json.JSONTokener(wait("location.hash",deliveryRevisionId)).nextValue()
            assertEquals("SN_DIAG:materials.detail:REVISION_ROUTE_MISMATCH", "#/materials/item/$deliveryRevisionId",actualRoute)
            text=wait("document.querySelector('.work-spans')?.innerText??''","석고보드 12개")
            assertTrue("Expected synthetic delivery content; actual screen: "+js("document.body.innerText"),text.contains("석고보드 12개"))
            ask("합성 햇살현장 주방 보수 견적서 준비해줘")
            assertTrue("Current agent must prepare the requested fixture document",wait("document.body.innerText","문서 확인하기",450).contains("문서 확인하기"))
            js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='문서 확인하기')?.click()")
            text=wait("document.querySelector('.work-draft')?.innerText??''","1,375,000")
            assertTrue(text.contains("1,375,000"));assertTrue(text.contains("아직 발행하지"))
            js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='이 내용으로 발행하러 가기')?.click()")
            assertTrue("Issue confirmation must open: "+js("document.body.innerText"),wait("String(Boolean(document.querySelector('.work-issue form')))","true").contains("true"))
            assertEquals("Fixture recipient must be supplied before issue", "true",js("Boolean(document.querySelector('.work-issue input')?.value.trim())"))
            // Reusing an already-issued draft must conflict. Create this run's new recipient revision
            // through the real form and review it again, preserving all earlier fixture documents.
            val recipient="합성 검증처 N31-"+System.currentTimeMillis()
            js("var input=document.querySelector('.work-issue input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'$recipient');input.dispatchEvent(new Event('input',{bubbles:true}))")
            Thread.sleep(200)
            js("document.querySelector('.work-issue form').requestSubmit()")
            assertTrue("Recipient edit must return to the revised draft",wait("document.querySelector('.doc-parties')?.innerText??''",recipient).contains(recipient))
            js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='이 내용으로 발행하러 가기')?.click()")
            assertTrue(wait("String(Boolean(document.querySelector('.work-issue form')))","true").contains("true"))
            js("document.querySelector('.work-issue form').requestSubmit()")
            text=wait("document.querySelector('.work-issued')?.innerText??''","준비 완료",450)
            assertTrue("Actual fixture render worker must finish: "+js("document.body.innerText"),text.contains("PDF·엑셀 준비 완료"));assertTrue(text.contains("1,375,000"))
            go("#/documents");wait("document.body.innerText","견적서")
            Thread.sleep(300)
            instrumentation.uiAutomation.takeScreenshot().let { screenshot ->
                java.io.File(context.getExternalFilesDir(null),"work-android.png").outputStream().use {screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
            }
        }finally{instrumentation.runOnMainSync{activity.finish()};vault.clear()}
    }
    @Test fun audioAndMessageEvidenceMatchCurrentApi(){
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        check(context.packageName=="com.sigongnote.app.devtest")
        val raw=context.openFileInput("work-fixture-session.json").bufferedReader().use{it.readText()}
        check(Regex("""^http://127\.0\.0\.1:\d+/$""").matches(UploadSession.decode(raw,true).apiBaseUrl))
        val vault=TokenVault(context);check(vault.read()==null){"Preserve an existing test-app account"};vault.store(raw)
        val activity=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        fun web(root:android.view.View):WebView? {if(root is WebView)return root;if(root is ViewGroup)for(i in 0 until root.childCount){web(root.getChildAt(i))?.let{return it}};return null}
        fun js(script:String):String {val latch=CountDownLatch(1);var value="";instrumentation.runOnMainSync{web(activity.window.decorView)!!.evaluateJavascript(script){value=it;latch.countDown()}};check(latch.await(5,TimeUnit.SECONDS));return value}
        fun wait(script:String,needle:String,tries:Int=100):String{var value="";repeat(tries){if(!value.contains(needle)){Thread.sleep(200);value=js(script)}};return value}
        fun go(hash:String){js("location.hash='$hash'");Thread.sleep(300)}
        try{
            assertTrue("Current work screen must open before reading evidence",wait("String(Boolean(document.querySelector('#today-next')))","true").contains("true"))
            go("#/materials/list");wait("document.body.innerText","녹음 체험")
            js("Array.from(document.querySelectorAll('.materials-list .item')).find(b=>b.textContent.includes('녹음 체험'))?.click()")
            var text=wait("document.querySelector('.audio-transcript')?.innerText??''","원음 0:02")
            assertTrue("Expected timestamped synthetic audio; actual screen: "+js("document.body.innerText"),text.contains("원음 0:02"));assertTrue("Synthetic provider must be labelled: $text",text.contains("모의 전사"))
            go("#/materials/list");wait("document.body.innerText","문자 납품 확인")
            js("Array.from(document.querySelectorAll('.materials-list .item')).find(b=>b.textContent.includes('문자 납품 확인'))?.click()")
            text=wait("document.body.innerText","문자·첨부사진 함께 보기")
            assertTrue(text.contains("문자·첨부사진 함께 보기"))
            js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='문자·첨부사진 함께 보기')?.click()")
            text=wait("document.body.innerText","첨부 1개를 읽지 못했습니다")
            assertTrue(text.contains("첨부 1개를 읽지 못했습니다"))
            go("#/documents");wait("document.body.innerText","견적서")
            Thread.sleep(300)
            val screenshot=instrumentation.uiAutomation.takeScreenshot()
            java.io.File(context.getExternalFilesDir(null),"work-android.png").outputStream().use {screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
        }finally{instrumentation.runOnMainSync{activity.finish()};vault.clear()}
    }
}
