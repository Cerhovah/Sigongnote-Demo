using System.ComponentModel;
using System.Drawing;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace Sigongnote.Windows;

public sealed record WindowsDiscoveredFolder(string Key,string Path,string Name,string Scope,Guid? ProjectId,string? Issue);
public sealed record WindowsFolderDiscoveryResult(IReadOnlyList<WindowsDiscoveredFolder> Folders,bool Partial);
public sealed record WindowsBatchFolderSelection(string Path,WindowsFolderSelection Selection);

/** The upper location is enumerated, never registered as a capture source. */
public static class WindowsFolderBatchDiscovery
{
    public const int MaximumChildren=100;
    public static bool Overlaps(string first,string second) {
        var a=System.IO.Path.GetFullPath(first).TrimEnd('\\','/');var b=System.IO.Path.GetFullPath(second).TrimEnd('\\','/');
        return a.Equals(b,StringComparison.OrdinalIgnoreCase) ||
            a.StartsWith(b+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase) ||
            b.StartsWith(a+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
    }
    public static (string Scope,Guid? ProjectId) Suggest(string name,IReadOnlyList<WindowsProjectChoice> projects) {
        var normalized=name.Normalize(NormalizationForm.FormKC).Trim();
        var matches=projects.Where(project=>project.display_name.Normalize(NormalizationForm.FormKC).Trim().Equals(normalized,StringComparison.OrdinalIgnoreCase)).ToArray();
        if(matches.Length==1 && Guid.TryParse(matches[0].id,out var id))return ("project",id);
        if(new[]{"공통","공통자료","회사 공통","회사공통","양식","서식"}.Contains(normalized,StringComparer.OrdinalIgnoreCase))return ("company_common",null);
        return ("unassigned",null);
    }
    public static WindowsFolderDiscoveryResult Discover(string parent,IReadOnlyList<WindowsProjectChoice> projects,
        IReadOnlyList<FolderConnection> connected,Func<string,WindowsVolumeIdentity>? identify=null,Action<string>? verifyReadable=null) {
        identify??=WindowsVolumeIdentity.Probe;
        verifyReadable??=path=>{using var entries=Directory.EnumerateFileSystemEntries(path).GetEnumerator();_ = entries.MoveNext();};
        var results=new List<WindowsDiscoveredFolder>();var partial=false;
        var root=System.IO.Path.GetFullPath(parent);
        try {
            foreach(var path in Directory.EnumerateDirectories(root,"*",new EnumerationOptions {RecurseSubdirectories=false,IgnoreInaccessible=false,AttributesToSkip=FileAttributes.Hidden|FileAttributes.System|FileAttributes.ReparsePoint}).Take(MaximumChildren+1).Order(StringComparer.OrdinalIgnoreCase)) {
                if(results.Count==MaximumChildren){partial=true;break;}
                var name=System.IO.Path.GetFileName(path);var suggestion=Suggest(name,projects);
                string? issue=null;string key;
                try {
                    var identity=identify(path);
                    key=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{identity.VolumeId}\0{identity.Serial}\0{identity.RelativePath.ToUpperInvariant()}")));
                    verifyReadable(path);
                    if(File.Exists(System.IO.Path.Combine(path,"sigongnote-generated.json")))issue="generated_output";
                    if(connected.Any(folder=>folder.State=="selected" && folder.RootPath is not null && Overlaps(path,folder.RootPath)))issue="already_covered";
                }catch(Exception error) when(error is IOException or UnauthorizedAccessException or Win32Exception) {
                    key=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path.ToUpperInvariant())));issue="permission_denied";partial=true;
                }
                results.Add(new(key,path,name,suggestion.Scope,suggestion.ProjectId,issue));
            }
        }catch(Exception error) when(error is IOException or UnauthorizedAccessException){partial=true;}
        return new(results,partial);
    }
}

public sealed class WindowsFolderBatchForm:Form
{
    public IReadOnlyList<WindowsBatchFolderSelection> Selections {get;private set;}=[];
    private sealed record ScopeChoice(string Label,string Scope,Guid? ProjectId=null) {public override string ToString()=>Label;}
    public WindowsFolderBatchForm(string parent,WindowsFolderDiscoveryResult discovery,WindowsUploadDestination destination) {
        Text="상위 위치의 업무 폴더 함께 연결";Font=new Font("Malgun Gothic",13);Width=800;Height=720;MinimumSize=new Size(680,500);
        AutoScaleMode=AutoScaleMode.Dpi;StartPosition=FormStartPosition.CenterParent;
        var content=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(20)};
        void Label(string text)=>content.Controls.Add(new Label {Text=text,AutoSize=true,MaximumSize=new Size(710,0),Margin=new Padding(0,4,0,8)});
        Label(parent);Label("바로 아래 폴더를 찾았어요. 같은 이름은 위치를 확인하고, 현장이 아직 없으면 미확정으로 두세요. 상위 위치 자체는 수집하지 않아요.");
        if(discovery.Partial)Label("일부 폴더는 권한이나 목록을 확인하지 못했어요. 폴더가 100개보다 많으면 더 작은 상위 위치를 선택하세요. 선택 가능한 폴더는 먼저 연결할 수 있어요.");
        var rows=new List<(WindowsDiscoveredFolder Folder,CheckBox Included,ComboBox Scope)>();
        foreach(var folder in discovery.Folders) {
            var include=new CheckBox {Text=folder.Name,Checked=folder.Issue is null,Enabled=folder.Issue is null,AutoSize=true,MinimumSize=new Size(0,40)};
            content.Controls.Add(include);Label(folder.Path);
            if(folder.Issue is not null)Label(folder.Issue=="already_covered"?"이 위치 또는 겹치는 상위·하위 폴더가 이미 연결되어 있어요.":folder.Issue=="generated_output"?"시공노트가 만든 사본 폴더예요.":"읽기 권한을 확인해 주세요. 다른 폴더는 계속 연결할 수 있어요.");
            var scope=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=650,Enabled=folder.Issue is null,AccessibleName=folder.Name+" 분류"};
            scope.Items.Add(new ScopeChoice("현장 미확정","unassigned"));scope.Items.Add(new ScopeChoice("회사 공통 자료","company_common"));
            foreach(var project in destination.Projects??[])if(Guid.TryParse(project.id,out var id))scope.Items.Add(new ScopeChoice(project.display_name,"project",id));
            scope.Items.Add(new ScopeChoice("새 현장 만들기 · "+folder.Name,"new"));
            scope.SelectedIndex=0;
            for(var index=0;index<scope.Items.Count;index++)if(scope.Items[index] is ScopeChoice value && value.Scope==folder.Scope && value.ProjectId==folder.ProjectId)scope.SelectedIndex=index;
            content.Controls.Add(scope);rows.Add((folder,include,scope));
        }
        var policy=destination.Policy;
        Label($"받는 회사: {destination.Company}\n{(policy is null?"":WindowsCapturePolicy.Describe(policy))}\n기존 자료와 이후 새 자료를 함께 읽으며 원본은 유지합니다.");
        var consent=new CheckBox {Text="선택한 폴더는 업무 자료이며 위 회사에 보관하는 데 동의해요",AutoSize=true,MaximumSize=new Size(710,0),MinimumSize=new Size(0,48)};
        var external=new CheckBox {Text="안내한 외부 처리에 동의해요",AutoSize=true,MinimumSize=new Size(0,48)};
        content.Controls.Add(consent);if(policy?.external_processing==true)content.Controls.Add(external);
        var buttons=new FlowLayoutPanel {Dock=DockStyle.Bottom,AutoSize=true,Padding=new Padding(20,8,20,12)};
        var save=new Button {Text="선택한 폴더 한 번에 연결",AutoSize=true,MinimumSize=new Size(220,56),Enabled=false};
        var cancel=new Button {Text="나중에",AutoSize=true,MinimumSize=new Size(120,56),DialogResult=DialogResult.Cancel};
        void Changed()=>save.Enabled=consent.Checked && (policy?.external_processing!=true||external.Checked) && rows.Any(row=>row.Included.Checked);
        consent.CheckedChanged+=(_,_)=>Changed();external.CheckedChanged+=(_,_)=>Changed();foreach(var row in rows)row.Included.CheckedChanged+=(_,_)=>Changed();
        save.Click+=(_,_)=>{
            Selections=rows.Where(row=>row.Included.Checked).Select(row=>{
                var scope=(ScopeChoice)row.Scope.SelectedItem!;
                var kind=WindowsStateStore.KnownFolderKind(row.Folder.Path)??"folder";
                return new WindowsBatchFolderSelection(row.Folder.Path,new(kind,scope.ProjectId,scope.Scope=="new"?row.Folder.Name[..Math.Min(row.Folder.Name.Length,80)]:null,
                    scope.Scope=="company_common",Unassigned:scope.Scope=="unassigned",DisplayName:row.Folder.Name[..Math.Min(row.Folder.Name.Length,180)]));
            }).ToArray();DialogResult=DialogResult.OK;Close();
        };
        buttons.Controls.AddRange([save,cancel]);Controls.Add(content);Controls.Add(buttons);AcceptButton=save;CancelButton=cancel;
    }
}
