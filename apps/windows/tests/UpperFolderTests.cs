using Microsoft.VisualStudio.TestTools.UnitTesting;
using Sigongnote.Contracts;
using System.Runtime.ExceptionServices;
using System.Reflection;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class UpperFolderTests
{
    private static WindowsSourceSetup Setup(string id)=>new(id,Guid.NewGuid(),new(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid()),
        new CapturePolicy("fixture","work_records","fixture","fixture","fixture","until_deleted",false),
        new("folder",null,null,false,Unassigned:true,ManagedRoot:true),"fixture",null);
    [TestMethod]
    public void PersistentRootDiscoversNewChildrenAndPreservesPausedChildAndOriginals()
    {
        var sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-upper-"+Guid.NewGuid());Directory.CreateDirectory(sandbox);
        try {
            var root=Path.Combine(sandbox,"work");Directory.CreateDirectory(root);
            var child=Path.Combine(root,"legacy");Directory.CreateDirectory(child);File.WriteAllText(Path.Combine(child,"old.txt"),"original child");
            var state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));var old=state.SelectFolder(child);state.PauseSource(old.Id);
            var parent=state.SelectFolder(root);state.SaveFolderSetup(Setup(parent.Id));
            File.WriteAllText(Path.Combine(root,"root.txt"),"original root");
            var generated=Path.Combine(root,"output");Directory.CreateDirectory(generated);File.WriteAllText(Path.Combine(generated,"sigongnote-generated.json"),"{}");File.WriteAllText(Path.Combine(generated,"copy.txt"),"generated");
            var stable=new WindowsFileStabilizer(state,TimeSpan.Zero);
            for(var i=0;i<6;i++)state.ScanFolderBatch(parent.Id,root,stable);
            Assert.AreEqual(1,state.CopyCandidates().Count);Assert.AreEqual("root.txt",state.CopyCandidates().Single().RelativePath);
            Directory.CreateDirectory(Path.Combine(root,"future","deeper"));File.WriteAllText(Path.Combine(root,"future","deeper","new.txt"),"new original");
            state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));stable=new(state,TimeSpan.Zero);
            for(var i=0;i<6;i++)state.ScanFolderBatch(parent.Id,root,stable);
            Assert.AreEqual(2,state.CopyCandidates().Count);Assert.AreEqual("paused",state.Folders().Single(f=>f.Id==old.Id).State);
            Assert.IsFalse(state.FolderScopeAllows(new(Guid.NewGuid().ToString(),parent.Id,@"legacy\old.txt","hash",1,DateTime.UtcNow.Ticks)));
            Assert.AreEqual("original child",File.ReadAllText(Path.Combine(child,"old.txt")));
            Assert.AreEqual("original root",File.ReadAllText(Path.Combine(root,"root.txt")));
            var camera=state.FolderSetup(parent.Id);Assert.IsTrue(WindowsStateStore.FolderScopeAllows(camera,@"camera\photo.jpg",DateTime.UtcNow.Ticks));
            Assert.IsFalse(WindowsStateStore.FolderScopeAllows(camera,@"recordings\call.txt",DateTime.UtcNow.Ticks));
            Assert.IsFalse(WindowsStateStore.FolderScopeAllows(camera,"voice.mp3",DateTime.UtcNow.Ticks));
        } finally {Directory.Delete(sandbox,true);}
    }
    [TestMethod]
    public void AddingChildAfterDiscoveryPreventsParentCopyAndKeepsItsOriginal()
    {
        var sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-scope-fence-"+Guid.NewGuid());Directory.CreateDirectory(sandbox);
        try {
            var root=Path.Combine(sandbox,"work");var child=Path.Combine(root,"child");Directory.CreateDirectory(child);
            File.WriteAllText(Path.Combine(child,"file.txt"),"fixture");var state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var parent=state.SelectFolder(root);state.SaveFolderSetup(Setup(parent.Id));var stable=new WindowsFileStabilizer(state,TimeSpan.Zero);
            for(var i=0;i<6;i++)state.ScanFolderBatch(parent.Id,root,stable);var queued=state.CopyCandidates().Single();
            state.PauseSource(state.SelectFolder(child).Id);
            using var copies=new WindowsEncryptedCopyStore(state,new byte[32],Path.Combine(sandbox,"copies"));
            Assert.IsFalse(copies.Stage(queued));Assert.AreEqual(0L,copies.StoredBytes);Assert.AreEqual("fixture",File.ReadAllText(Path.Combine(child,"file.txt")));
        } finally {Directory.Delete(sandbox,true);}
    }
    [TestMethod]
    public void FailedUnpreparedParentPausesAndCannotBypassExistingChildOnRetry()
    {
        var sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-upper-failure-"+Guid.NewGuid());Directory.CreateDirectory(sandbox);
        try {
            var root=Path.Combine(sandbox,"work");var child=Path.Combine(root,"old");Directory.CreateDirectory(child);
            File.WriteAllText(Path.Combine(child,"private.txt"),"preserved child");
            var state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));var existing=state.SelectFolder(child);state.PauseSource(existing.Id);
            var parent=state.SelectFolder(root);state.PauseUnpreparedFolder(parent.Id);Assert.IsFalse(state.SourceSelected(parent.Id));
            // Before a setup can be saved, even a manual retry excludes every child owner.
            state.SelectFolder(root);Assert.IsTrue(state.IsOwnedByChild(parent.Id,@"old\private.txt"));
            for(var i=0;i<3;i++)state.ScanFolderBatch(parent.Id,root,new(state,TimeSpan.Zero));Assert.AreEqual(0,state.CopyCandidates().Count);
            var setup=Setup(parent.Id);state.SaveFolderSetup(setup);state.PauseSource(parent.Id);
            Assert.IsFalse(state.CanResumeFolder(parent.Id,new(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid())));Assert.IsTrue(state.CanResumeFolder(parent.Id,setup.Principal));
            state.SelectFolder(root,setup.Principal);Assert.AreEqual(setup.Key,state.FolderSetup(parent.Id)!.Key);Assert.IsTrue(state.SourceSelected(parent.Id));Assert.IsFalse(state.SourceSelected(existing.Id));
        }finally{Directory.Delete(sandbox,true);}
    }
    [TestMethod]
    public void SpaceWaitReentersCopyQueueAndPausedSourcesDoNotKeepRetrying()
    {
        var sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-space-retry-"+Guid.NewGuid());Directory.CreateDirectory(sandbox);
        try {
            var root=Path.Combine(sandbox,"work");Directory.CreateDirectory(root);var file=Path.Combine(root,"file.txt");File.WriteAllText(file,"original");
            var state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));var folder=state.SelectFolder(root);var stable=new WindowsFileStabilizer(state,TimeSpan.Zero);
            stable.Observe(folder.Id,root,file);stable.Observe(folder.Id,root,file);var copy=state.CopyCandidates().Single();
            Assert.IsTrue(state.BeginCopy(copy.CaptureKey));state.CompleteCopy(copy.CaptureKey,"storage_full");Assert.AreEqual(1,state.LocalStorageWaitCount());
            state.PauseSource(folder.Id);Assert.AreEqual(0,state.LocalStorageWaitCount());Assert.AreEqual(0,state.CopyCandidates().Count);
            state.SelectFolder(root);Assert.AreEqual(copy.CaptureKey,state.CopyCandidates().Single().CaptureKey);
            using var copies=new WindowsEncryptedCopyStore(state,new byte[32],Path.Combine(sandbox,"copies"));Assert.IsTrue(copies.Stage(state.CopyCandidates().Single()));Assert.IsTrue(copies.VerifyCopy(copy));Assert.AreEqual(0,state.LocalStorageWaitCount());Assert.AreEqual("original",File.ReadAllText(file));
        }finally{Directory.Delete(sandbox,true);}
    }
    [TestMethod]
    public void SpacePolicyBoundsQueueAndLeavesHeadroomWithoutFiveGigabyteFloor()
    {
        var gb=WindowsCopySpace.GiB;Assert.AreEqual(gb,WindowsCopySpace.Reserve(1000*gb));Assert.AreEqual(gb/2,WindowsCopySpace.Reserve(8*gb));
        Assert.IsTrue(WindowsCopySpace.Allows(1000*gb,4*gb,0,WindowsEncryptedCopyStore.EncryptedSize(1024),2*gb));
        Assert.IsFalse(WindowsCopySpace.Allows(1000*gb,gb,0,1,2*gb));
        Assert.IsFalse(WindowsCopySpace.Allows(1000*gb,4*gb,2*gb,1,2*gb));
        Assert.IsTrue(WindowsUpperFolder.Contains(".",@"new\file"));Assert.IsFalse(WindowsUpperFolder.Contains("work",@"worker\file"));
    }
    [TestMethod]
    public void OneScreenConfirmsTheManagedScopeAndKeepsOptionalCopiesExplicit()
    {
        Exception? failure=null;var thread=new Thread(()=>{try{
            using var form=new WindowsUpperFolderConsentForm("fixture-root",new(4,1024,2,DateTime.MinValue,new Dictionary<string,int>()),new("Fixture","https://api.example.test",new(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid()),new("fixture","work_records","provider","region","storage","30 days",true),[]),2);
            IEnumerable<Control> All(Control c)=>c.Controls.Cast<Control>().SelectMany(x=>new[]{x}.Concat(All(x)));
            var controls=All(form).ToArray();var start=(Button)form.AcceptButton!;var boxes=controls.OfType<CheckBox>().ToArray();
            Assert.AreEqual("연결하고 시작",start.Text);Assert.IsTrue(start.Enabled);Assert.IsNull(form.Selection);Assert.AreEqual(DialogResult.None,form.DialogResult);
            var copies=boxes.Single(b=>b.Text.StartsWith("정리본"));var journal=boxes.Single(b=>b.Text.StartsWith("업무일지"));var plaintext=boxes.Single(b=>b.Text.StartsWith("텍스트"));
            Assert.IsTrue(copies.Checked);Assert.IsFalse(journal.Checked);Assert.IsFalse(plaintext.Checked);
            var text=string.Join(" ",controls.Select(c=>c.Text));StringAssert.Contains(text,"fixture-root");StringAssert.Contains(text,"Fixture");StringAssert.Contains(text,"하위 폴더 2곳은 기존 설정을 유지");StringAssert.Contains(text,"provider (region)");StringAssert.Contains(text,"storage · 30 days");
            typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(controls.OfType<Button>().Single(b=>b.Text=="저장 옵션"),[EventArgs.Empty]);
            copies.Checked=false;Assert.IsFalse(journal.Enabled);plaintext.Checked=true;Assert.IsNull(form.Selection);
            typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(start,[EventArgs.Empty]);
            Assert.AreEqual(DialogResult.OK,form.DialogResult);Assert.IsNotNull(form.Selection);
            Assert.IsTrue(form.Selection.ManagedRoot);Assert.IsTrue(form.Selection.Unassigned);Assert.IsTrue(form.Selection.NewOnly);
            Assert.IsNull(form.Selection.ProjectId);Assert.IsNull(form.Selection.NewProjectName);Assert.IsFalse(form.Selection.Common);
            Assert.IsFalse(form.Selection.DownloadCopies);Assert.IsFalse(form.Selection.JournalCopies);Assert.IsTrue(form.Selection.PlaintextCopies);
        }catch(Exception e){failure=e;}});thread.SetApartmentState(ApartmentState.STA);thread.Start();Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(15)));if(failure is not null)ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
