using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
namespace Sigongnote.Windows;

public sealed class WindowsWorkForm : Form
{
    public const string Origin="https://sigongnote.work";
    internal static bool AllowsMessageLength(string? route,int length)
    {
        if(length<0||length>1100000)return false;
        if(length<=16384)return true;
        // JSON can escape each UTF-16 character as six ASCII characters. The draft
        // allowance covers 64k lines + 16k quantities + bounded form fields together.
        return route switch {"documents.complete" or "activity.append"=>length<=500000,
            "context-learning.command"=>length<=100000,"photos.command"=>length<=64000,
            "voice.transcribe"=>true,_=>false};
    }
    private const string ClearActivityScript="window.dispatchEvent(new Event('sigongnote:activity-clear'));Object.keys(localStorage).filter(k=>k.startsWith('sigongnote.activity.v')).forEach(k=>localStorage.removeItem(k));";
    private static string ActivityLogoutMarker=>Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Sigongnote","clear-work-activity");
    public static void ForgetActivityAfterLogout()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ActivityLogoutMarker)!);
        var marker=Guid.NewGuid().ToString("D");
        File.WriteAllText(ActivityLogoutMarker,marker);
        foreach(var form in Application.OpenForms.OfType<WindowsWorkForm>().ToArray())_ = form.ClearActivityAsync(marker);
    }
    private static void CompleteActivityClear(string marker){try{if(File.Exists(ActivityLogoutMarker)&&File.ReadAllText(ActivityLogoutMarker)==marker)File.Delete(ActivityLogoutMarker);}catch{/* Retry on the next window. */}}
    private async Task ClearActivityAsync(string marker){try{if(!closing&&view.CoreWebView2 is not null&&Page(view.CoreWebView2.Source)){await view.CoreWebView2.ExecuteScriptAsync(ClearActivityScript);CompleteActivityClear(marker);}}catch{/* The marker retries on the next window. */}}
    private readonly WebView2 view=new(){Dock=DockStyle.Fill};
    private readonly WindowsSessionManager sessions;
    private readonly Action settings;
    private readonly Action? setupFolder;
    private readonly Action? setupRecording;
    private readonly Action? signIn;
    private readonly Action? logout;
    private readonly Action? linkAccount;
    private int workspaceVersion;
    private readonly CancellationTokenSource lifetime=new();
    private readonly HashSet<string> requests=[];
    private WindowsSession? workspace;
    private bool closing;
    private bool microphoneAllowed;
    private readonly Guid? initialRevision;
    private readonly Func<Task<Uri?>>? localLaunch;
    private Uri? localOrigin;
    public WindowsWorkForm(WindowsSessionManager sessions,Action settings,Guid? initialRevision=null,Action? signIn=null,Action? logout=null,Action? linkAccount=null,Action? setupFolder=null,Func<Task<Uri?>>? localLaunch=null,Action? setupRecording=null)
    {
        this.localLaunch=localLaunch;this.setupFolder=setupFolder;this.setupRecording=setupRecording;this.sessions=sessions;this.settings=settings;this.signIn=signIn;this.logout=logout;this.linkAccount=linkAccount;this.initialRevision=initialRevision;
        Text="시공노트";Width=1200;Height=860;MinimumSize=new System.Drawing.Size(420,480);StartPosition=FormStartPosition.CenterScreen;Controls.Add(view);
        Shown+=async(_,_)=>await LoadWork();
        // Closing the main work window only hides it; do not cancel its bridge then.
        FormClosed+=(_,_)=>{closing=true;lifetime.Cancel();view.Dispose();lifetime.Dispose();};
    }
    public void ShowLocal(Uri address)
    {
        if(address.Host!="127.0.0.1"||address.Port<1024||address.Scheme!="http")return;
        localOrigin=new Uri(address.GetLeftPart(UriPartial.Authority));
        view.CoreWebView2?.Navigate(address.AbsoluteUri);
    }
    private bool LocalPage(string? address)=>localOrigin is not null&&Uri.TryCreate(address,UriKind.Absolute,out var uri)&&uri.Scheme==localOrigin.Scheme&&uri.Host==localOrigin.Host&&uri.Port==localOrigin.Port;
    public void RefreshWorkspace()
    {
        workspaceVersion++;workspace=null;microphoneAllowed=false;
        if(!closing&&!IsDisposed&&view.CoreWebView2 is not null)view.CoreWebView2.Reload();
    }
    private async Task LoadWork()
    {
        try{
            var env=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Sigongnote","work-webview"));
            if(closing)return;
            await view.EnsureCoreWebView2Async(env);if(closing)return;var core=view.CoreWebView2;
            core.Settings.AreDevToolsEnabled=false;core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.IsPasswordAutosaveEnabled=false;core.Settings.IsGeneralAutofillEnabled=false;
            core.SetVirtualHostNameToFolderMapping("sigongnote.work",Path.Combine(AppContext.BaseDirectory,"work-ui"),CoreWebView2HostResourceAccessKind.DenyCors);
            if(File.Exists(ActivityLogoutMarker)){
                var marker=File.ReadAllText(ActivityLogoutMarker);
                var scriptId=await core.AddScriptToExecuteOnDocumentCreatedAsync(ClearActivityScript);
                EventHandler<CoreWebView2NavigationCompletedEventArgs>? cleared=null;
                cleared=(_,e)=>{if(e.IsSuccess&&Page(core.Source)){core.RemoveScriptToExecuteOnDocumentCreated(scriptId);core.NavigationCompleted-=cleared;CompleteActivityClear(marker);}};
                core.NavigationCompleted+=cleared;
            }
            core.NavigationStarting+=(_,e)=>{
                if(LocalPage(e.Uri))return;
                var destination=WindowsWorkNavigation.Classify(e.Uri);
                if(destination==WindowsWorkDestination.Page)return;
                e.Cancel=true;
                if(!Page(core.Source)&&!LocalPage(core.Source))return;
                if(destination==WindowsWorkDestination.PublicSetup){if(e.IsUserInitiated)OpenSetupBrowser(e.Uri);return;}
                // Run after the navigation event has completed (modal login pumps messages).
                Action? action=destination switch {
                    WindowsWorkDestination.SetupFolder=>setupFolder??settings,WindowsWorkDestination.SetupRecording=>setupRecording??settings,WindowsWorkDestination.Settings=>settings,WindowsWorkDestination.Login=>signIn??settings,
                    WindowsWorkDestination.Logout=>logout,WindowsWorkDestination.LinkAccount=>linkAccount,_=>null};
                if(action is not null)BeginInvoke(new Action(()=>{if(!closing&&!IsDisposed)action();}));
            };
            core.FrameNavigationStarting+=(_,e)=>e.Cancel=true;core.NewWindowRequested+=(_,e)=>{
                e.Handled=true;
                if(e.IsUserInitiated&&LocalPage(core.Source)&&LocalPage(e.Uri)&&new Uri(e.Uri).AbsolutePath.StartsWith("/local-original/",StringComparison.Ordinal)){BeginInvoke(new Action(()=>{if(!closing)core.Navigate(e.Uri);}));return;}
                if(e.IsUserInitiated&&Page(core.Source)&&WindowsWorkNavigation.Classify(e.Uri)==WindowsWorkDestination.PublicSetup)OpenSetupBrowser(e.Uri);
            };
            core.PermissionRequested+=(_,e)=>{
                e.SavesInProfile=false;e.State=CoreWebView2PermissionState.Deny;
                if(!closing&&workspace is not null&&e.Uri.TrimEnd('/')==Origin&&Page(core.Source)&&e.PermissionKind==CoreWebView2PermissionKind.Microphone){
                    microphoneAllowed=microphoneAllowed||MessageBox.Show(this,"마이크를 누른 동안만 짧게 듣습니다. 이 창에서 마이크를 사용할까요?","말로 요청하기",MessageBoxButtons.YesNo,MessageBoxIcon.Question)==DialogResult.Yes;
                    if(microphoneAllowed)e.State=CoreWebView2PermissionState.Allow;
                }
            };
            core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
            var storageOrigin=WindowsConnectionSettings.Read()?.SupabaseOrigin;
            core.WebResourceRequested+=(_,e)=>{if(!e.Request.Uri.StartsWith(Origin+"/",StringComparison.Ordinal)&&!LocalPage(e.Request.Uri)&&!WindowsWorkNetwork.SignedUpload(e.Request.Uri,storageOrigin))e.Response=env.CreateWebResourceResponse(null,403,"Forbidden","");};
            core.WebMessageReceived+=async(_,e)=>{try{await Message(e);}catch{/* A closing work window must never stop the tray collector. */}};
            if(localLaunch is not null&&initialRevision is null&&await localLaunch() is { } local){ShowLocal(local);return;}
            core.Navigate(Origin+"/index.html"+(initialRevision is null?"":$"#/materials/item/{initialRevision:D}"));
        }catch{if(closing||IsDisposed)return;Controls.Clear();var fallback=new FlowLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(24),FlowDirection=FlowDirection.TopDown};fallback.Controls.Add(new Label{AutoSize=true,Text="업무 화면을 열지 못했어요. WebView2와 앱 설치 파일을 확인해 주세요."});var button=new Button{AutoSize=true,Text="폴더·계정 설정 열기",Height=52};button.Click+=(_,_)=>settings();fallback.Controls.Add(button);Controls.Add(fallback);}
    }
    /// <summary>The shared screen keeps its current step after "#"; only the fixed page itself is trusted.</summary>
    private static bool Page(string? source)=>WindowsWorkNavigation.Classify(source)==WindowsWorkDestination.Page;
    private void OpenSetupBrowser(string address)
    {
        try{System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(address){UseShellExecute=true});}
        catch{MessageBox.Show(this,"브라우저를 열지 못했어요. 브라우저 주소창에 https://sigongnote-api.onrender.com/install 을 입력해 주세요.","설치 안내");}
    }
    private async Task Message(CoreWebView2WebMessageReceivedEventArgs e)
    {
        string? id=null;bool accepted=false;var version=workspaceVersion;
        try{
            if(!Page(e.Source)||e.WebMessageAsJson.Length>1100000)return;
            using var json=JsonDocument.Parse(e.WebMessageAsJson);var root=json.RootElement;
            if(root.EnumerateObject().Count()!=4||root.GetProperty("bridgeVersion").GetInt32()!=1||root.GetProperty("method").GetString()!="workRequest")return;
            var workRoute=root.GetProperty("payload").GetProperty("route").GetString();
            if(!AllowsMessageLength(workRoute,e.WebMessageAsJson.Length))return;
            id=root.GetProperty("requestId").GetString();if(!Guid.TryParseExact(id,"D",out _)||requests.Count>=8||!requests.Add(id!))return;
            accepted=true;
            var expected=workspace??await sessions.CurrentAsync(lifetime.Token);
            if(version!=workspaceVersion)return;workspace=expected;
            var result=await sessions.WorkRequestAsync(root.GetProperty("payload").Clone(),lifetime.Token,expected);
            if(version!=workspaceVersion)return;
            if(root.GetProperty("payload").GetProperty("route").GetString()=="materials.original"){
                if(closing)return;
                using var data=JsonDocument.Parse(result);
                var url=new Uri(data.RootElement.GetProperty("url").GetString()!);
                var origin=new Uri(expected.SupabaseOrigin);
                if(url.Scheme!=origin.Scheme||url.Host!=origin.Host||url.Port!=origin.Port||url.UserInfo.Length>0||!url.AbsolutePath.StartsWith("/storage/v1/object/sign/sigongnote-originals/",StringComparison.Ordinal))throw new InvalidOperationException();
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url.AbsoluteUri){UseShellExecute=true});
                result="{\"opened\":true}";
            }
            var payload=root.GetProperty("payload");
            if((payload.GetProperty("route").GetString() is "documents.file" or "sheets.file")&&payload.TryGetProperty("action",out var action)){
                var format=payload.GetProperty("format").GetString()!;
                var file=await WindowsDocumentFile.Prepare(result,format,expected.Principal.ToString(),lifetime.Token);
                if(closing||version!=workspaceVersion)return;
                var current=await sessions.CurrentAsync(lifetime.Token);if(current.Principal!=expected.Principal)throw new WindowsLoginRequiredException();
                var mode=action.GetString();
                if(mode=="save"){
                    using var picker=new SaveFileDialog{FileName=Path.GetFileName(file),Filter=format=="pdf"?"PDF|*.pdf":"Excel|*.xlsx",OverwritePrompt=true};
                    if(picker.ShowDialog(this)!=DialogResult.OK){Reply(id,true,"{\"outcome\":\"cancelled\",\"message\":\"저장을 취소했어요.\"}");return;}
                    if(File.Exists(picker.FileName))throw new IOException("기존 파일은 덮어쓸 수 없어요.");
                    File.Copy(file,picker.FileName,false);
                }else if(mode=="open")System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(file){UseShellExecute=true});
                else System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe",$"/select,\"{file}\""){UseShellExecute=true});
                result=JsonSerializer.Serialize(new{outcome="unknown",message=mode=="share"?"공유할 파일을 폴더에서 선택했어요. 메일이나 메신저에 첨부해 주세요.":mode=="save"?"파일을 저장했어요.":"문서 열기를 요청했어요."});
            }
            if(version==workspaceVersion)Reply(id,true,result);
        }catch(WindowsLoginRequiredException){if(id is not null&&version==workspaceVersion)Reply(id,false,"login_required");}
        catch(WindowsWorkRejectedException rejected){if(id is not null&&version==workspaceVersion)Reply(id,false,rejected.Code);}
        catch{if(id is not null&&version==workspaceVersion)Reply(id,false,"connection_wait");}
        finally{if(accepted&&id is not null)requests.Remove(id);}
    }
    private void Reply(string? id,bool ok,string result){
        if(closing||lifetime.IsCancellationRequested||IsDisposed||view.IsDisposed)return;
        try{view.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new{bridgeVersion=1,requestId=id,method="workRequest",ok,result}));}
        catch{/* WebView can be disposed between its check and the send. */}
    }
}
