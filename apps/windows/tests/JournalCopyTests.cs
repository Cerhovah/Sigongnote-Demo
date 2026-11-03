using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;
[TestClass] public sealed class JournalCopyTests {
 [TestMethod] public async Task SnapshotEscapesMessagesAndPreservesUserEdits(){
  var root=Path.Combine(Path.GetTempPath(),"sigongnote-journal-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{var journal=new MirrorJournal(Guid.NewGuid().ToString(),null,[],[]);using var data=JsonDocument.Parse(JsonSerializer.Serialize(new {items=new[]{new{id=Guid.NewGuid(),received_at="2026-10-05T10:00:00Z",project_name="합성 현장",excerpt="<script>fake</script> 납품 요청",reading_state="readable",categories=new[]{"delivery_work"}}}}));
   await WindowsJournalCopy.Write(root,journal,data.RootElement,"https://example.invalid/",CancellationToken.None,()=>{});var file=Path.Combine(root,"최근 업무일지.html");var text=await File.ReadAllTextAsync(file);StringAssert.Contains(text,"2026-10-05 19:00");StringAssert.Contains(System.Net.WebUtility.HtmlDecode(text),"납품·작업");StringAssert.Contains(text,"&lt;script&gt;");Assert.IsFalse(text.Contains("<script>"));
   var stamp=File.GetLastWriteTimeUtc(file);await WindowsJournalCopy.Write(root,journal,data.RootElement,"https://example.invalid/",CancellationToken.None,()=>Assert.Fail("Unchanged snapshot must not rewrite"));Assert.AreEqual(stamp,File.GetLastWriteTimeUtc(file));
   await File.WriteAllTextAsync(file,"직접 수정한 사본");await WindowsJournalCopy.Write(root,journal,data.RootElement,"https://example.invalid/",CancellationToken.None,()=>{});Assert.AreEqual("직접 수정한 사본",await File.ReadAllTextAsync(file));
  }finally{Assert.IsTrue(Path.GetFullPath(root).StartsWith(Path.GetFullPath(Path.GetTempPath())));Directory.Delete(root,true);}
 }
 [TestMethod] public async Task UnknownExistingJournalIsNeverOverwritten(){
  var root=Path.Combine(Path.GetTempPath(),"sigongnote-journal-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{var file=Path.Combine(root,"최근 업무일지.html");await File.WriteAllTextAsync(file,"기존 사용자 문서");using var data=JsonDocument.Parse("{\"items\":[]}");await WindowsJournalCopy.Write(root,new MirrorJournal(Guid.NewGuid().ToString(),null,[],[]),data.RootElement,"https://example.invalid/",CancellationToken.None,()=>Assert.Fail());Assert.AreEqual("기존 사용자 문서",await File.ReadAllTextAsync(file));}
  finally{Assert.IsTrue(Path.GetFullPath(root).StartsWith(Path.GetFullPath(Path.GetTempPath())));Directory.Delete(root,true);}
 }
 [TestMethod] public void NewOnlyExcludesExistingFilesButAllowsNewCopiesWithOldModificationTimes(){
  var root=Path.Combine(Path.GetTempPath(),"sigongnote-current-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);var content=Path.Combine(root,"site");Directory.CreateDirectory(content);
  try{var old=Path.Combine(content,"old.txt");File.WriteAllText(old,"fixture");File.SetCreationTimeUtc(old,DateTime.UtcNow.AddDays(-2));File.SetLastWriteTimeUtc(old,DateTime.UtcNow.AddDays(-2));var state=new WindowsStateStore(Path.Combine(root,"state.db"));var folder=state.SelectFolder(content,historyDays:0);
   var preview=WindowsFolderPreview.Scan(content,state,folder.Id);Assert.AreEqual(0,preview.FileCount);Assert.AreEqual(1,preview.ExcludedCount);
   state.CompleteScopeBaseline(folder.Id,[WindowsFolderPolicy.MetadataFingerprint(new FileInfo(old))]);var next=Path.Combine(content,"new-copy.txt");File.Copy(old,next);File.SetCreationTimeUtc(next,DateTime.UtcNow.AddSeconds(1));Assert.AreEqual(1,WindowsFolderPreview.Scan(content,state,folder.Id).FileCount);
  }finally{Assert.IsTrue(Path.GetFullPath(root).StartsWith(Path.GetFullPath(Path.GetTempPath())));Directory.Delete(root,true);}
 }
}
