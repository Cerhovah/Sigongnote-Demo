using System.Drawing;
using System.Windows.Forms;
using Sigongnote.Contracts;

namespace Sigongnote.Windows;

/// <summary>Small native login surface; the OTP and bearer never enter a WebView.</summary>
public sealed class WindowsLoginForm : Form
{
    private readonly WindowsAuthOnboarding onboarding;
    private readonly WindowsWorkspaceBootstrap bootstrap;
    private readonly TextBox companyName=new(){Width=480,MaxLength=120,AccessibleName="회사 이름",Text="우리 회사"};
    private readonly Button otherAccount=new(){Text="기존 계정으로 다시 로그인",AutoSize=true,MinimumSize=new Size(280,56)};
    private readonly WindowsTokenVault pendingVault;
    private WindowsConnectionOptions options;
    private readonly Button google=new() { Text="Google 계정으로 로그인",AutoSize=true,
        MinimumSize=new Size(280,56),BackColor=Color.White,ForeColor=Color.Black,FlatStyle=FlatStyle.Flat };
    private readonly Button naver=new() {Text="네이버로 시작하기",AutoSize=true,MinimumSize=new Size(280,56),BackColor=Color.FromArgb(3,199,90),ForeColor=Color.White};
    private readonly Button kakao=new() {Text="카카오로 시작하기",AutoSize=true,MinimumSize=new Size(280,56),BackColor=Color.FromArgb(254,229,0),ForeColor=Color.Black};
    private readonly Button emailChoice=new() { Text="이메일로 로그인",AutoSize=true,MinimumSize=new Size(240,56) };
    private bool emailMode;
    private bool checkingProviders;
    private int loginAttempt;
    private readonly Button providerRefresh=new(){Text="로그인 준비 상태 확인",AutoSize=true,MinimumSize=new Size(280,56)};
    private readonly TextBox email = new() { Width = 480, AccessibleName="업무 이메일" };
    private readonly TextBox code = new() { Width = 200, MaxLength = 8, AccessibleName="이메일로 받은 코드" };
    private readonly ComboBox workspace = new() { Width = 340,
        DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName="우리 회사" };
    private readonly Label guidance = new() { AutoSize = true, MaximumSize = new Size(400,0) };
    private readonly Label error = new() { AutoSize = true,
        MaximumSize = new Size(400,0), ForeColor = Color.DarkRed };
    private readonly Button next = new() { AutoSize = true, MinimumSize=new Size(200,56),
        Padding=new Padding(12,8,12,8),FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(23,88,68),ForeColor=Color.White };
    private readonly Button resend = new() { Text = "코드 다시 받기", AutoSize = true,MinimumSize=new Size(180,56) };
    private int stage;
    private bool busy;
    private bool closeRequested;
    private CancellationTokenSource? operation;

    private sealed record TenantChoice(Guid Id, string Name)
    {
        public override string ToString() => Name;
    }

    public WindowsLoginForm(WindowsConnectionOptions options, WindowsTokenVault pending,
        WindowsTokenVault session, WindowsDeviceKeyStore deviceKeys)
    {
        pendingVault = pending;
        this.options=options;
        emailMode=new Uri(options.ApiBaseUrl).Scheme=="http" && !(options.GoogleEnabled || options.NaverEnabled || options.KakaoEnabled);
        onboarding = new WindowsAuthOnboarding(options,pending,session,deviceKeys);
        bootstrap=new WindowsWorkspaceBootstrap(options,pending,new WindowsTokenVault(Path.Combine(Path.GetDirectoryName(WindowsStateStore.DefaultPath)!,"workspace-bootstrap.protected")));
        Text = "시공노트" + Program.BuildVersionSuffix();
        Font = new Font("Malgun Gothic",12);
        AutoScaleMode=AutoScaleMode.Dpi;
        Width = 520;
        Height = 390;
        MinimumSize = new Size(500,360);
        BackColor = Color.White;
        ForeColor = Color.FromArgb(26,32,44);
        StartPosition = FormStartPosition.CenterParent;
        MaximizeBox = false;
        MinimizeBox = false;
        var content = new FlowLayoutPanel { Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,WrapContents = false,
            AutoScroll = true,Padding = new Padding(30) };
        content.Controls.Add(new Label { Text = "내 업무, 한곳에서",AutoSize = true,
            Margin = new Padding(0,0,0,12),Font = new Font(Font.FontFamily,22,FontStyle.Bold) });
        guidance.Margin=new Padding(0,0,0,24);
        guidance.ForeColor=Color.FromArgb(90,100,116);
        naver.MinimumSize=new Size(420,54);naver.FlatStyle=FlatStyle.Flat;
        naver.FlatAppearance.BorderSize=0;naver.Margin=new Padding(0,0,0,12);
        error.Margin=new Padding(0,12,0,0);error.ForeColor=Color.FromArgb(90,100,116);
        email.Width=420;companyName.Width=420;
        content.Controls.Add(guidance);
        content.Controls.Add(naver);content.Controls.Add(providerRefresh);providerRefresh.Click+=async (_,_)=>await RefreshProvidersAsync();
        content.Controls.Add(kakao);content.Controls.Add(google);content.Controls.Add(emailChoice);
        naver.Click+=async (_,_)=>await GoogleAsync("custom:naver");kakao.Click+=async (_,_)=>await GoogleAsync("custom:kakao");
        google.Click+=async (_,_)=>await GoogleAsync();
        emailChoice.Click+=(_,_)=>{emailMode=true;ShowStage();};
        content.Controls.Add(email);
        content.Controls.Add(code);
        content.Controls.Add(workspace);content.Controls.Add(companyName);content.Controls.Add(otherAccount);
        otherAccount.Click+=(_,_)=>{if(busy)return;pendingVault.Clear();stage=0;error.Text="기존 자료를 보려면 전에 쓰던 계정으로 로그인해 주세요.";ShowStage();};
        companyName.TextChanged+=(_,_)=>UpdateNext();
        content.Controls.Add(error);
        var buttons = new FlowLayoutPanel { AutoSize = true,WrapContents = false };
        next.Click += async (_,_) => await AdvanceAsync();
        workspace.SelectedIndexChanged+=(_,_)=>UpdateNext();
        resend.Click += async (_,_) => await SendAgainAsync();
        buttons.Controls.Add(next);
        buttons.Controls.Add(resend);
        content.Controls.Add(buttons);
        Controls.Add(content);
        AcceptButton = next;
        FormClosing += (_,args) => {
            if (!busy || DialogResult == DialogResult.OK) return;
            closeRequested = true;
            operation?.Cancel();
            args.Cancel = true;
        };
        FormClosed += (_,_) => {
            if (DialogResult != DialogResult.OK) pendingVault.Clear();
            onboarding.Dispose();bootstrap.Dispose();
        };
        ShowStage();
        Shown+=async (_,_)=>await RefreshProvidersAsync();
    }

    private async Task RefreshProvidersAsync()
    {
        if(new Uri(options.ApiBaseUrl).Scheme!="https" || checkingProviders || busy || stage!=0)return;
        var attempt=loginAttempt;
        checkingProviders=true;providerRefresh.Enabled=false;error.Text=options.NaverEnabled?"":"로그인 준비 중…";
        try {
            using var handler=new HttpClientHandler {AllowAutoRedirect=false};
            using var http=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(8),MaxResponseContentBufferSize=65536};
            using var response=await http.GetAsync(options.ApiBaseUrl.TrimEnd('/')+"/connection.json");
            response.EnsureSuccessStatusCode();
            using var json=System.Text.Json.JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var root=json.RootElement;
            if(root.GetProperty("mode").GetString()!="cloud" || root.GetProperty("apiOrigin").GetString()!=options.ApiBaseUrl.TrimEnd('/'))throw new InvalidOperationException("Unexpected provider service");
            var providers=root.GetProperty("providers").EnumerateArray().Select(p=>p.GetString()).ToArray();
            if(providers.Any(p=>p is not ("google" or "custom:naver" or "custom:kakao")))throw new InvalidOperationException("Unexpected login provider");
            if(IsDisposed || Disposing || busy || stage!=0 || attempt!=loginAttempt)return;
            options=options with {NaverEnabled=providers.Contains("custom:naver"),GoogleEnabled=false,KakaoEnabled=false};
            ShowStage();error.Text=options.NaverEnabled?"":"네이버 로그인 연결을 확인해 주세요.";
        } catch { if(!IsDisposed && !Disposing && !busy && stage==0 && attempt==loginAttempt)error.Text=options.NaverEnabled
            ?"로그인 준비 상태를 확인하지 못했어요. 네이버로 시작하기를 눌러 주세요."
            :"로그인 준비 상태를 확인하지 못했어요. 로그인 준비 상태 확인을 다시 눌러 주세요."; }
        finally {checkingProviders=false;if(!IsDisposed && !Disposing)providerRefresh.Enabled=!busy;}
    }

    private void ShowStage()
    {
        google.Visible=false;
        naver.Visible=stage==0 && !emailMode;kakao.Visible=false;
        naver.Enabled=!busy && options.NaverEnabled;kakao.Enabled=!busy && options.KakaoEnabled;
        naver.BackColor=naver.Enabled?Color.FromArgb(3,199,90):SystemColors.Control;naver.ForeColor=naver.Enabled?Color.White:SystemColors.ControlText;
        kakao.BackColor=kakao.Enabled?Color.FromArgb(254,229,0):SystemColors.Control;
        naver.Text=options.NaverEnabled?"네이버로 시작하기":"네이버 로그인 · 연결 준비 중";
        kakao.Text=options.KakaoEnabled?"카카오로 시작하기":"카카오 로그인 · 연결 준비 중";
        emailChoice.Visible=stage==0 && !emailMode && new Uri(options.ApiBaseUrl).Scheme=="http";
        providerRefresh.Visible=stage==0 && !emailMode && !options.NaverEnabled && new Uri(options.ApiBaseUrl).Scheme=="https";
        providerRefresh.Enabled=!busy && !checkingProviders;
        next.Visible=stage!=4 && (stage!=0 || emailMode);
        AcceptButton=naver.Visible && naver.Enabled ? naver : kakao.Visible && kakao.Enabled ? kakao : google.Visible ? google : providerRefresh.Visible ? providerRefresh : next;
        email.Visible = stage == 0 && emailMode;
        code.Visible = stage == 1;
        workspace.Visible = stage == 2 && workspace.Items.Count > 1;
        if(stage==3) {companyName.ReadOnly=bootstrap.HasDraft();if(companyName.ReadOnly)companyName.Text=bootstrap.SuggestedName();}
        companyName.Visible=stage==3;otherAccount.Visible=stage is 3 or 4;
        resend.Visible = stage == 1;
        guidance.Text = stage switch {
            0 => emailMode ? "업무 이메일로 로그인하세요." : "견적서, 사진, 오늘 할 일을 바로 확인하세요.",
            1 => "이메일로 받은 6자리 코드를 입력하세요.",
            3 => companyName.ReadOnly ? "회사 연결을 이어갑니다." : "사용할 회사 이름을 입력하세요.",
            4 => "이전 회사 권한을 확인해야 해요. 회사 대표에게 초대를 요청하거나 기존 계정으로 로그인해 주세요.",
            _ => "사용할 회사를 선택하세요.",
        };
        next.Text = stage switch {
            0 => "로그인 코드 받기", 1 => "코드 확인", 3 => "회사 만들고 시작하기", _ => "이 회사로 시작하기",
        };
        if (stage == 1) code.Focus();
        else if (stage == 2 && workspace.Visible) workspace.Focus();
        UpdateNext();
    }

    private void UpdateNext()=>next.Enabled=!busy && (stage!=2 || workspace.SelectedItem is TenantChoice) && (stage!=3 || !string.IsNullOrWhiteSpace(companyName.Text));

    private async Task SelectCompanyAsync(CancellationToken cancellation)
    {
        var tenants=await onboarding.AvailableTenantsAsync(cancellation);
        if(tenants.Length==0) {
            companyName.Text=bootstrap.SuggestedName();stage=3;
            error.Text="전에 다른 계정으로 쓰셨다면 아래에서 그 계정으로 다시 로그인해 주세요.";
            return;
        }
        workspace.Items.Clear();
        foreach(MeResponseMembershipsItem tenant in tenants)
            workspace.Items.Add(new TenantChoice(Guid.Parse(tenant.tenant_id),tenant.tenant_name));
        workspace.SelectedIndex=tenants.Length==1 ? 0 : -1;stage=2;
        if(tenants.Length==1)await CompleteAsync(cancellation);
    }

    private async Task GoogleAsync(string provider="google")
    {
        if(busy)return;
        loginAttempt++;
        busy=true;naver.Enabled=false;kakao.Enabled=false;google.Enabled=false;emailChoice.Enabled=false;next.Enabled=false;providerRefresh.Enabled=false;
        error.Text="브라우저에서 로그인하면 자동으로 연결됩니다.";
        using var cancellation=new CancellationTokenSource();operation=cancellation;
        var authenticated=false;
        try {
            using var login=new WindowsGoogleLogin(options,pendingVault,provider:provider);
            await login.SignInAsync(url=>System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url.AbsoluteUri) { UseShellExecute=true }),cancellation.Token);
            if(!closeRequested && !IsDisposed)Activate();
            authenticated=true;error.Text="계정을 확인했어요. 회사에 연결하고 있어요…";
            await SelectCompanyAsync(cancellation.Token);
            if(!IsDisposed && stage==2)error.Text="";
        } catch(OperationCanceledException) { pendingVault.Clear();error.Text="로그인을 마치지 않았어요. 다시 시도해 주세요."; }
          catch(Exception) { pendingVault.Clear();stage=0;error.Text=authenticated
            ? "계정 인증은 완료됐지만 회사 연결을 마치지 못했어요. 잠시 후 다시 로그인해 주세요."
            : "로그인을 마치지 못했어요. 브라우저와 계정을 확인해 주세요."; }
        finally {
            busy=false;operation=null;
            if(closeRequested && !IsDisposed)Close();
            else if(!IsDisposed) {google.Enabled=true;emailChoice.Enabled=true;ShowStage();}
        }
    }

    private async Task AdvanceAsync()
    {
        if (busy) return;
        busy = true;
        next.Enabled = false;
        resend.Enabled = false;
        error.Text = "";
        error.ForeColor = Color.DarkRed;
        using var call = new CancellationTokenSource();
        operation = call;
        try {
            if (stage == 0) {
                await onboarding.RequestCodeAsync(email.Text.Trim(),call.Token);
                stage = 1;
            } else if (stage == 1) {
                await onboarding.VerifyCodeAsync(email.Text.Trim(),code.Text.Trim(),call.Token);
                await SelectCompanyAsync(call.Token);
            } else if(stage==3) {
                await bootstrap.CreateAsync(companyName.Text,call.Token);
                await SelectCompanyAsync(call.Token);
            } else {
                await CompleteAsync(call.Token);
            }
        } catch (WindowsWorkspaceInvitationException) {
            stage=4;error.Text="회사 이름의 문제가 아니에요. 기존 회사의 접근 권한이 필요해요.";
        } catch (ArgumentException) {
            error.Text = stage == 3 ? "회사 이름을 확인해 주세요." : stage == 0 ? "이메일 주소를 확인해 주세요." :
                "코드를 확인해 주세요.";
        } catch (WindowsLoginRequiredException) {
            var expiredAtWorkspace = stage is 2 or 3 or 4;
            if (expiredAtWorkspace) {
                pendingVault.Clear();
                stage = 0;
            }
            error.Text = expiredAtWorkspace ? "로그인이 만료됐어요. 다시 로그인해 주세요." :
                stage == 0 ? "가입된 이메일인지 확인해 주세요." :
                "코드 또는 로그인 권한을 확인해 주세요. 필요하면 새 코드를 받으세요.";
        } catch (WindowsSessionUnavailableException) {
            error.Text = "서버에 닿지 못했어요. 잠시 후 다시 시도해 주세요.";
        } catch (IOException) {
            error.Text = "이 PC의 보호 저장소를 확인해 주세요.";
        } catch (OperationCanceledException) when (closeRequested) {
            // FormClosing waits for this operation before disposing the client.
        } catch (ObjectDisposedException) when (closeRequested) {
            // A canceled response can race with disposal during application exit.
        } catch (Exception) {
            error.Text = stage==3 ? "회사 만들기를 확인하지 못했어요. 다시 누르면 이어서 확인해요." : "로그인을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.";
        } finally {
            busy = false;
            operation = null;
            if (closeRequested && !IsDisposed) Close();
            else if (!IsDisposed) {
                next.Enabled = true;
                resend.Enabled = true;
                ShowStage();
            }
        }
    }

    private async Task CompleteAsync(CancellationToken cancellation)
    {
        if (workspace.SelectedItem is not TenantChoice choice) return;
        await onboarding.CompleteEnrollmentAsync(choice.Id,cancellation);
        code.Clear();
        DialogResult = DialogResult.OK;
        Close();
    }

    private async Task SendAgainAsync()
    {
        if (busy) return;
        busy = true;
        resend.Enabled = false;
        next.Enabled = false;
        error.Text = "";
        using var call = new CancellationTokenSource();
        operation = call;
        try {
            await onboarding.RequestCodeAsync(email.Text.Trim(),call.Token);
            error.ForeColor = Color.DarkGreen;
            error.Text = "새 코드를 보냈습니다.";
        } catch (WindowsSessionUnavailableException) {
            error.ForeColor = Color.DarkRed;
            error.Text = "지금 코드를 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.";
        } catch (WindowsLoginRequiredException) {
            error.ForeColor = Color.DarkRed;
            error.Text = "가입된 이메일인지 확인해 주세요.";
        } catch (OperationCanceledException) when (closeRequested) {
            // FormClosing waits for the request to settle.
        } catch (ObjectDisposedException) when (closeRequested) {
            // The form is exiting.
        } catch (Exception) {
            error.ForeColor = Color.DarkRed;
            error.Text = "코드를 다시 보내지 못했습니다. 잠시 후 시도해 주세요.";
        } finally {
            busy = false;
            operation = null;
            if (closeRequested && !IsDisposed) Close();
            else if (!IsDisposed) { resend.Enabled = true; next.Enabled = true; }
        }
    }
}
