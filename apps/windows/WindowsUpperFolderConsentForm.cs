using System.Drawing;

namespace Sigongnote.Windows;

public sealed class WindowsUpperFolderConsentForm:Form
{
    public WindowsFolderSelection? Selection {get;private set;}
    public WindowsUpperFolderConsentForm(string path,WindowsFolderScopePreview preview,WindowsUploadDestination destination,int separateFolders,WindowsFolderSelection? previous=null)
    {
        if(destination.Policy is null)throw new WindowsClientContractException();
        var policy=destination.Policy;
        Text="폴더 자동 정리";Font=new Font("Malgun Gothic",12);AutoScaleMode=AutoScaleMode.Dpi;
        Width=620;Height=Math.Min(670,Screen.PrimaryScreen?.WorkingArea.Height??670);MinimumSize=new Size(580,500);
        MaximizeBox=false;MinimizeBox=false;StartPosition=FormStartPosition.CenterParent;BackColor=Color.White;ForeColor=Color.FromArgb(26,32,44);
        var content=new FlowLayoutPanel {Dock=DockStyle.Fill,AutoScroll=true,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(28)};
        void Note(string text,bool heading=false)=>content.Controls.Add(new Label {Text=text,AutoSize=true,MaximumSize=new Size(520,0),Margin=new Padding(0,0,0,14),Font=heading?new Font(Font.FontFamily,20,FontStyle.Bold):Font});
        Note("새 자료를 자동으로 정리",true);Note(path);
        Note($"{destination.Company} · 이 폴더와 하위 폴더\n연결 후 새로 저장하는 문서·사진을 현장별로 정리합니다.");
        if(separateFolders>0)Note($"이미 연결한 하위 폴더 {separateFolders}곳은 기존 설정을 유지합니다.");
        Note("원본은 그대로 두고 회사에 복사본을 보관합니다.");
        var copies=new CheckBox {Text="정리본을 이 PC에도 저장",Checked=previous?.DownloadCopies??true,AutoSize=true,MinimumSize=new Size(0,38)};
        var journal=new CheckBox {Text="업무일지도 PC에 저장",Checked=previous?.JournalCopies??false,AutoSize=true,MinimumSize=new Size(0,38)};
        var plaintext=new CheckBox {Text="텍스트·CSV 사본 저장",Checked=previous?.PlaintextCopies??false,AutoSize=true,MinimumSize=new Size(0,38)};
        var advanced=new FlowLayoutPanel {AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false,Visible=false};
        copies.CheckedChanged+=(_,_)=>journal.Enabled=copies.Checked;journal.Enabled=copies.Checked;advanced.Controls.AddRange([copies,journal,plaintext]);
        var options=new Button {Text="저장 옵션",AutoSize=true,FlatStyle=FlatStyle.Flat,MinimumSize=new Size(110,36)};
        options.FlatAppearance.BorderSize=0;options.Click+=(_,_)=>advanced.Visible=!advanced.Visible;content.Controls.Add(options);content.Controls.Add(advanced);
        Note(WindowsCapturePolicy.Describe(policy));
        Note("‘연결하고 시작’을 누르면 위 범위의 보관·자료 처리를 시작합니다.");
        var buttons=new FlowLayoutPanel {Dock=DockStyle.Bottom,AutoSize=true,Padding=new Padding(28,12,28,20)};
        var start=new Button {Text="연결하고 시작",AutoSize=true,MinimumSize=new Size(280,52),FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(35,57,130),ForeColor=Color.White};
        start.FlatAppearance.BorderSize=0;
        var cancel=new Button {Text="취소",AutoSize=true,MinimumSize=new Size(110,52),DialogResult=DialogResult.Cancel};
        start.Click+=(_,_)=>{
            Selection=new("folder",null,null,false,false,DownloadCopies:copies.Checked,PlaintextCopies:plaintext.Checked,Unassigned:true,ManagedRoot:true,
                NewOnly:previous?.NewOnly??true,JournalCopies:journal.Checked&&copies.Checked);
            DialogResult=DialogResult.OK;Close();
        };
        buttons.Controls.AddRange([start,cancel]);Controls.Add(content);Controls.Add(buttons);AcceptButton=start;CancelButton=cancel;
    }
}
