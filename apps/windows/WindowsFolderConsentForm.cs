using System.Drawing;
using System.Windows.Forms;

namespace Sigongnote.Windows;

/// <summary>One action confirms the selected scope and its current processing policy.</summary>
public sealed class WindowsFolderConsentForm : Form
{
    public WindowsFolderSelection? Selection { get; private set; }

    public WindowsFolderConsentForm(string rootPath, WindowsFolderScopePreview preview, WindowsUploadDestination destination, WindowsFolderSelection? previous=null,string? requiredKind=null)
    {
        Text="폴더 자동 정리";Font=new Font("Malgun Gothic",12);AutoScaleMode=AutoScaleMode.Dpi;
        Width=600;Height=Math.Min(680,Screen.PrimaryScreen?.WorkingArea.Height??680);
        MinimumSize=new Size(560,500);StartPosition=FormStartPosition.CenterParent;
        MaximizeBox=false;MinimizeBox=false;BackColor=Color.White;ForeColor=Color.FromArgb(26,32,44);
        var content=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(28)};
        void Note(string text,bool heading=false)=>content.Controls.Add(new Label {Text=text,AutoSize=true,MaximumSize=new Size(510,0),Margin=new Padding(0,0,0,12),Font=heading?new Font(Font.FontFamily,20,FontStyle.Bold):Font});
        Note("새 자료를 자동으로 정리",true);
        Note(rootPath);
        Note($"{destination.Company} · 연결 후 새로 저장하는 자료부터\n원본은 그대로 두고 회사에 복사본을 보관합니다.");

        var modern=destination.Policy is not null;
        var kind=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=490,AccessibleName="자료 종류"};
        kind.Items.AddRange(["문서와 현장 사진","사진만","통화 녹음파일"]);kind.SelectedIndex=0;
        var project=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=490,AccessibleName="현장 선택"};
        project.Items.Add("새 현장");foreach(var item in destination.Projects??[])project.Items.Add(item);project.SelectedIndex=0;
        for(var i=1;i<project.Items.Count;i++)if(project.Items[i] is WindowsProjectChoice item && item.id==destination.FirstProject)project.SelectedIndex=i;
        var name=new TextBox {Width=490,MaxLength=80,Text=Path.GetFileName(rootPath.TrimEnd(Path.DirectorySeparatorChar)),AccessibleName="현장 이름"};
        var common=new CheckBox {Text="회사 공통 자료",AutoSize=true,MinimumSize=new Size(0,38)};
        var copies=new CheckBox {Text="정리본을 이 폴더에도 저장",Checked=previous?.DownloadCopies??true,AutoSize=true,MinimumSize=new Size(0,38)};
        var journal=new CheckBox {Text="업무일지도 PC에 저장",Checked=previous?.JournalCopies??false,AutoSize=true,MinimumSize=new Size(0,38)};
        var plaintext=new CheckBox {Text="텍스트·CSV 사본 저장",Checked=previous?.PlaintextCopies??false,AutoSize=true,MinimumSize=new Size(0,38)};
        var known=WindowsStateStore.KnownFolderKind(rootPath);
        if(known is not null){kind.SelectedIndex=known=="photos"?1:2;kind.Enabled=false;}
        if(previous is not null){
            var priorKind=Array.IndexOf(new[]{"folder","photos","call_recording"},previous.Kind);
            if(priorKind>=0)kind.SelectedIndex=priorKind;
            common.Checked=previous.Common;if(previous.NewProjectName is not null)name.Text=previous.NewProjectName;
            for(var i=1;i<project.Items.Count;i++)if(project.Items[i] is WindowsProjectChoice item && item.id==previous.ProjectId?.ToString("D"))project.SelectedIndex=i;
        }
        if(requiredKind=="call_recording"){kind.SelectedIndex=2;kind.Enabled=false;}
        if(modern){
            content.Controls.Add(project);content.Controls.Add(name);
            var advanced=new FlowLayoutPanel {AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false,Visible=false};
            advanced.Controls.AddRange([kind,common,copies,journal,plaintext]);
            var options=new Button {Text="저장 옵션",AutoSize=true,FlatStyle=FlatStyle.Flat,MinimumSize=new Size(110,36)};
            options.FlatAppearance.BorderSize=0;options.Click+=(_,_)=>advanced.Visible=!advanced.Visible;
            content.Controls.Add(options);content.Controls.Add(advanced);
            var policy=destination.Policy!;
            Note(WindowsCapturePolicy.Describe(policy));
        }
        Note("‘연결하고 시작’을 누르면 위 범위의 보관·자료 처리를 시작합니다.");
        var buttons=new FlowLayoutPanel {Dock=DockStyle.Bottom,AutoSize=true,Padding=new Padding(28,12,28,20)};
        var connect=new Button {Text="연결하고 시작",AutoSize=true,MinimumSize=new Size(280,52),FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(35,57,130),ForeColor=Color.White};
        connect.FlatAppearance.BorderSize=0;
        void Changed(){
            project.Enabled=!common.Checked;name.Visible=modern&&!common.Checked&&project.SelectedIndex==0;
            journal.Enabled=copies.Checked&&!common.Checked;
            connect.Enabled=!modern||common.Checked||project.SelectedIndex>0||!string.IsNullOrWhiteSpace(name.Text);
        }
        copies.CheckedChanged+=(_,_)=>Changed();common.CheckedChanged+=(_,_)=>Changed();project.SelectedIndexChanged+=(_,_)=>Changed();name.TextChanged+=(_,_)=>Changed();Changed();
        connect.Click+=(_,_)=>{
            if(modern)Selection=new WindowsFolderSelection(new[]{"folder","photos","call_recording"}[kind.SelectedIndex],
                !common.Checked&&project.SelectedItem is WindowsProjectChoice choice?Guid.Parse(choice.id):null,
                !common.Checked&&project.SelectedIndex==0?name.Text.Trim():null,common.Checked,false,copies.Checked&&!common.Checked,plaintext.Checked,
                NewOnly:previous?.NewOnly??true,JournalCopies:journal.Checked&&copies.Checked&&!common.Checked);
            DialogResult=DialogResult.OK;Close();
        };
        var cancel=new Button {Text="취소",AutoSize=true,MinimumSize=new Size(110,52),DialogResult=DialogResult.Cancel};
        buttons.Controls.AddRange([connect,cancel]);Controls.Add(content);Controls.Add(buttons);AcceptButton=connect;CancelButton=cancel;
    }
}
