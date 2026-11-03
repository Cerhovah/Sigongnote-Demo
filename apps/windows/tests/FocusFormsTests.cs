using System.Runtime.ExceptionServices;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class FocusFormsTests
{
    private static IEnumerable<Control> Descendants(Control root) =>
        root.Controls.Cast<Control>().SelectMany(child => new[]{child}.Concat(Descendants(child)));
    private static void Click(Button button) {Assert.IsTrue(button.Enabled);typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(button,[EventArgs.Empty]);}

    private static void InSta(Action action)
    {
        Exception? failure=null;
        var thread=new Thread(()=> { try { action(); } catch(Exception error) { failure=error; } });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(15)),"Form construction timed out");
        if(failure is not null)ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [TestMethod]
    [DataRow("folder")]
    [DataRow("upper")]
    [DataRow("batch")]
    public void ConsentShowsBothProcessingPurposesBeforeTheExistingConfirmation(string mode)
    {
        InSta(()=> {
            var policy=System.Text.Json.JsonSerializer.Deserialize<Sigongnote.Contracts.CapturePolicy>("""
                {"id":"multi-fixture-v1","purpose":"work_records","provider":"anthropic","processing_location":"primary-region","storage_location":"company-storage","retention":"until_user_deletes","external_processing":true,
                "processors":[{"purpose":"long_stt","provider":"openai","processing_location":"stt-region","storage_location":"stt-storage","retention":"delete_after_transcription"}]}
                """)!;
            var destination=new WindowsUploadDestination("Fixture Company","https://api.example.test",new(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid()),policy,[]);
            var preview=new WindowsFolderScopePreview(0,0,0,DateTime.MinValue,new Dictionary<string,int>());
            using Form form=mode switch {
                "folder"=>new WindowsFolderConsentForm("synthetic-work",preview,destination),
                "upper"=>new WindowsUpperFolderConsentForm("synthetic-work",preview,destination,0),
                _=>new WindowsFolderBatchForm("synthetic-work",new([new("folder-key","synthetic-work/site","합성 현장","unassigned",null,null)],false),destination),
            };
            var controls=Descendants(form).ToList();var text=string.Join(" ",controls.Select(c=>c.Text));
            StringAssert.Contains(text,"Anthropic (primary-region)");StringAssert.Contains(text,"업무 기록 정리");
            StringAssert.Contains(text,"company-storage · until_user_deletes");StringAssert.Contains(text,"장기 녹음 전사: OpenAI (stt-region)");
            StringAssert.Contains(text,"stt-storage · delete_after_transcription");Assert.AreEqual(DialogResult.None,form.DialogResult);
            var start=(Button)form.AcceptButton!;
            if(form is WindowsFolderBatchForm batch) {
                Assert.HasCount(0,batch.Selections);Assert.IsFalse(start.Enabled);
                var business=controls.OfType<CheckBox>().Single(c=>c.Text.StartsWith("선택한 폴더"));
                var external=controls.OfType<CheckBox>().Single(c=>c.Text=="안내한 외부 처리에 동의해요");
                Assert.IsFalse(business.Checked);Assert.IsFalse(external.Checked);
                business.Checked=true;Assert.IsFalse(start.Enabled);external.Checked=true;Assert.IsTrue(start.Enabled);
                Assert.HasCount(0,batch.Selections);Click(start);Assert.HasCount(1,batch.Selections);
            } else if(form is WindowsFolderConsentForm folder) {
                Assert.IsNull(folder.Selection);Click(start);Assert.IsNotNull(folder.Selection);Assert.IsTrue(folder.Selection.NewOnly);
            } else {
                var upper=(WindowsUpperFolderConsentForm)form;
                Assert.IsNull(upper.Selection);Click(start);Assert.IsNotNull(upper.Selection);Assert.IsTrue(upper.Selection.ManagedRoot);
            }
            Assert.AreEqual(DialogResult.OK,form.DialogResult);
        });
    }

    [TestMethod]
    public void IdentityLinkFormRendersExplicitChoicesWithoutStartingNetwork() {
        InSta(()=> {
            var root=Path.Combine(Path.GetTempPath(),"sigongnote-link-ui-"+Guid.NewGuid());Directory.CreateDirectory(root);
            try {
                using var form=new WindowsIdentityLinkForm(new("https://api.example.test/","https://auth.example.test/","public",true,true,true),new WindowsTokenVault(Path.Combine(root,"session")),new WindowsTokenVault(Path.Combine(root,"pending")));
                form.ShowInTaskbar=false;form.Show();Application.DoEvents();
                var controls=Descendants(form).ToList();
                Assert.AreEqual(4,controls.OfType<Button>().Count());
                StringAssert.Contains(string.Join(" ",controls.Select(row=>row.Text)),"본인 계정만 연결");
                Assert.IsTrue(controls.OfType<Button>().All(row=>row.Height>=56));
                Assert.IsTrue(controls.OfType<Button>().Any(row=>row.Text=="내 네이버로도 로그인하기"));
                Assert.IsTrue(controls.OfType<Button>().Any(row=>row.Text=="내 카카오로도 로그인하기"));
                using var bitmap=new System.Drawing.Bitmap(form.Width,form.Height);form.DrawToBitmap(bitmap,form.ClientRectangle);
                var output=Environment.GetEnvironmentVariable("SIGONGNOTE_UI_EVIDENCE");
                if(!string.IsNullOrWhiteSpace(output)) {Directory.CreateDirectory(output);bitmap.Save(Path.Combine(output,"identity-link-windows.png"));}
                form.Close();
            } finally {Directory.Delete(root,true);}
        });
    }

    [TestMethod]
    public void ConsentKeepsScopeVisibleUntilExplicitConnect()
    {
        InSta(()=> {
            var preview=new WindowsFolderScopePreview(12,1048576,3,DateTime.UtcNow,
                new Dictionary<string,int>{{".pdf",12}});
            var recipient=new WindowsUploadDestination("Fixture Company","https://api.example.test",
                new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid()));
            using var form=new WindowsFolderConsentForm("synthetic-work",preview,recipient);
            var controls=Descendants(form).ToList();
            var send=(Button)form.AcceptButton!;
            Assert.AreEqual("연결하고 시작",send.Text);Assert.IsTrue(send.Enabled);
            Assert.AreEqual(DialogResult.None,form.DialogResult);Assert.IsNull(form.Selection);
            var text=string.Join(" ",controls.Select(control=>control.Text));
            StringAssert.Contains(text,"synthetic-work");StringAssert.Contains(text,"Fixture Company");
            StringAssert.Contains(text,"연결 후 새로 저장하는 자료부터");StringAssert.Contains(text,"원본은 그대로");
            StringAssert.Contains(text,"누르면 위 범위의 보관·자료 처리를 시작");
            Assert.AreEqual(DialogResult.Cancel,((Button)form.CancelButton!).DialogResult);
            Click(send);Assert.AreEqual(DialogResult.OK,form.DialogResult);
        });
    }

    [TestMethod]
    public void ScopedSetupShowsPolicyAndConfirmsTheSelectedSiteOnce()
    {
        InSta(()=> {
            var policy=new Sigongnote.Contracts.CapturePolicy("fixture-external","work_records","fixture-provider","test-region","test-storage","30 days",true);
            var project=Guid.NewGuid();
            var recipient=new WindowsUploadDestination("Fixture Company","https://api.example.test",new(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid()),policy,[new(project.ToString("D"),"합성 기존 현장")]);
            using var form=new WindowsFolderConsentForm("synthetic-work",new(0,0,0,DateTime.MinValue,new Dictionary<string,int>()),recipient);
            var controls=Descendants(form).ToList();var send=(Button)form.AcceptButton!;
            var name=controls.OfType<TextBox>().Single(row=>row.AccessibleName=="현장 이름");
            var site=controls.OfType<ComboBox>().Single(row=>row.AccessibleName=="현장 선택");
            var kind=controls.OfType<ComboBox>().Single(row=>row.AccessibleName=="자료 종류");
            Assert.IsNull(form.Selection);Assert.AreEqual(DialogResult.None,form.DialogResult);
            name.Text=" ";Assert.IsFalse(send.Enabled);site.SelectedIndex=1;Assert.IsTrue(send.Enabled);
            Click(controls.OfType<Button>().Single(row=>row.Text=="저장 옵션"));kind.SelectedIndex=1;
            var copies=controls.OfType<CheckBox>().Single(row=>row.Text.StartsWith("정리본"));
            var journal=controls.OfType<CheckBox>().Single(row=>row.Text.StartsWith("업무일지"));
            var plaintext=controls.OfType<CheckBox>().Single(row=>row.Text.StartsWith("텍스트"));
            Assert.IsFalse(journal.Checked);Assert.IsFalse(plaintext.Checked);copies.Checked=false;Assert.IsFalse(journal.Enabled);
            var text=string.Join(" ",controls.Select(row=>row.Text));StringAssert.Contains(text,"Fixture Company");StringAssert.Contains(text,"fixture-provider");StringAssert.Contains(text,"test-region");StringAssert.Contains(text,"test-storage");StringAssert.Contains(text,"30 days");
            Assert.IsNull(form.Selection);Click(send);Assert.AreEqual(DialogResult.OK,form.DialogResult);
            var selection=form.Selection;Assert.IsNotNull(selection);Assert.AreEqual(project,selection.ProjectId);Assert.IsNull(selection.NewProjectName);
            Assert.AreEqual("photos",selection.Kind);Assert.IsFalse(selection.Common);Assert.IsTrue(selection.NewOnly);
            Assert.IsFalse(selection.DownloadCopies);Assert.IsFalse(selection.PlaintextCopies);Assert.IsFalse(selection.JournalCopies);
        });
    }

    [TestMethod]
    public void DashboardSeparatesPagesAndRefreshPreservesFolderSelection()
    {
        InSta(()=> {
            var sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-ux-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(sandbox);
            try {
                var first=Path.Combine(sandbox,"first");var second=Path.Combine(sandbox,"second");
                Directory.CreateDirectory(first);Directory.CreateDirectory(second);
                var state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));
                state.SelectFolder(first);state.SelectFolder(second);
                var signedIn=false;
                using var form=new DashboardForm(state,()=>{},()=>{},
                    (_,_)=>throw new InvalidOperationException("Unexpected network action"),
                    (_,_,_)=>throw new InvalidOperationException("Unexpected approval"),()=>{},()=>signedIn,()=>"대기",
                    ()=>throw new InvalidOperationException("Unexpected recipient lookup"),
                    _=>throw new InvalidOperationException("Unexpected verification"));
                var controls=Descendants(form).ToList();
                var pages=controls.OfType<TabControl>().Single();
                _ = pages.Handle; // Tab selection is initialized by the native control.
                Assert.AreEqual(3,pages.TabPages.Count);
                Assert.AreEqual("업무 폴더",pages.SelectedTab!.Text);
                Assert.AreEqual(2,Descendants(pages.TabPages[0]).OfType<Button>().Count());
                var folders=controls.OfType<ListBox>().Single();
                folders.SelectedIndex=1;
                var selected=folders.SelectedItem!.ToString();
                form.RefreshState();
                Assert.AreEqual(selected,folders.SelectedItem!.ToString());
                Assert.IsFalse(folders.Items.Cast<string>().Any(text=>text.Contains(sandbox,StringComparison.Ordinal)));
                Assert.IsTrue(form.Font.Size>=14);
                Assert.IsTrue(controls.OfType<Button>().All(button=>button.MinimumSize.Height>=56));
                Assert.IsNotNull(folders.AccessibleName);
                signedIn=true;form.RefreshState();
                Assert.IsTrue(Descendants(pages.TabPages[1]).OfType<Label>().Any(label=>label.Text.StartsWith("로그인 정보를 이 PC에 보관",StringComparison.Ordinal)));
                folders.Font=new System.Drawing.Font(folders.Font.FontFamily,28);
                Assert.IsTrue(folders.ItemHeight>=folders.Font.Height*2+12);
            } finally { Directory.Delete(sandbox,true); }
        });
    }
}
