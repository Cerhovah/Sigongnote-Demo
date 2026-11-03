using System.Drawing;
using System.ComponentModel;
using System.Windows.Forms;

namespace Sigongnote.Windows;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if(args.Length>0&&args[0] is "--local-key" or "--select-local-folder" or "--local-cloud-session" or "--shutdown-for-update"){
            try{ApplicationConfiguration.Initialize();WindowsLocalAgentHelper.Run(args);}catch{Environment.ExitCode=1;}
            return;
        }
        using var openSignal=new EventWaitHandle(false,EventResetMode.AutoReset,@"Local\Sigongnote.Windows.Open");
        using var shutdownSignal=new EventWaitHandle(false,EventResetMode.AutoReset,@"Local\Sigongnote.Windows.ShutdownForUpdate");
        using var singleInstance = new Mutex(true,@"Local\Sigongnote.Windows.Tray",out var ownsMutex);
        if (!ownsMutex) {
            openSignal.Set();
            if(AnotherCopyIsRunning()) {
                ApplicationConfiguration.Initialize();
                MessageBox.Show("다른 위치의 시공노트가 이미 실행 중입니다.\n새 버전을 사용하려면 실행 중인 시공노트의 알림 영역 메뉴에서 종료한 뒤 다시 실행하세요.",
                    "시공노트"+BuildVersionSuffix(),MessageBoxButtons.OK,MessageBoxIcon.Information);
            }
            return;
        }
        ApplicationConfiguration.Initialize();
        try {
            _ = WindowsConnectionSettings.Read();
            var state = new WindowsStateStore(WindowsStateStore.DefaultPath);
            var keyPath = Path.Combine(Path.GetDirectoryName(WindowsStateStore.DefaultPath)!,
                "queue-key.protected");
            var queueKey = new WindowsQueueKey(keyPath).GetOrCreate(state.MarkKeyUnrecoverable);
            try {
                using var copies = new WindowsEncryptedCopyStore(state,queueKey,
                    WindowsEncryptedCopyStore.DefaultPath);
                state.RecoverInterruptedCopies();
                var vault = new WindowsTokenVault(Path.Combine(
                    Path.GetDirectoryName(WindowsStateStore.DefaultPath)!,"session.protected"));
                Application.Run(new TrayContext(state,vault,copies,openSignal,shutdownSignal));
            } finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(queueKey); }
        } catch (Exception) {
            MessageBox.Show("기기 보호 저장소를 열지 못했습니다. 업무 원본은 그대로입니다. 이 PC의 저장소 권한을 확인해 주세요.",
                "시공노트 시작 실패",MessageBoxButtons.OK,MessageBoxIcon.Error);
        }
    }

    internal static string BuildVersionSuffix()
    {
        try {
            using var build=System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"BUILD.json")));
            var version=build.RootElement.GetProperty("version").GetString();
            return version is not null && version.Length<=64 && version.All(c=>char.IsAsciiLetterOrDigit(c)||c is '.' or '-') ? " · "+version : "";
        } catch {return "";}
    }

    private static bool AnotherCopyIsRunning()
    {
        using var current=System.Diagnostics.Process.GetCurrentProcess();
        foreach(var other in System.Diagnostics.Process.GetProcessesByName(current.ProcessName)) {
            using(other) {
                if(other.Id==current.Id)continue;
                try {
                    if(!string.Equals(other.MainModule?.FileName,Environment.ProcessPath,StringComparison.OrdinalIgnoreCase))return true;
                } catch(Win32Exception) { /* A process outside this user's session is not our app. */ }
                  catch(InvalidOperationException) { /* It exited during the check. */ }
            }
        }
        return false;
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private readonly WindowsStateStore state;
    private readonly WindowsTokenVault vault;
    private readonly WindowsTokenVault pendingVault;
    private readonly WindowsDeviceKeyStore deviceKeys;
    private readonly NotifyIcon tray;
    private readonly DashboardForm dashboard;
    private readonly WindowsWorkForm work;
    private readonly WindowsFolderMonitor monitor;
    private readonly WindowsSessionManager uploadSessions;
    private readonly WindowsUploadTransport uploadTransport;
    private readonly WindowsUploadWorker uploader;
    private readonly WindowsMirrorWorker mirror;
    private readonly WindowsLocalAgentHost localAgent;
    private bool localRuntimePrimary=true;
    private bool exiting;
    private bool connecting;
    private bool exitRequested;
    private bool logoutRequested;
    private bool loggingOut;
    private readonly WindowsLoginDialogHost loginDialog=new();
    private Form DialogOwner => dashboard.Visible ? dashboard : work;
    private readonly RegisteredWaitHandle openRegistration;
    private readonly RegisteredWaitHandle shutdownRegistration;

    public TrayContext(WindowsStateStore state, WindowsTokenVault vault,
        WindowsEncryptedCopyStore copies, EventWaitHandle openSignal, EventWaitHandle shutdownSignal)
    {
        this.state = state;
        this.vault = vault;
        localAgent=new(extraDiscoveryRoots:()=>state.Folders().Where(folder=>folder.State=="selected"&&folder.RootPath is not null&&state.FolderSetup(folder.Id)?.Selection.Kind!="call_recording").Select(folder=>folder.RootPath!));
        var localRoot = Path.GetDirectoryName(WindowsStateStore.DefaultPath)!;
        pendingVault = new WindowsTokenVault(Path.Combine(localRoot,
            "pending-session.protected"));
        deviceKeys = new WindowsDeviceKeyStore(Path.Combine(localRoot,"device-keys"));
        monitor = new WindowsFolderMonitor(state,copies,folder=>WindowsCollectorRouting.CollectNatively(state,folder,localRuntimePrimary));
        uploadSessions = new WindowsSessionManager(vault);
        mirror=new WindowsMirrorWorker(state,uploadSessions);
        uploadTransport = new WindowsUploadTransport(state,copies,uploadSessions);
        uploader = new WindowsUploadWorker(state,() => vault.Read() is not null,
            uploadTransport.UploadOneAsync);
        dashboard = new DashboardForm(state,SignIn,Logout,ConnectFolderAsync,
            ApproveBackfillAsync,
            SourcesChanged,
            () => vault.Read() is not null,() => uploader.Status+" · "+mirror.Status,UploadDestinationAsync,VerifyFolderAsync,ResolveRevisionConflictsAsync,LinkAccount);
        dashboard.FormClosing += (_,args) => {
            if (exiting) return;
            args.Cancel = true;
            dashboard.Hide();
            Open();
        };
        // Keep a UI dispatcher alive even while the collector settings are hidden.
        _ = dashboard.Handle;
        _ = localAgent.StartAsync();
        work = new WindowsWorkForm(uploadSessions,OpenSettings,signIn:SignIn,logout:Logout,linkAccount:LinkAccount,setupFolder:async()=>{await dashboard.BeginSiteSetup();work?.Activate();},localLaunch:localAgent.StartAsync,setupRecording:async()=>{await dashboard.BeginRecordingSetup();work?.Activate();});
        work.Text="시공노트"+Program.BuildVersionSuffix();
        work.FormClosing += (_,args) => {
            if (exiting) return;
            args.Cancel = true;
            work.Hide();
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add("시공노트 열기",null,(_,_) => Open());
        menu.Items.Add("내 업무자료 찾기",null,(_,_) => OpenLocalAgent());
        menu.Items.Add("업무 폴더 설정",null,(_,_) => OpenSettings());
        menu.Items.Add("업무 계정 로그인",null,(_,_) => SignIn());
        menu.Items.Add("내 로그인 수단 추가",null,(_,_) => LinkAccount());
        menu.Items.Add("로그아웃",null,(_,_) => Logout());
        menu.Items.Add("자료 읽기 종료",null,(_,_) => Exit());
        tray = new NotifyIcon {
            Icon = SystemIcons.Application,
            Text = "시공노트 · 로컬 자료 확인 대기",
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.DoubleClick += (_,_) => Open();
        monitor.StatusChanged += () => {
            uploader.RequestUpload();
            try {
                if (dashboard.IsHandleCreated && !dashboard.IsDisposed)
                    dashboard.BeginInvoke(new Action(dashboard.RefreshState));
            } catch (InvalidOperationException) { /* Closing the window does not stop scans. */ }
        };
        uploader.StatusChanged += () => {
            try {
                if (dashboard.IsHandleCreated && !dashboard.IsDisposed)
                    dashboard.BeginInvoke(new Action(dashboard.RefreshState));
            } catch (InvalidOperationException) { /* Closing the window does not stop uploads. */ }
        };
        uploader.Start();
        mirror.Start();
        _ = StartCollectorAsync();
        Open();
        openRegistration=ThreadPool.RegisterWaitForSingleObject(openSignal,(_,_)=> {
            try { if(!exiting && !dashboard.IsDisposed)dashboard.BeginInvoke(new Action(Open)); }
            catch(InvalidOperationException) { /* The application is closing. */ }
        },null,Timeout.Infinite,false);
        shutdownRegistration=ThreadPool.RegisterWaitForSingleObject(shutdownSignal,(_,_)=> {
            try { if(!exiting && !dashboard.IsDisposed)dashboard.BeginInvoke(new Action(Exit)); }
            catch(InvalidOperationException) { /* The application is closing. */ }
        },null,Timeout.Infinite,false);
    }

    private async Task StartCollectorAsync()
    {
        var local=await localAgent.StartAsync();
        if(exiting)return;
        localRuntimePrimary=local is not null;
        monitor.Start();
    }

    private void RequestLegacyReconcile(){monitor.RequestReconcile();}

    private void SourcesChanged()
    {
        uploader.Pause();
        uploader.Start();
        RequestLegacyReconcile();
    }

    private async void OpenLocalAgent()
    {
        try {
            var uri=await localAgent.StartAsync();
            if(uri is null)throw new InvalidOperationException();
            work.ShowLocal(uri);Open();
        } catch (Exception) {
            MessageBox.Show(dashboard,"자료 정리 프로그램을 시작하지 못했어요. 최신 설치 파일로 앱을 다시 설치해 주세요.",
                "시공노트",MessageBoxButtons.OK,MessageBoxIcon.Information);
        }
    }

    private void Open()
    {
        work.Show();
        work.WindowState = FormWindowState.Normal;
        work.Activate();
    }

    private void OpenSettings()
    {
        dashboard.RefreshState();
        dashboard.Show();
        dashboard.WindowState = FormWindowState.Normal;
        dashboard.Activate();
    }

    private void Logout()
    {
        if(loggingOut)return;
        if (connecting) {
            logoutRequested = true;
            MessageBox.Show(DialogOwner,"폴더 준비가 끝나면 로그아웃을 확인합니다.",
                "로그아웃 대기",MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        loggingOut=true;
        try {
        var pending = state.PendingCount();
        var answer = MessageBox.Show(DialogOwner,
            $"전송 대기 {pending}건은 이 기기에 보관하고 수집과 로그인을 중지합니다. 계속할까요?",
            "로그아웃",MessageBoxButtons.YesNo,MessageBoxIcon.Question);
        if (answer != DialogResult.Yes) return;
        uploader.Pause();
        state.Logout();
        vault.Clear();
        pendingVault.Clear();
        WindowsWorkForm.ForgetActivityAfterLogout();
        foreach(var window in Application.OpenForms.OfType<WindowsWorkForm>().ToArray())window.RefreshWorkspace();
        RequestLegacyReconcile();
        dashboard.RefreshState();
        } finally { loggingOut=false; }
    }

    private void SignIn()
    {
        if(loginDialog.ActivateExisting())return;
        if (connecting) { MessageBox.Show(DialogOwner,"폴더 연결을 준비하고 있어요. 잠시 후 다시 눌러 주세요.","연결 준비 중");return; }
        var options = WindowsConnectionSettings.Read();
        if (options is null) {
            MessageBox.Show(DialogOwner,
                "이 PC의 초기 준비가 필요합니다. 설치 담당자에게 알려 주세요.",
                "시공노트 시작 준비",MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        if(vault.Read() is not null) { work.RefreshWorkspace();Open();return; }
        if(loginDialog.Show(DialogOwner,()=>new WindowsLoginForm(options,pendingVault,vault,deviceKeys)) is null)return;
        pendingVault.Clear();
        if (vault.Read() is not null) {
            uploader.Start();
            RequestLegacyReconcile();
            dashboard.RefreshState();
            work.RefreshWorkspace();
            Open();
        }
    }

    private void LinkAccount()
    {
        if(connecting)return;
        var options=WindowsConnectionSettings.Read();
        if(options is null||vault.Read() is null){SignIn();return;}
        using var linking=new WindowsIdentityLinkForm(options,vault,pendingVault);
        linking.ShowDialog(DialogOwner);
    }

    private async Task ResolveRevisionConflictsAsync(){
        try{
            var session=await uploadSessions.CurrentAsync();var conflict=state.RevisionConflicts(session.Principal).FirstOrDefault();
            if(conflict is null){MessageBox.Show(dashboard,"지금 확인할 수정본이 없어요.","수정본 확인");return;}
            var latest=await WindowsRevisionResolution.LatestAsync(uploadSessions,session,conflict);
            using var dialog=new Form{Text="같은 자료를 두 곳에서 고쳤어요",Width=680,Height=410,Font=dashboard.Font,StartPosition=FormStartPosition.CenterParent,AutoScaleMode=AutoScaleMode.Dpi};
            var panel=new FlowLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(24),FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true};
            panel.Controls.Add(new Label{AutoSize=true,MaximumSize=new Size(590,0),Text=$"{conflict.Name}\n다른 기기에서 먼저 고친 자료가 있어요(개정 {latest.Version}). 최신 내용을 확인한 뒤, 보류된 내 수정본을 다음 개정으로 올릴 수 있어요. 그 뒤 저장한 내용도 이어 보냅니다. 원본과 이전 개정은 그대로 보존해요."});
            var read=new Button{Text="최신 자료 열기",AutoSize=true,Height=56};read.Click+=(_,_)=>new WindowsWorkForm(uploadSessions,OpenSettings,latest.RevisionId,SignIn,Logout,LinkAccount).Show();panel.Controls.Add(read);
            var send=new Button{Text="내 수정본을 다음 개정으로 올리기",AutoSize=true,Height=56,DialogResult=DialogResult.OK};panel.Controls.Add(send);
            var keep=new Button{Text="그대로 두기",AutoSize=true,Height=56,DialogResult=DialogResult.Cancel};panel.Controls.Add(keep);dialog.CancelButton=keep;dialog.Controls.Add(panel);
            if(dialog.ShowDialog(dashboard)!=DialogResult.OK)return;
            var current=await uploadSessions.CurrentAsync();if(current.Principal!=session.Principal||current.ApiBaseUrl!=session.ApiBaseUrl)throw new WindowsLoginRequiredException();
            state.ResumeRevisionConflict(session.Principal,conflict,latest);uploader.RequestUpload();
        }catch{MessageBox.Show(dashboard,"수정본을 확인하지 못했어요. 연결과 같은 회사의 로그인 상태를 확인한 뒤 다시 눌러 주세요. 사본은 그대로 보존했어요.","수정본 확인",MessageBoxButtons.OK,MessageBoxIcon.Information);}
    }

    private async Task<WindowsUploadDestination> UploadDestinationAsync()
    {
        using var session=new WindowsSessionManager(vault);
        return await session.UploadDestinationAsync(includeSetup:true);
    }

    private async Task VerifyFolderAsync(string localSourceId)
    {
        await WithConnectionGate(async ()=> {
            using var session=new WindowsSessionManager(vault);
            var folder=state.Folders().Single(item=>item.Id==localSourceId);
            if(!folder.ServerSourceId.HasValue)throw new WindowsSourceInactiveException();
            return await session.BindVerifiedFolderAsync(state,localSourceId,folder.ServerSourceId.Value);
        });
    }

    private async Task<FolderConnection> ConnectFolderAsync(string localSourceId, WindowsUploadDestination destination)
    {
        return await WithConnectionGate(async () => {
            using var session = new WindowsSessionManager(vault);
            if(!destination.Matches(await session.CurrentAsync()))throw new WindowsLoginRequiredException();
            var bound = await session.ConnectScopedFolderAsync(state,deviceKeys,
                localSourceId,destination);
            if (!exiting) RequestLegacyReconcile();
            return bound;
        });
    }

    private async Task<int> ApproveBackfillAsync(string localSourceId,
        BackfillApprovalSnapshot snapshot, WindowsUploadDestination destination)
    {
        return await WithConnectionGate(async () => {
            using var session = new WindowsSessionManager(vault);
            if(!destination.Matches(await session.CurrentAsync()))throw new WindowsLoginRequiredException();
            var folder = state.Folders().Single(item => item.Id == localSourceId);
            if (!folder.ServerSourceId.HasValue)
                throw new InvalidOperationException("Folder is not server-bound");
            await session.BindVerifiedFolderAsync(state,localSourceId,
                folder.ServerSourceId.Value);
            var principal = (await session.CurrentAsync()).Principal;
            var approved = state.ApproveExistingBackfill(localSourceId,principal,snapshot);
            if (approved > 0 && !exiting) RequestLegacyReconcile();
            return approved;
        });
    }

    private async Task<T> WithConnectionGate<T>(Func<Task<T>> work)
    {
        if (connecting) throw new InvalidOperationException("Connection is busy");
        connecting = true;
        try { return await work(); }
        finally {
            connecting = false;
            if (exitRequested) Exit();
            else if (logoutRequested) {
                logoutRequested = false;
                Logout();
            }
        }
    }

    private void Exit()
    {
        if (connecting) { exitRequested = true; return; }
        exiting = true;
        openRegistration.Unregister(null);
        shutdownRegistration.Unregister(null);
        uploader.Dispose();
        localAgent.Dispose();
        uploadTransport.Dispose();
        mirror.Dispose();
        uploadSessions.Dispose();
        monitor.Dispose();
        tray.Visible = false;
        tray.Dispose();
        work.Close();
        work.Dispose();
        dashboard.Close();
        dashboard.Dispose();
        ExitThread();
    }
}

internal sealed class DashboardForm : Form
{
    private readonly WindowsStateStore state;
    private readonly Action logout;
    private readonly Func<string,WindowsUploadDestination,Task<FolderConnection>> connectFolder;
    private readonly Func<string,BackfillApprovalSnapshot,WindowsUploadDestination,Task<int>> approveBackfill;
    private readonly Func<Task<WindowsUploadDestination>> destination;
    private readonly Func<string,Task> verifyFolder;
    private readonly Action sourcesChanged;
    private readonly Func<bool> hasLogin;
    private readonly Func<string> uploadStatus;
    private readonly Label status = new() { AutoSize = true, MaximumSize = new Size(550,0) };
    private readonly Label details = new() { AutoSize = true, MaximumSize = new Size(550,0) };
    private readonly ListBox folders = new() { Dock = DockStyle.Fill };
    private IReadOnlyList<FolderConnection> items = [];
    private readonly List<Button> actions = [];
    private bool busy;
    private readonly Label accountStatus = new() { AutoSize=true,MaximumSize=new Size(550,0) };
    private Button loginButton=null!;
    private Button logoutButton=null!;
    private Button linkAccountButton=null!;
    private Label? operationNotice;
    private CancellationTokenSource? previewCancellation;

    public DashboardForm(WindowsStateStore state, Action signIn, Action logout,
        Func<string,WindowsUploadDestination,Task<FolderConnection>> connectFolder,
        Func<string,BackfillApprovalSnapshot,WindowsUploadDestination,Task<int>> approveBackfill,
        Action sourcesChanged,
        Func<bool> hasLogin, Func<string> uploadStatus,
        Func<Task<WindowsUploadDestination>> destination, Func<string,Task> verifyFolder,Func<Task>? resolveRevisionConflicts=null,Action? linkAccount=null)
    {
        this.state = state;
        this.logout = logout;
        this.connectFolder = connectFolder;
        this.approveBackfill = approveBackfill;
        this.sourcesChanged = sourcesChanged;
        this.hasLogin = hasLogin;
        this.uploadStatus = uploadStatus;
        this.destination=destination;
        this.verifyFolder=verifyFolder;
        Text = "시공노트 · 업무 폴더";
        Font = new Font("Malgun Gothic",14);
        Width = 800; Height = 640; MinimumSize = new Size(680,500);
        BackColor = Color.FromArgb(246,247,249);
        AutoScaleMode=AutoScaleMode.Dpi;
        var pages = new TabControl { Dock=DockStyle.Fill, Font=Font };
        var sourcePage = new TabPage("업무 폴더") { Padding=new Padding(20) };
        var accountPage = new TabPage("계정") { Padding=new Padding(20) };
        var progressPage = new TabPage("자세히 보기") { Padding=new Padding(20) };
        pages.TabPages.AddRange([sourcePage,accountPage,progressPage]);
        var top = new FlowLayoutPanel { Dock=DockStyle.Top, AutoSize=true, FlowDirection=FlowDirection.TopDown, WrapContents=false };
        top.Controls.Add(new Label { Text="업무자료가 모인 상위 폴더를 연결하세요", AutoSize=true, Font=new Font(Font.FontFamily,18,FontStyle.Bold) });
        top.Controls.Add(new Label { Text="한 번 선택하면 기존 자료와 새 하위 폴더를 계속 읽어요.", AutoSize=true, MaximumSize=new Size(660,0), Margin=new Padding(0,8,0,12) });
        top.Controls.Add(status);
        var choices = new FlowLayoutPanel { Dock=DockStyle.Bottom, AutoSize=true, Padding=new Padding(0,12,0,0) };
        Button action(string text, bool primary=false) {
            var result=new Button { Text=text, AutoSize=true, MinimumSize=new Size(170,56), Padding=new Padding(12,8,12,8), FlatStyle=FlatStyle.Flat };
            if(primary) { result.BackColor=Color.FromArgb(23,88,68);result.ForeColor=Color.White; }
            actions.Add(result);return result;
        }
        var upper=action("상위 폴더 연결",true);upper.Click+=async(_,_)=>await SelectUpperFolderAsync();
        var manage=action("이 폴더 보기");manage.Click+=(_,_)=>OpenFolderActions();
        choices.Controls.AddRange([upper,manage]);
        folders.Font=Font;folders.IntegralHeight=false;folders.DrawMode=DrawMode.OwnerDrawFixed;
        void sizeRows()=>folders.ItemHeight=Math.Max(LogicalToDeviceUnits(64),folders.Font.Height*2+LogicalToDeviceUnits(12));
        sizeRows();DpiChanged+=(_,_)=>sizeRows();folders.FontChanged+=(_,_)=>sizeRows();
        folders.DrawItem+=(_,e)=> {
            e.DrawBackground();if(e.Index<0 || e.Index>=items.Count)return;
            var folder=items[e.Index];var color=e.State.HasFlag(DrawItemState.Selected)?SystemColors.HighlightText:Color.FromArgb(23,43,56);
            var inset=LogicalToDeviceUnits(6);var lineHeight=folders.Font.Height;
            TextRenderer.DrawText(e.Graphics,Path.GetFileName(folder.RootPath) ?? "업무 폴더",folders.Font,new Rectangle(e.Bounds.X+inset,e.Bounds.Y+inset,e.Bounds.Width-2*inset,lineHeight),color,TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(e.Graphics,FolderLabel(folder),folders.Font,new Rectangle(e.Bounds.X+inset,e.Bounds.Y+inset+lineHeight,e.Bounds.Width-2*inset,lineHeight),color,TextFormatFlags.EndEllipsis);
            e.DrawFocusRectangle();
        };
        folders.AccessibleName="업무 폴더 목록";folders.DoubleClick+=(_,_)=>OpenFolderActions();
        sourcePage.Controls.Add(folders);sourcePage.Controls.Add(top);sourcePage.Controls.Add(choices);
        var account=new FlowLayoutPanel { Dock=DockStyle.Fill, AutoScroll=true, FlowDirection=FlowDirection.TopDown, WrapContents=false };
        account.Controls.Add(accountStatus);
        loginButton=action("로그인",true);loginButton.Click+=(_,_)=>signIn();
        linkAccountButton=action("내 다른 로그인 추가");linkAccountButton.Click+=(_,_)=>(linkAccount??signIn)();account.Controls.Add(linkAccountButton);
        logoutButton=action("로그아웃");logoutButton.Click+=(_,_)=>logout();account.Controls.AddRange([loginButton,logoutButton]);accountPage.Controls.Add(account);
        var progress=new FlowLayoutPanel { Dock=DockStyle.Fill, AutoScroll=true, FlowDirection=FlowDirection.TopDown, WrapContents=false };
        progress.Controls.Add(new Label { Text="자료를 가져오는 과정",AutoSize=true,Font=new Font(Font.FontFamily,18,FontStyle.Bold) });
        progress.Controls.Add(details);var conflicts=action("보류된 수정본 확인");conflicts.Click+=async(_,_)=>{if(busy||resolveRevisionConflicts is null)return;busy=true;conflicts.Enabled=false;try{await resolveRevisionConflicts();}finally{busy=false;conflicts.Enabled=true;RefreshState();}};progress.Controls.Add(conflicts);progressPage.Controls.Add(progress);
        Controls.Add(pages);
        RefreshState();
    }

    public void RefreshState()
    {
        var selectedId=folders.SelectedIndex>=0 && folders.SelectedIndex<items.Count ? items[folders.SelectedIndex].Id : null;
        items = state.Folders();
        folders.Items.Clear();
        foreach (var folder in items)
            folders.Items.Add($"{Path.GetFileName(folder.RootPath) ?? "업무 폴더"} · {FolderLabel(folder)}");
        var selected=items.ToList().FindIndex(item=>item.Id==selectedId);
        if(selected>=0)folders.SelectedIndex=selected;
        var signedIn=hasLogin();
        accountStatus.Text=signedIn ? "로그인 정보를 이 PC에 보관하고 있어요. 자료를 보내기 전에 서버에서 확인해요." : "업무 서버를 사용하려면 로그인해 주세요.";
        loginButton.Visible=!signedIn;logoutButton.Visible=signedIn;linkAccountButton.Visible=signedIn;
        status.Text=state.HadKeyReset()? "이전 자료를 열 수 없어 확인이 필요해요." : state.SourceIssueCount()>0? $"일부 자료를 확인하지 못한 폴더 {state.SourceIssueCount()}개가 있어요." : $"연결한 폴더 {items.Count}개 · 회사 연결 {items.Count(item=>item.ServerSourceId.HasValue && item.State=="selected")}개. 원본은 그대로예요.";
        details.Text = state.HadKeyReset()
            ? $"보호 키를 복구할 수 없어 새로 만들었습니다. 이전 대기 자료 {state.PendingCount()}건은 다시 확인해야 합니다."
            : $"{(hasLogin() ? "로그인 정보 보관됨" : "로그인 필요")}\n업무 폴더 {items.Count}개\n읽기 확인 {state.SourceIssueCount()}개\n파일을 기다리는 중 {state.PendingFileCount()}개\n사본 준비 보류 {state.CopyIssueCount()}건\n과거 자료 전송 허용 대기 {state.BackfillApprovalCount()}건\n서버 전송 대기 {state.PendingCount()}건\n전송 {uploadStatus()}" +
              (state.RevisionConflictCount()>0?$"\n다른 기기에서 먼저 고친 자료와 겹친 수정본 {state.RevisionConflictCount()}개를 보존했어요. ‘보류된 수정본 확인’에서 이어 보낼 수 있어요.":"")+
              (state.LocalStorageWaitCount()>0?$"\nPC 저장 공간 대기 {state.LocalStorageWaitCount()}건 · {WindowsCopySpace.Describe()} · 공간이 생기면 자동 재시도":"")+
              (state.StorageQuotaPausedCount()>0?"\n계정의 원문 보관 한도 100GB에 도달했어요. 미전송 자료는 PC에 보관합니다.":"");
    }

    private string FolderLabel(FolderConnection folder)
    {
        if (folder.RootPath is null) return "폴더를 다시 골라 주세요";
        if (folder.State != "selected") return "읽기를 멈췄어요";
        var setupState=state.FolderSetupState(folder.Id);
        if(setupState=="pending")return "현장 연결을 자동으로 이어 준비하는 중";
        if(setupState=="needs_attention")return "현장 연결 조건을 다시 확인해 주세요";
        var health=state.Health(folder.Id);
        if (health?.ErrorCode == "backlog_pending") return "지난 자료를 이어 읽는 중";
        if (health?.ErrorCode == "partial_inventory") return "일부 폴더를 읽지 못했어요";
        if (health?.State == "source_offline") return "USB가 꽂혀 있는지 확인해 주세요";
        if (health?.ErrorCode is not null) return "폴더를 읽을 수 있는지 확인해 주세요";
        return folder.ServerSourceId.HasValue ? (state.FolderSetup(folder.Id)?.Selection.ManagedRoot==true?"상위 폴더 연결됨 · 새 하위 폴더 자동 수집":"서버 전송을 허용한 폴더") : "이 PC에서만 읽어요";
    }

    private void OpenFolderActions()
    {
        if (busy) return;
        var index=folders.SelectedIndex;
        if(index<0 || index>=items.Count) {
            MessageBox.Show(this,"목록에서 폴더 하나를 골라 주세요.","업무 폴더",MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        var selectedId=items[index].Id;
        using var dialog=new Form { Text="이 폴더의 자료",Font=Font,Width=680,Height=600,
            MinimumSize=new Size(620,520),StartPosition=FormStartPosition.CenterParent };
        var content=new FlowLayoutPanel { Dock=DockStyle.Fill,AutoScroll=true,
            FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(24) };
        var description=new Label { AutoSize=true,MaximumSize=new Size(550,0) };
        content.Controls.Add(new Label { Text="이 자료를 어떻게 보관할까요?",AutoSize=true,
            Font=new Font(Font.FontFamily,18,FontStyle.Bold),MaximumSize=new Size(550,0) });
        content.Controls.Add(description);
        operationNotice=new Label { AutoSize=true,MaximumSize=new Size(550,0) };
        content.Controls.Add(operationNotice);
        Button? serverAction=null;
        var alreadyAllowed=items[index].ServerSourceId.HasValue;
        var localActions=new List<Button>();
        void update() {
            var selected=items.ToList().FindIndex(item=>item.Id==selectedId);
            if(selected<0) { dialog.Close();return; }
            folders.SelectedIndex=selected;
            description.Text=$"{items[selected].RootPath ?? "폴더를 다시 골라 주세요"}\n{FolderLabel(items[selected])}";
            if(serverAction is not null)serverAction.Text=items[selected].ServerSourceId.HasValue ? "전송 허용 확인하기" : "서버 전송 허용하기";
        }
        Button add(string text,Func<Task> work,bool primary=false) {
            var button=new Button { Text=text,AutoSize=true,MinimumSize=new Size(250,56),
                Padding=new Padding(12,8,12,8),FlatStyle=FlatStyle.Flat };
            if(primary) { button.BackColor=Color.FromArgb(23,88,68);button.ForeColor=Color.White; }
            button.Click+=async (_,_)=> {
                if(busy)return;
                update();if(dialog.IsDisposed)return;
                await work();if(!dialog.IsDisposed)update();
            };
            actions.Add(button);localActions.Add(button);content.Controls.Add(button);return button;
        }
        serverAction=add(alreadyAllowed ? "전송 허용 확인하기" : "서버 전송 허용하기",ConnectSelectedFolderAsync,!alreadyAllowed);
        add("PC 사본 자동 저장 설정",async()=>{
            var setup=state.FolderSetup(selectedId);
            if(setup is null||(!setup.Selection.ManagedRoot&&(setup.Selection.Common||setup.ProjectId is null))||state.FolderSetupState(selectedId)!="ready"){operationNotice.Text="먼저 이 폴더를 한 현장에 연결해 주세요.";return;}
            try{
                var recipient=await destination();
                if(recipient.Principal!=setup.Principal){operationNotice.Text="연결한 계정으로 다시 로그인해 주세요.";return;}
                var choice=MessageBox.Show(dialog,(setup.Selection.ManagedRoot?"같은 회사에서 열람할 수 있는 모든 현장·회사 공통·현장 확인 전 자료의 ":"이 현장의 ")+"문서·사진·발행 문서를 시공노트 하위 폴더에 자동 저장할까요? 원본·직접 고친 사본은 덮어쓰지 않습니다. 녹음·문자는 앱에서 확인합니다. [아니요]는 자동 저장 중지입니다.","PC 사본 위치",MessageBoxButtons.YesNoCancel,MessageBoxIcon.Question);
                if(choice==DialogResult.Cancel)return;
                state.SaveFolderSetup(setup with {Selection=setup.Selection with {DownloadCopies=choice==DialogResult.Yes}},"ready");
                sourcesChanged();operationNotice.Text=choice==DialogResult.Yes?"이 폴더에 자동 사본 저장을 시작합니다.":"새 사본 저장을 멈췄어요. 기존 사본은 보존됩니다.";
            }catch{operationNotice.Text="연결을 확인한 뒤 다시 설정해 주세요.";}
        });
        add("보관된 자료도 보내기",ApproveSelectedBackfillAsync);
        add("중지한 폴더 다시 읽기",ResumeSelectedFolderAsync);
        add("이 폴더 읽기 멈추기",()=>{ PauseFolder();return Task.CompletedTask; });
        var close=add("돌아가기",()=>{ dialog.Close();return Task.CompletedTask; });
        var cancel=new Button { Text="폴더 확인 취소",AutoSize=true,MinimumSize=new Size(200,56) };
        cancel.Click+=(_,_)=>previewCancellation?.Cancel();
        content.Controls.Add(cancel);
        cancel.Visible=false;
        operationNotice.TextChanged+=(_,_)=>cancel.Visible=previewCancellation is not null;
        dialog.CancelButton=close;
        dialog.FormClosing+=(_,e)=>{ if(busy) { previewCancellation?.Cancel();e.Cancel=true; } };
        dialog.Controls.Add(content);update();
        try { dialog.ShowDialog(this); }
        finally { operationNotice=null;foreach(var button in localActions)actions.Remove(button); }
    }

    public async Task BeginSiteSetup(){RefreshState();Show();Activate();await SelectUpperFolderAsync(true);Hide();}
    public async Task BeginRecordingSetup(){RefreshState();Show();Activate();await SelectUpperFolderAsync(true,"call_recording");Hide();}
    private async Task SelectUpperFolderAsync(bool singleSite=false,string? requiredKind=null)
    {
        if(busy)return;
        if(!hasLogin()){MessageBox.Show(this,"먼저 계정 화면에서 로그인해 주세요.","로그인 필요");return;}
        using var picker=new FolderBrowserDialog {Description=requiredKind=="call_recording"?"업무 녹음파일 폴더를 선택하세요. 원음은 그대로 두고 허용한 녹음만 회사에 보관합니다.":"업무자료가 들어 있는 상위 폴더 하나를 선택하세요. 원본은 그대로 둡니다."};
        if(picker.ShowDialog(this)!=DialogResult.OK)return;
        SetBusy(true);string? startedSource=null;
        try {
            var recipient=await destination();if(recipient.Policy is null)throw new WindowsClientContractException();
            var volume=WindowsVolumeIdentity.Probe(picker.SelectedPath);
            var covering=WindowsCollectorRouting.Covering(state,volume,requiredKind);
            if(covering is not null){
                RefreshState();folders.SelectedIndex=items.ToList().FindIndex(f=>f.Id==covering.Id);
                MessageBox.Show(this,"이미 연결한 범위예요. 기존 폴더의 설정과 대기 자료를 유지합니다. ‘이 폴더 보기’에서 상태를 확인하거나, 여러 현장을 담은 더 상위 폴더를 골라 주세요.","기존 연결 유지");return;
            }
            if((!singleSite&&WindowsStateStore.KnownFolderKind(picker.SelectedPath)=="call_recording")||File.Exists(Path.Combine(picker.SelectedPath,"sigongnote-generated.json"))) {
                MessageBox.Show(this,"녹음 전용 폴더나 시공노트 정리본은 업무 상위 폴더로 연결할 수 없어요.","폴더 범위 확인");return;
            }
            var children=WindowsUpperFolder.Children(volume,state.Folders());
            bool Excluded(string path){var relative=Path.GetRelativePath(picker.SelectedPath,path);return children.Any(child=>WindowsUpperFolder.Contains(child,relative)) ||
                WindowsStateStore.KnownFolderKind(relative)=="call_recording" || new[]{".mp3",".m4a",".wav",".aac",".ogg",".flac",".amr"}.Contains(Path.GetExtension(path).ToLowerInvariant());}
            using var scan=new CancellationTokenSource();previewCancellation=scan;
            status.Text="선택한 범위를 확인하고 있어요. 원본은 그대로예요.";
            var preview=singleSite?new WindowsFolderScopePreview(0,0,0,DateTime.UtcNow,new Dictionary<string,int>()):await Task.Run(()=>WindowsFolderPreview.Scan(picker.SelectedPath,new FolderScopeBaseline(DateTime.MinValue,DateTime.UtcNow,false,new HashSet<string>()),scan.Token,Excluded),scan.Token);
            previewCancellation=null;if(IsDisposed)return;
            WindowsFolderSelection? selection;
            if(singleSite){using var consent=new WindowsFolderConsentForm(picker.SelectedPath,preview,recipient,requiredKind:requiredKind);if(consent.ShowDialog(this)!=DialogResult.OK)return;selection=consent.Selection;}
            else {using var consent=new WindowsUpperFolderConsentForm(picker.SelectedPath,preview,recipient,children.Count);if(consent.ShowDialog(this)!=DialogResult.OK)return;selection=consent.Selection;}
            // No source or queue is created until this one-screen consent is accepted.
            var current=await destination();if(current.Principal!=recipient.Principal||current.Origin!=recipient.Origin||!WindowsCapturePolicy.Same(current.Policy,recipient.Policy))throw new WindowsLoginRequiredException();
            if(WindowsCollectorRouting.Covering(state,volume,requiredKind) is not null)throw new WindowsSourceConflictException();
            var source=state.SelectFolder(picker.SelectedPath,recipient.Principal,selection!.NewOnly?0:selection.RecentOnly?30:null);startedSource=source.Id;
            await connectFolder(source.Id,recipient with {Selection=selection});
            sourcesChanged();RefreshState();folders.SelectedIndex=items.ToList().FindIndex(f=>f.Id==source.Id);
                status.Text=selection.NewOnly?"연결했어요. 지금부터 새 파일과 수정본을 업무일지로 모읍니다.":"기존 연결 범위를 유지했습니다. 과거 자료는 설정 → 과거 자료 보관·정리에서 별도로 확인하세요.";
        }catch(OperationCanceledException){if(!IsDisposed)status.Text="폴더 확인을 취소했어요.";}
        catch(Exception){if(startedSource is not null)state.PauseUnpreparedFolder(startedSource);if(!IsDisposed)MessageBox.Show(this,"연결 준비를 마치지 못했어요. 대기 자료와 원본은 보존했어요. 중지된 연결은 ‘이 폴더 보기 → 중지한 폴더 다시 읽기’에서 확인해 주세요. 준비가 저장된 연결은 연결되면 이어갑니다.","폴더 연결 확인");}
        finally{if(startedSource is not null){state.PauseUnpreparedFolder(startedSource);sourcesChanged();}previewCancellation=null;if(!IsDisposed){SetBusy(false);RefreshState();}}
    }

    private async Task ResumeSelectedFolderAsync()
    {
        if(busy)return;var index=folders.SelectedIndex;if(index<0||index>=items.Count)return;
        var folder=items[index];if(folder.State=="selected"){operationNotice!.Text="이미 읽고 있는 폴더예요.";return;}
        if(folder.RootPath is null){operationNotice!.Text="원래 저장장치를 연결한 뒤 다시 확인해 주세요.";return;}
        try {
            var recipient=await destination();
            if(!state.CanResumeFolder(folder.Id,recipient.Principal))throw new WindowsLoginRequiredException();
            if(MessageBox.Show(this,"이 폴더의 기존 허용 범위로 다시 읽을까요? 대기 자료·설정·원본은 유지합니다.","폴더 다시 읽기",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
            state.SelectFolder(folder.RootPath,recipient.Principal);
            if(folder.ServerSourceId.HasValue)await verifyFolder(folder.Id);
            RefreshState();folders.SelectedIndex=items.ToList().FindIndex(f=>f.Id==folder.Id);
            if(!folder.ServerSourceId.HasValue)await ConnectSelectedFolderAsync();
            sourcesChanged();RefreshState();
        }catch{state.PauseSource(folder.Id);RefreshState();operationNotice!.Text="같은 계정과 전송 허용을 확인하지 못해 읽기를 멈췄어요. 대기 자료는 보존했어요.";}
    }

    private void PauseFolder()
    {
        var index = folders.SelectedIndex;
        if (index < 0 || index >= items.Count) return;
        var sourceId=items[index].Id;
        if(MessageBox.Show(this,"새 자료 읽기를 멈출까요? 이 PC에 보관한 복사본과 원본은 그대로 남아요.",
            "이 폴더 읽기 멈추기",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)!=DialogResult.Yes)return;
        state.PauseSource(sourceId);
        sourcesChanged();
        RefreshState();
    }

    private async Task ConnectSelectedFolderAsync()
    {
        if (busy) return;
        if(!hasLogin()) {
            MessageBox.Show(this,"먼저 계정 화면에서 로그인해 주세요.","로그인 필요",MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        var index = folders.SelectedIndex;
        if (index < 0 || index >= items.Count) return;
        var folder = items[index];
        if (folder.State != "selected" || folder.RootPath is null) {
            MessageBox.Show(this,"먼저 폴더를 다시 선택해 주세요.","업무 폴더",
                MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        SetBusy(true);
        try {
            if(operationNotice is not null)operationNotice.Text="받는 회사와 전송 허용을 확인하고 있어요.";
            if(folder.ServerSourceId.HasValue) {
                await verifyFolder(folder.Id);
                if(!IsDisposed && operationNotice is not null)operationNotice.Text="서버에서 전송 허용을 확인했어요.";
                return;
            }
            var recipient=await destination();
            using var scan=new CancellationTokenSource();
            previewCancellation=scan;
            if(operationNotice is not null)operationNotice.Text="폴더를 살펴보고 있어요. 취소해도 원본은 그대로예요.";
            var preview = await Task.Run(() => WindowsFolderPreview.Scan(folder.RootPath,
                state,folder.Id,scan.Token),scan.Token);
            previewCancellation=null;
            if(operationNotice is not null)operationNotice.Text="보낼 범위를 확인해 주세요.";
            if (IsDisposed) return;
            WindowsFolderSelection? selection;
            var previous=state.FolderSetup(folder.Id)?.Selection;
            if(previous is null||previous.ManagedRoot){
                using var consent=new WindowsUpperFolderConsentForm(folder.RootPath,preview,recipient,state.ChildScopeExclusions(folder.Id).Count,previous);
                if(consent.ShowDialog(this)!=DialogResult.OK){state.PauseUnpreparedFolder(folder.Id);return;}
                selection=consent.Selection;
            }else{
                using var consent=new WindowsFolderConsentForm(folder.RootPath,preview,recipient,previous);
                if(consent.ShowDialog(this)!=DialogResult.OK)return;selection=consent.Selection;
            }
            await connectFolder(folder.Id,recipient with {Selection=selection});
            if(operationNotice is not null)operationNotice.Text="이 회사로 새 자료를 보내도록 허용했어요.";
            if (!IsDisposed) RefreshState();
        } catch(OperationCanceledException) {
            if(operationNotice is not null)operationNotice.Text="폴더 확인을 취소했어요. 아직 보내지 않았어요.";
        } catch (WindowsLoginRequiredException) {
            if (!IsDisposed) MessageBox.Show(this,"먼저 업무 계정에 로그인해 주세요.",
                "로그인 필요",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (WindowsSessionUnavailableException) {
            if (!IsDisposed) MessageBox.Show(this,"서버에 닿지 못했어요. 잠시 후 다시 시도해 주세요.",
                "잠시 후 다시 시도",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (WindowsSourcePermissionException) {
            if (!IsDisposed) MessageBox.Show(this,"이 계정에는 폴더 전송 권한이 없습니다.",
                "전송 권한 확인",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (WindowsSourceInactiveException) {
            if (!IsDisposed) MessageBox.Show(this,
                "이 폴더는 서버로 보내지 않아요. 업무 폴더를 다시 골라 주세요.",
                "전송 중지",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } catch (WindowsSourceConflictException) {
            if (!IsDisposed) MessageBox.Show(this,
                "기기와 폴더의 등록 기록이 달라요. 담당자에게 알려 주세요.",
                "등록 확인 필요",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } catch (WindowsScopeSetupRequiredException) {
            if (!IsDisposed) MessageBox.Show(this,"전체 기간 자료는 이 PC에서 읽을 수 있어요. 서버 전송은 새 폴더 연결 기능에서 이어집니다.",
                "폴더 연결 준비 중",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (WindowsClientContractException) {
            if (!IsDisposed) MessageBox.Show(this,
                "앱을 업데이트한 뒤 다시 시도해 주세요.",
                "앱 버전 확인",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } catch (UnauthorizedAccessException) {
            if (!IsDisposed) MessageBox.Show(this,
                "읽을 수 없는 하위 폴더가 있습니다. 접근 가능한 업무 하위 폴더를 선택해 주세요.",
                "폴더 접근 제한",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (IOException) {
            if (!IsDisposed) MessageBox.Show(this,
                "파일이 너무 많거나 폴더를 읽을 수 없습니다. 더 작은 업무 하위 폴더를 선택해 주세요.",
                "폴더 범위 제한",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (Exception) {
            if (!IsDisposed) MessageBox.Show(this,
                "폴더 준비를 마치지 못했어요. 이 PC에서 열리는 폴더인지 확인해 주세요.",
                "업무 폴더",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } finally {
            if(!folder.ServerSourceId.HasValue)state.PauseUnpreparedFolder(folder.Id);
            previewCancellation=null;
            if(operationNotice is not null && (operationNotice.Text.StartsWith("폴더를 살펴",StringComparison.Ordinal) ||
                operationNotice.Text.StartsWith("받는 회사",StringComparison.Ordinal) || operationNotice.Text=="보낼 범위를 확인해 주세요."))
                operationNotice.Text="준비를 마치지 못했어요. 위 안내를 확인하고 다시 시도해 주세요.";
            if (!IsDisposed) { SetBusy(false);RefreshState(); }
        }
    }

    private async Task ApproveSelectedBackfillAsync()
    {
        if (busy) return;
        var index = folders.SelectedIndex;
        if (index < 0 || index >= items.Count) return;
        var folder = items[index];
        var snapshot = state.BackfillSnapshot(folder.Id);
        if (!folder.ServerSourceId.HasValue || snapshot.Count == 0) {
            MessageBox.Show(this,!folder.ServerSourceId.HasValue ? "먼저 서버 전송을 허용해 주세요." : "따로 보낼 과거 자료가 없어요.",
                "보관된 자료",MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        SetBusy(true);
        try {
            var recipient=await destination();
            if (MessageBox.Show(this,
                $"받는 곳: {recipient.Company}\n{recipient.Origin}\n\n"+
                $"이 폴더의 보관된 복사본 {snapshot.Count:N0}건을 보낼까요? 과거 자료가 포함될 수 있어요. 원본은 그대로예요.",
                "과거 자료 보내기",MessageBoxButtons.YesNo,MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            var approved = await approveBackfill(folder.Id,snapshot,recipient);
            if (!IsDisposed) {
                RefreshState();
                MessageBox.Show(this,$"{approved:N0}건의 전송 대기를 승인했습니다.",
                    "기존 자료 승인",MessageBoxButtons.OK,MessageBoxIcon.Information);
            }
        } catch (WindowsLoginRequiredException) {
            if (!IsDisposed) MessageBox.Show(this,"먼저 업무 계정에 로그인해 주세요.",
                "로그인 필요",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (BackfillSetChangedException) {
            if (!IsDisposed) MessageBox.Show(this,
                "승인 대기 자료가 바뀌었습니다. 건수를 다시 확인하고 승인해 주세요.",
                "자료 변경",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch (WindowsSourcePermissionException) {
            if (!IsDisposed) MessageBox.Show(this,
                "이 계정에는 과거 자료 전송 권한이 없습니다. 재시도로 해결되지 않습니다.",
                "승인 권한",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } catch (WindowsSourceInactiveException) {
            if (!IsDisposed) MessageBox.Show(this,
                "이 폴더는 서버로 보내지 않아요. 업무 폴더를 다시 골라 주세요.",
                "전송 중지",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } catch (WindowsSourceConflictException) {
            if (!IsDisposed) MessageBox.Show(this,
                "서버의 폴더 등록 기록이 달라요. 담당자에게 알려 주세요.",
                "등록 확인 필요",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } catch (Exception) {
            if (!IsDisposed) MessageBox.Show(this,
                "서버가 자료를 받을 수 있는지 확인하지 못했어요. 자료는 이 PC에 보관해요.",
                "승인 대기",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        } finally { if (!IsDisposed) SetBusy(false); }
    }

    private void SetBusy(bool value)
    {
        busy = value;
        foreach (var action in actions) action.Enabled = !value;
    }
}
