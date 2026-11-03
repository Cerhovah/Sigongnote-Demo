using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Sigongnote.Contracts;
namespace Sigongnote.Windows.Tests;
[TestClass] public sealed class MirrorIntegrationTests {
 [TestMethod] public async Task ActualSyntheticApiCopiesOriginalAndIssuedBytesThenResumes(){
  var fixture=Environment.GetEnvironmentVariable("SIGONGNOTE_WORK_FIXTURE");if(string.IsNullOrEmpty(fixture)){Assert.Inconclusive("Synthetic preview fixture required");return;}
  var session=JsonSerializer.Deserialize<WindowsSession>(await File.ReadAllTextAsync(fixture),new JsonSerializerOptions{PropertyNameCaseInsensitive=true})!;
  var origin=new Uri(session.ApiBaseUrl);
  Assert.IsTrue(origin.Scheme=="http"&&origin.Host=="127.0.0.1"&&origin.Port is 5191 or 5291&&origin.AbsolutePath=="/"&&origin.UserInfo.Length==0&&origin.Query.Length==0&&origin.Fragment.Length==0,"Synthetic mirror API must stay on this PC");
  using var metadata=JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(Path.GetDirectoryName(fixture)!,"private.json")));
  var project=Guid.Parse(metadata.RootElement.GetProperty("project").GetString()!);var source=Guid.Parse(metadata.RootElement.GetProperty("source").GetString()!);
  var root=Path.Combine(Path.GetTempPath(),"sigongnote-mirror-integration-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);Directory.CreateDirectory(Path.Combine(root,"site"));
  try{
   var state=new WindowsStateStore(Path.Combine(root,"state.db"));var folder=state.SelectFolder(Path.Combine(root,"site"));var vault=new WindowsTokenVault(Path.Combine(root,"session.protected"));vault.Save(JsonSerializer.Serialize(session));
   using var manager=new WindowsSessionManager(vault);
   var policy=new CapturePolicy("local-fixture-v1","work_records","local_fixture","development_computer","development_computer","until_user_deletes",false);
   state.SaveFolderSetup(new(folder.Id,Guid.NewGuid(),session.Principal,policy,new("folder",project,null,false,false,true,true),new string('d',64),null,project,source,1),"ready");
   state.BindSource(folder.Id,session.Principal,source,1);
   using(var mirror=new WindowsMirrorWorker(state,manager,failure:e=>throw new InvalidOperationException(e.GetType().Name+"\n"+new System.Diagnostics.StackTrace(e,false)))){for(var i=0;i<3;i++)await mirror.RunOnce();Assert.IsTrue(mirror.Status.Contains("최신 확인"),mirror.Status);}
   var first=state.Mirror(folder.Id);Assert.IsTrue(first.Entries.Values.Any(e=>e.Kind=="material"));Assert.IsTrue(first.Entries.Values.Any(e=>e.Kind=="document"&&e.Relative.EndsWith(".pdf")));
   foreach(var entry in first.Entries.Values.Where(e=>e.State=="ready"))Assert.AreEqual(entry.Hash,await WindowsMirrorFiles.Hash(Path.Combine(folder.RootPath!,"시공노트",entry.Relative),CancellationToken.None));
   using(var mirror=new WindowsMirrorWorker(state,manager,failure:e=>throw new InvalidOperationException(e.GetType().Name+"\n"+new System.Diagnostics.StackTrace(e,false))))await mirror.RunOnce();Assert.AreEqual(first.Cursor,state.Mirror(folder.Id).Cursor);
   vault.Clear();
  }finally{Assert.IsTrue(Path.GetFullPath(root).StartsWith(Path.GetFullPath(Path.GetTempPath())));Directory.Delete(root,true);}
 }
}
