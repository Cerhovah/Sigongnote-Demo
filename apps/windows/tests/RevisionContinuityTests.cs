using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class RevisionContinuityTests {
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(reply(request));
    }
    [TestMethod]
    public async Task SamePathRevisionSurvivesRestartAndConflictKeepsEncryptedCopy() {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-n24-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            var source=Path.Combine(root,"source");Directory.CreateDirectory(source);var file=Path.Combine(source,"synthetic.pdf");
            var db=Path.Combine(root,"state.db");var state=new WindowsStateStore(db);var folder=state.SelectFolder(source);
            var principal=new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());var server=Guid.NewGuid();state.BindSource(folder.Id,principal,server,1);
            var stable=new WindowsFileStabilizer(state,TimeSpan.Zero);
            using var copies=new WindowsEncryptedCopyStore(state,RandomNumberGenerator.GetBytes(32),Path.Combine(root,"copies"));
            void Stage(string text){File.WriteAllText(file,text);stable.Observe(folder.Id,source,file);stable.Observe(folder.Id,source,file);Assert.AreEqual(1,copies.StagePending());}
            Stage("synthetic first");var first=state.BeginUpload(principal)!;Assert.IsNull(first.RevisionBase);
            var document=Guid.NewGuid();var revision=Guid.NewGuid();var ingestion=Guid.NewGuid();state.SavePreparedUpload(first.Copy.CaptureKey,ingestion,"fixture",DateTimeOffset.UtcNow.AddHours(1));
            state.FinishUpload(first.Copy.CaptureKey,"acknowledged",JsonSerializer.Serialize(new{document_id=document,revision_id=revision,revision_number=1}));
            Stage("synthetic second edit");Stage("synthetic third edit remains pending");
            var second=state.BeginUpload(principal)!;Assert.AreEqual("synthetic second edit",Encoding.UTF8.GetString(copies.ReadRange(second.Copy,0,(int)second.Copy.ByteSize)));
            Assert.AreEqual(new WindowsRevisionBase(document,revision,1),second.RevisionBase);
            Assert.IsNull(state.BeginUpload(principal),"an active predecessor fences later snapshots on the same path");
            state.FinishUpload(second.Copy.CaptureKey,"retry_wait",retryAfter:DateTimeOffset.UtcNow.AddSeconds(-1));
            var snapshot=Path.Combine(root,"restored.db");File.Copy(db,snapshot);var restored=new WindowsStateStore(snapshot);
            Assert.IsNull(restored.BeginUpload(principal with {UserId=Guid.NewGuid()}));
            var retry=restored.BeginUpload(principal)!;Assert.AreEqual(second.PrepareKey,retry.PrepareKey);Assert.AreEqual(second.RevisionBase,retry.RevisionBase);
            restored.FinishUpload(retry.Copy.CaptureKey,"revision_conflict");Assert.AreEqual(1,restored.RevisionConflictCount());Assert.IsNull(restored.BeginUpload(principal));
            Assert.IsTrue(copies.VerifyCopy(second.Copy));Assert.IsFalse(restored.ReclaimCandidates(principal).Any(c=>c.Copy.CaptureKey==second.Copy.CaptureKey));

            var session=new WindowsSession("https://api.example.test/","https://storage.example.test/","fixture-public","fixture-access","fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),principal.TenantId,principal.UserId,principal.DeviceId);
            var vault=new WindowsTokenVault(Path.Combine(root,"session.protected"));vault.Save(JsonSerializer.Serialize(session));var prepares=0;
            var latestId=Guid.NewGuid();
            HttpResponseMessage Reply(object body,HttpStatusCode code=HttpStatusCode.OK)=>new(code){Content=new StringContent(JsonSerializer.Serialize(body))};
            HttpResponseMessage Respond(HttpRequestMessage req){if(req.RequestUri!.AbsolutePath.StartsWith("/v1/work/materials/")){var requested=Guid.Parse(req.RequestUri.Segments.Last());return Reply(new{revision=new{id=requested,document_id=document,latest_revision_id=latestId,revision_number=requested==latestId?2:1}});}switch(req.RequestUri.AbsolutePath){
                case "/v1/me":return Reply(new{user_id=principal.UserId,memberships=new[]{new{tenant_id=principal.TenantId,tenant_name="Fixture",role="owner"}}});
                case "/v1/capture-sources":return Reply(new{sources=new[]{new{id=server,tenant_id=principal.TenantId,device_id=principal.DeviceId,kind="folder",upload_ready=true,server_upload_consent=true,active=true,device_active=true,generation=1}}});
                case "/v1/ingestions":prepares++;using(var body=JsonDocument.Parse(req.Content!.ReadAsStringAsync().Result)){Assert.AreEqual(document,body.RootElement.GetProperty("document_id").GetGuid());Assert.AreEqual(revision,body.RootElement.GetProperty("predecessor_revision_id").GetGuid());Assert.AreEqual(1,body.RootElement.GetProperty("expected_version").GetInt32());}return Reply(new{error=new{code="VERSION_CONFLICT"}},HttpStatusCode.Conflict);
                default:throw new AssertFailedException("Unexpected network request");
            }}
            using var sessions=new WindowsSessionManager(vault,new Handler(Respond));using var transport=new WindowsUploadTransport(state,copies,sessions,new Handler(Respond));
            Assert.IsTrue(await transport.UploadOneAsync());Assert.IsFalse(await transport.UploadOneAsync());Assert.AreEqual(1,prepares);Assert.AreEqual(1,state.RevisionConflictCount());Assert.IsTrue(copies.VerifyCopy(second.Copy));
            var conflict=state.RevisionConflicts(principal).Single();var latest=await WindowsRevisionResolution.LatestAsync(sessions,session,conflict);Assert.AreEqual(new WindowsRevisionBase(document,latestId,2),latest);
            Assert.HasCount(0,state.RevisionConflicts(principal with{UserId=Guid.NewGuid()}));
            Assert.ThrowsExactly<InvalidOperationException>(()=>state.ResumeRevisionConflict(principal with{UserId=Guid.NewGuid()},conflict,latest));
            Assert.ThrowsExactly<InvalidOperationException>(()=>state.ResumeRevisionConflict(principal,conflict,latest with{DocumentId=Guid.NewGuid()}));
            state.ResumeRevisionConflict(principal,conflict,latest);var resumed=state.BeginUpload(principal)!;
            Assert.AreEqual(second.Copy,resumed.Copy);Assert.AreEqual(latest,resumed.RevisionBase);Assert.AreNotEqual(second.PrepareKey,resumed.PrepareKey);Assert.IsNull(resumed.Ticket);Assert.AreEqual(0,state.RevisionConflictCount());
            var thirdRevision=Guid.NewGuid();state.SavePreparedUpload(resumed.Copy.CaptureKey,Guid.NewGuid(),"synthetic",DateTimeOffset.UtcNow.AddMinutes(5));
            state.FinishUpload(resumed.Copy.CaptureKey,"acknowledged",JsonSerializer.Serialize(new{document_id=document,revision_id=thirdRevision,revision_number=3}));
            var next=state.BeginUpload(principal)!;Assert.AreEqual(3,next.RevisionBase!.Version);Assert.AreEqual(thirdRevision,next.RevisionBase.RevisionId);
            Assert.AreEqual("synthetic third edit remains pending",File.ReadAllText(file),"original is never replaced with server data");
        }finally{Assert.IsTrue(Path.GetFullPath(root).StartsWith(Path.GetFullPath(Path.GetTempPath())));Directory.Delete(root,true);}
    }
}
