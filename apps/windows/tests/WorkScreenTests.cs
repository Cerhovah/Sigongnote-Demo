using System.Text.Json;
using System.Runtime.ExceptionServices;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;
namespace Sigongnote.Windows.Tests;
[TestClass]
public sealed class WorkScreenTests
{
    private sealed class DelayedWorkHandler : HttpMessageHandler {
        public readonly TaskCompletionSource Started=new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation){
            Started.TrySetResult();await Task.Delay(200,cancellation);
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK){Content=new StringContent("{}")};
        }
    }
    [TestMethod]
    public void ClosingDuringWorkRequestDoesNotCrashTray(){
        Exception? failure=null;
        var thread=new Thread(()=>{
            var vault=new WindowsTokenVault(Path.Combine(Path.GetTempPath(),"sigongnote-close-"+Guid.NewGuid()));
            var session=new WindowsSession("https://api.example.test/","https://auth.example.test/","public","access","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());vault.Save(JsonSerializer.Serialize(session));
            using var handler=new DelayedWorkHandler();using var manager=new WindowsSessionManager(vault,handler);
            using var form=new WindowsWorkForm(manager,()=>{});using var context=new ApplicationContext();
            using var afterClose=new System.Windows.Forms.Timer{Interval=500};afterClose.Tick+=(_,_)=>context.ExitThread();
            ThreadExceptionEventHandler exception=(_,e)=>{failure=e.Exception;context.ExitThread();};Application.ThreadException+=exception;
            form.ShowInTaskbar=false;form.StartPosition=FormStartPosition.Manual;form.Location=new System.Drawing.Point(-3000,0);
            form.FormClosed+=(_,_)=>afterClose.Start();
            form.Shown+=async(_,_)=>{try{await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(15));form.Close();}catch(Exception e){failure=e;form.Close();}};
            try{form.Show();Application.Run(context);}finally{Application.ThreadException-=exception;vault.Clear();}
        });
        thread.SetApartmentState(ApartmentState.STA);thread.Start();Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(25)),"Close regression timed out");
        if(failure is not null)ExceptionDispatchInfo.Capture(failure).Throw();
    }
    [TestMethod]
    public void SharedReactReadsActualFixtureWorkerResultInWebView2()
    {
        var input=Environment.GetEnvironmentVariable("SIGONGNOTE_WORK_FIXTURE");
        if(string.IsNullOrEmpty(input)){Assert.Inconclusive("Start isolated work preview and set SIGONGNOTE_WORK_FIXTURE");return;}
        using var json=JsonDocument.Parse(File.ReadAllText(input));var r=json.RootElement;
        string Value(string key)=>r.GetProperty(key).GetString()!;
        StringAssert.Matches(Value("apiBaseUrl"),new System.Text.RegularExpressions.Regex(@"^http://127\.0\.0\.1:\d+/$"),"Synthetic lab API must stay on this PC");
        var delivery=r.GetProperty("fixtureEvidence").GetProperty("delivery");
        var deliveryRevisionId=delivery.GetProperty("revisionId").GetString()!;
        Assert.AreEqual(Guid.Parse(deliveryRevisionId).ToString("D"),deliveryRevisionId,"Fixture delivery revision must be canonical");
        var deliveryTitle=JsonSerializer.Serialize(delivery.GetProperty("title").GetString()!);
        var session=new WindowsSession(Value("apiBaseUrl"),Value("supabaseOrigin"),Value("publishableKey"),Value("accessToken"),Value("refreshToken"),r.GetProperty("expiresAtEpochMs").GetInt64(),Guid.Parse(Value("tenantId")),Guid.Parse(Value("userId")),Guid.Parse(Value("deviceId")));
        Exception? failure=null;
        var thread=new Thread(()=>{
            var vault=new WindowsTokenVault(Path.Combine(Path.GetTempPath(),"sigongnote-screen-"+Guid.NewGuid()));
            vault.Save(JsonSerializer.Serialize(session));
            using var manager=new WindowsSessionManager(vault);using var form=new WindowsWorkForm(manager,()=>{});
            form.ShowInTaskbar=false;form.StartPosition=FormStartPosition.Manual;form.Location=new System.Drawing.Point(-3000,0);
            form.Shown+=async(_,_)=>{
                try{
                    var view=form.Controls.OfType<WebView2>().Single();string text="";
                    for(var i=0;i<100&&view.CoreWebView2 is null;i++)await Task.Delay(200);
                    var core=view.CoreWebView2??throw new InvalidOperationException("WebView unavailable");
                    // One screen per task: each step opens its own address, then waits for that screen's content.
                    async Task<string> Wait(string script,string needle,int tries=50){var value="";for(var i=0;i<tries&&!value.Contains(needle);i++){await Task.Delay(200);value=await core.ExecuteScriptAsync(script);}return value;}
                    async Task Go(string hash){await core.ExecuteScriptAsync($"location.hash='{hash}'");await Task.Delay(300);}
                    async Task Ask(string request){
                        await Go("#/ask");
                        if(!(await Wait("String(Boolean(document.querySelector('#work-chat-input')))","true")).Contains("true"))throw new InvalidOperationException("Request input did not open");
                        var selected=await core.ExecuteScriptAsync("(()=>{let s=document.querySelector('.ask-site select'),o=s&&Array.from(s.options).find(o=>o.textContent==='합성 햇살현장');if(!o)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value);s.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
                        if(selected!="true")throw new InvalidOperationException("Fixture request did not select the real site");
                        await Task.Delay(200);
                        await core.ExecuteScriptAsync($"var t=document.querySelector('#work-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'{request}');t.dispatchEvent(new Event('input',{{bubbles:true}}))");
                        await Task.Delay(200);await core.ExecuteScriptAsync("document.querySelector('form.ask').requestSubmit()");
                    }
                    await Go("#/materials/list");
                    text=await Wait("document.body.innerText","내용을 읽었어요",100);
                    if(!text.Contains("합성 햇살현장")||!text.Contains("내용을 읽었어요")||text.Contains(session.AccessToken))throw new InvalidOperationException("Shared work content did not appear: "+text[..Math.Min(400,text.Length)]);
                    // Current durable agent requests carry a site and finish with actionable evidence cards.
                    await Ask("합성 햇살현장 석고보드 찾아줘");
                    text=await Wait("String(Boolean(document.querySelector('.ask-result[aria-busy=false] .item')))","true",450);
                    if(!text.Contains("true"))throw new InvalidOperationException("Current API did not return completed evidence cards");
                    var legacyCandidate=JsonSerializer.Deserialize<string>(await core.ExecuteScriptAsync("Array.from(document.querySelectorAll('.ask-result .item')).find(b=>b.textContent.includes('석고보드 12개')||b.querySelector('strong')?.textContent.startsWith('합성 햇살현장 납품 '))?.querySelector('strong')?.textContent??''"));
                    Console.WriteLine($"SN_DIAG:materials.detail:legacy_candidate_is_delivery={legacyCandidate==delivery.GetProperty("title").GetString()};legacy_candidate_is_audio={legacyCandidate=="합성 햇살현장 납품 녹음 체험"}");
                    var opened=await core.ExecuteScriptAsync($"(()=>{{let b=Array.from(document.querySelectorAll('.ask-result .item')).find(b=>b.querySelector('strong')?.textContent==={deliveryTitle});if(!b)return false;b.click();return true}})()");
                    if(opened!="true")throw new InvalidOperationException("Conversation did not find the synthetic delivery evidence");
                    var openedRoute=JsonSerializer.Deserialize<string>(await Wait("location.hash",deliveryRevisionId));
                    if(openedRoute!=$"#/materials/item/{deliveryRevisionId}")throw new InvalidOperationException("SN_DIAG:materials.detail:REVISION_ROUTE_MISMATCH");
                    Console.WriteLine($"SN_DIAG:materials.detail:clicked_id={deliveryRevisionId};route={openedRoute}");
                    text=await Wait("document.querySelector('.work-spans')?.innerText??''","석고보드 12개");
                    if(!text.Contains("석고보드 12개"))throw new InvalidOperationException("Parsed detail did not appear");
                    await Ask("합성 햇살현장 주방 보수 견적서 준비해줘");
                    text=await Wait("document.body.innerText","문서 확인하기",450);
                    if(!text.Contains("문서 확인하기"))throw new InvalidOperationException("Current agent did not prepare the requested fixture document");
                    await core.ExecuteScriptAsync("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='문서 확인하기')?.click()");
                    text=await Wait("document.querySelector('.work-draft')?.innerText??''","1,375,000");
                    if(!text.Contains("1,375,000")||!text.Contains("아직 발행하지"))throw new InvalidOperationException("Sourced document draft did not appear");
                    await core.ExecuteScriptAsync("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='이 내용으로 발행하러 가기')?.click()");
                    if(!(await Wait("String(Boolean(document.querySelector('.work-issue form')))","true")).Contains("true"))throw new InvalidOperationException("Issue confirmation did not open");
                    if(await core.ExecuteScriptAsync("Boolean(document.querySelector('.work-issue input')?.value.trim())")!="true")throw new InvalidOperationException("Fixture recipient was not supplied");
                    // Reusing an issued revision must conflict: create this run's recipient revision through the form.
                    var recipient="합성 검증처 N31-"+Guid.NewGuid().ToString("N");
                    await core.ExecuteScriptAsync($"var input=document.querySelector('.work-issue input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'{recipient}');input.dispatchEvent(new Event('input',{{bubbles:true}}))");
                    await Task.Delay(200);
                    await core.ExecuteScriptAsync("document.querySelector('.work-issue form').requestSubmit()");
                    if(!(await Wait("document.querySelector('.doc-parties')?.innerText??''",recipient)).Contains(recipient))throw new InvalidOperationException("Recipient edit did not reopen the revised draft");
                    await core.ExecuteScriptAsync("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='이 내용으로 발행하러 가기')?.click()");
                    if(!(await Wait("String(Boolean(document.querySelector('.work-issue form')))","true")).Contains("true"))throw new InvalidOperationException("Revised issue confirmation did not open");
                    await core.ExecuteScriptAsync("document.querySelector('.work-issue form').requestSubmit()");
                    text=await Wait("document.querySelector('.work-issued')?.innerText??''","준비 완료",450);
                    if(!text.Contains("PDF·엑셀 준비 완료")||!text.Contains("1,375,000"))throw new InvalidOperationException("Issued document did not render");
                    await Go("#/materials/list");await Wait("document.body.innerText","녹음 체험");
                    await core.ExecuteScriptAsync("Array.from(document.querySelectorAll('.materials-list .item')).find(b=>b.textContent.includes('녹음 체험'))?.click()");
                    text=await Wait("document.querySelector('.audio-transcript')?.innerText??''","원음 0:02");
                    if(!text.Contains("원음 0:02")||!text.Contains("모의 전사"))throw new InvalidOperationException("Timed synthetic audio did not appear");
                    await Go("#/materials/list");await Wait("document.body.innerText","문자 납품 확인");
                    await core.ExecuteScriptAsync("Array.from(document.querySelectorAll('.materials-list .item')).find(b=>b.textContent.includes('문자 납품 확인'))?.click()");
                    text=await Wait("document.body.innerText","문자·첨부사진 함께 보기");
                    if(!text.Contains("문자·첨부사진 함께 보기"))throw new InvalidOperationException("Message detail missing");
                    await core.ExecuteScriptAsync("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='문자·첨부사진 함께 보기')?.click()");
                    text=await Wait("document.body.innerText","첨부 1개를 읽지 못했습니다");
                    if(!text.Contains("첨부 1개를 읽지 못했습니다"))throw new InvalidOperationException("Message attachment/coverage missing");
                    await Go("#/more/status");
                    text=await Wait("document.body.innerText","실제 청구 비용은 아직 정산되지");
                    if(!text.Contains("실제 청구 비용은 아직 정산되지"))throw new InvalidOperationException("Maintenance status missing");
                    await Go("#/documents");await Wait("document.body.innerText","견적서");
                    await Task.Delay(300);
                    var output=Environment.GetEnvironmentVariable("SIGONGNOTE_UI_EVIDENCE");if(!string.IsNullOrEmpty(output)){Directory.CreateDirectory(output);using var file=File.Create(Path.Combine(output,"work-windows.png"));await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,file);}
                }catch(Exception error){failure=error;}finally{form.Close();vault.Clear();}
            };
            Application.Run(form);
        });
        // Two agent requests each allow the real 90s worker deadline, followed by a rendered document and evidence screens.
        thread.SetApartmentState(ApartmentState.STA);thread.Start();Assert.IsTrue(thread.Join(TimeSpan.FromMinutes(6)),"Work screen timed out");
        if(failure is not null)ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
