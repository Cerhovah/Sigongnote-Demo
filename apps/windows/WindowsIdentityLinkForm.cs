using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace Sigongnote.Windows;

public sealed class WindowsIdentityLinkForm:Form
{
    private CancellationTokenSource? active;
    private bool closeRequested;
    public WindowsIdentityLinkForm(WindowsConnectionOptions options,WindowsTokenVault sessionVault,WindowsTokenVault pending)
    {
        Text="내 로그인 수단 추가";Font=new Font("Malgun Gothic",14);Width=620;Height=500;AutoScaleMode=AutoScaleMode.Dpi;StartPosition=FormStartPosition.CenterParent;
        var panel=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(24)};
        var status=new Label{Text="본인 계정만 연결하세요. 연결한 계정은 지금과 같은 회사 권한으로 로그인돼요. 브라우저에 다른 사람이 로그인돼 있으면 먼저 로그아웃해 주세요. 직원 초대는 별도 기능이에요.",AutoSize=true,MaximumSize=new Size(520,0)};panel.Controls.Add(status);
        var buttons=new List<Button>();
        foreach(var (provider,label,enabled) in new[]{("custom:naver","내 네이버로도 로그인하기",options.NaverEnabled),("custom:kakao","내 카카오로도 로그인하기",options.KakaoEnabled),("google","내 Google로도 로그인하기",options.GoogleEnabled)}) {
            if(!enabled)continue;
            var button=new Button{Text=label,AutoSize=true,MinimumSize=new Size(280,56)};buttons.Add(button);panel.Controls.Add(button);
            button.Click+=async (_,_)=>{
                if(active is not null)return;using var cancellation=new CancellationTokenSource();active=cancellation;buttons.ForEach(row=>row.Enabled=false);
                try {
                    using var manager=new WindowsSessionManager(sessionVault);var before=await manager.CurrentAsync(cancellation.Token);
                    pending.Clear();using var flow=new WindowsGoogleLogin(options,pending,provider:provider);
                    status.Text="브라우저에서 본인 계정인지 확인해 주세요. 연결하면 지금과 같은 회사 권한으로 로그인돼요.";
                    await flow.SignInAsync(url=>System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url.AbsoluteUri){UseShellExecute=true}),cancellation.Token,before);
                    var replacement=JsonSerializer.Deserialize<WindowsPendingAuth>(pending.Read() ?? "",new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? throw new WindowsLoginRequiredException();
                    await manager.ApplyLinkedLoginAsync(before,replacement,cancellation.Token);status.Text="같은 회사와 자료를 이 계정으로도 볼 수 있게 연결했어요.";
                } catch(OperationCanceledException) {status.Text="연결 확인을 마치지 않았어요. 기존 계정은 그대로예요.";}
                  catch(Exception) {status.Text="계정 연결을 확인하지 못했어요. 기존 계정은 그대로예요. 다시 확인해 주세요.";}
                finally {pending.Clear();active=null;buttons.ForEach(row=>row.Enabled=true);if(closeRequested)Close();}
            };
        }
        if(buttons.Count==0)status.Text="계정 연결을 준비 중이에요. 지금 쓰던 계정과 자료는 그대로예요.";
        var back=new Button{Text="돌아가기",AutoSize=true,MinimumSize=new Size(180,56)};back.Click+=(_,_)=>Close();panel.Controls.Add(back);Controls.Add(panel);
        FormClosing+=(_,e)=>{if(active is null)return;closeRequested=true;active.Cancel();e.Cancel=true;};
    }
}
