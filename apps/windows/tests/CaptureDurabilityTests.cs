using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class CaptureDurabilityTests
{
    private sealed class ReplyHandler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>Task.FromResult(reply(request));
    }
    [TestMethod]
    public async Task AccountQuotaStopsDrainAndResumesAfterServerCapacityReturns()
    {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-n04-quota-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            var source=Path.Combine(root,"source");Directory.CreateDirectory(source);
            var state=new WindowsStateStore(Path.Combine(root,"state.db"));var folder=state.SelectFolder(source);
            var principal=new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());var serverSource=Guid.NewGuid();state.BindSource(folder.Id,principal,serverSource,1);
            var stable=new WindowsFileStabilizer(state,TimeSpan.Zero);
            foreach(var name in new[]{"first.pdf","second.pdf"}){var original=Path.Combine(source,name);File.WriteAllText(original,"synthetic quota");stable.Observe(folder.Id,source,original);stable.Observe(folder.Id,source,original);}
            using var copies=new WindowsEncryptedCopyStore(state,RandomNumberGenerator.GetBytes(32),Path.Combine(root,"copies"));Assert.AreEqual(2,copies.StagePending());
            var session=new WindowsSession("https://api.example.test/","https://storage.example.test/","fixture-publishable","fixture-token","fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),principal.TenantId,principal.UserId,principal.DeviceId);
            var vault=new WindowsTokenVault(Path.Combine(root,"session.protected"));vault.Save(JsonSerializer.Serialize(session));
            var prepares=0;var checks=0;var capacity=false;
            HttpResponseMessage Reply(object value,HttpStatusCode code=HttpStatusCode.OK)=>new(code){Content=new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,"application/json")};
            HttpResponseMessage Respond(HttpRequestMessage request){
                switch(request.RequestUri!.AbsolutePath){
                    case "/v1/me":return Reply(new{user_id=principal.UserId,memberships=new[]{new{tenant_id=principal.TenantId,tenant_name="Fixture",role="owner"}}});
                    case "/v1/capture-sources":return Reply(new{sources=new[]{new{id=serverSource,tenant_id=principal.TenantId,device_id=principal.DeviceId,kind="folder",upload_ready=true,server_upload_consent=true,active=true,device_active=true,generation=1}}});
                    case "/v1/ingestions":prepares++;return Reply(new{error=new{code="STORAGE_QUOTA_EXCEEDED"}},HttpStatusCode.Conflict);
                    case "/v1/capture-storage":checks++;return Reply(new{limit_bytes=100_000_000_000L,used_bytes=capacity?0L:100_000_000_000L,reserved_bytes=0L});
                    default:throw new AssertFailedException("Unexpected request");
                }
            }
            using var sessions=new WindowsSessionManager(vault,new ReplyHandler(Respond));
            using(var transport=new WindowsUploadTransport(state,copies,sessions,new ReplyHandler(Respond))){
                Assert.IsFalse(await transport.UploadOneAsync());Assert.IsFalse(await transport.UploadOneAsync());
                Assert.AreEqual(1,prepares,"one quota rejection stops the account drain");Assert.AreEqual(0,checks,"throttled until next maintenance");
            }
            Assert.IsTrue(state.HasStorageQuotaPause(principal));
            Assert.AreEqual(0,state.ResumeStorageQuota(principal with{UserId=Guid.NewGuid()},1000));
            Assert.AreEqual(0,state.ResumeStorageQuota(principal,1),"available bytes must fit the paused copy");
            // New transport simulates restart: persisted pause gates every remaining item.
            using(var transport=new WindowsUploadTransport(state,copies,sessions,new ReplyHandler(request=>{
                Assert.AreEqual("/v1/capture-storage",request.RequestUri!.AbsolutePath);checks++;return Reply(new{limit_bytes=100_000_000_000L,used_bytes=100_000_000_000L,reserved_bytes=0L});
            })))Assert.IsFalse(await transport.UploadOneAsync());
            Assert.AreEqual(1,prepares);Assert.AreEqual(1,checks);
            capacity=true;
            using(var transport=new WindowsUploadTransport(state,copies,sessions,new ReplyHandler(Respond)))Assert.IsFalse(await transport.UploadOneAsync());
            Assert.AreEqual(2,checks);Assert.AreEqual(2,prepares,"restored capacity resumes prepare; a concurrent quota rejection pauses again");
            Assert.AreEqual(1,state.ResumeStorageQuota(principal,1000));Assert.IsFalse(state.HasStorageQuotaPause(principal));
            Assert.IsNotNull(state.BeginUpload(principal));
            Assert.AreEqual(2,Directory.GetFiles(source).Length,"source files remain intact");
        }finally{Directory.Delete(root,true);}
    }

    [TestMethod]
    public void BackgroundRecoveryRequiresUnrestrictedConnection()
    {
        Assert.IsTrue(WindowsNetworkCost.AllowsRecovery(1));
        foreach(uint cost in new uint[]{0,2,4,0x10001,0x40001,0x80001})Assert.IsFalse(WindowsNetworkCost.AllowsRecovery(cost));
        _=WindowsNetworkCost.Unmetered(); // Actual COM interop smoke; network policy is unchanged.
    }
    private sealed class Handler(byte[] bytes):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(bytes)});
    }
    [TestMethod]
    public async Task OnlyAcknowledgedCurrentAccountCopyCanBeReclaimedAndDownloadedAgain()
    {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-n04-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            var source=Path.Combine(root,"source");Directory.CreateDirectory(source);var original=Path.Combine(source,"synthetic.pdf");
            var bytes=Encoding.UTF8.GetBytes("synthetic N04 original");File.WriteAllBytes(original,bytes);
            var state=new WindowsStateStore(Path.Combine(root,"state.db"));var folder=state.SelectFolder(source);
            var principal=new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());state.BindSource(folder.Id,principal,Guid.NewGuid(),1);
            var stable=new WindowsFileStabilizer(state,TimeSpan.Zero);stable.Observe(folder.Id,source,original);stable.Observe(folder.Id,source,original);
            var candidate=state.CopyCandidates().Single();using var copies=new WindowsEncryptedCopyStore(state,RandomNumberGenerator.GetBytes(32),Path.Combine(root,"copies"));
            Assert.AreEqual(1,copies.StagePending());Assert.AreEqual(0,state.ReclaimCandidates(principal).Count,"ready copy must remain");
            var upload=state.BeginUpload(principal)!;var ingestion=Guid.NewGuid();var revision=Guid.NewGuid();
            state.SavePreparedUpload(upload.Copy.CaptureKey,ingestion,"synthetic-ticket",DateTimeOffset.UtcNow.AddMinutes(5));
            state.FinishUpload(upload.Copy.CaptureKey,"acknowledged",JsonSerializer.Serialize(new{revision_id=revision}));
            var reclaim=state.ReclaimCandidates(principal).Single();
            Assert.IsFalse(state.ReclaimVerifiedCopy(reclaim,principal,DateTimeOffset.UtcNow.AddMinutes(-2),()=>Assert.Fail("stale proof")));
            Assert.IsFalse(state.ReclaimVerifiedCopy(reclaim,principal with{UserId=Guid.NewGuid()},DateTimeOffset.UtcNow,()=>Assert.Fail("other account")));
            Assert.IsTrue(state.ReclaimVerifiedCopy(reclaim,principal,DateTimeOffset.UtcNow,()=>copies.DeleteManagedCopy(candidate.CaptureKey)));
            Assert.AreEqual(0,copies.StoredBytes);Assert.AreEqual(0,state.ReclaimCandidates(principal).Count);
            stable.Observe(folder.Id,source,original);Assert.AreEqual(0,copies.StagePending(),"unchanged ACK must not be copied again");
            using var http=new HttpClient(new Handler(bytes));Assert.IsTrue(await WindowsCopyMaintenance.DownloadMatchesAsync(http,new Uri("https://storage.example.test/original"),candidate.ContentSha256,bytes.Length,CancellationToken.None));
            CollectionAssert.AreEqual(bytes,File.ReadAllBytes(original));
            File.AppendAllText(original," changed");stable.Observe(folder.Id,source,original);stable.Observe(folder.Id,source,original);
            Assert.AreEqual(1,copies.StagePending(),"new revision remains a new protected copy");Assert.AreEqual(0,state.ReclaimCandidates(principal).Count);
        }finally{Directory.Delete(root,true);}
    }
    [TestMethod]
    public async Task RecoveryUsesLocalCompletionTimeDespiteServerClockSkew()
    {
        var bytes=Encoding.UTF8.GetBytes("synthetic recovery clock");var hash=Convert.ToHexString(SHA256.HashData(bytes));
        var principal=new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
        var session=new WindowsSession("https://api.example.test/","https://storage.example.test/","public","token","refresh",long.MaxValue,principal.TenantId,principal.UserId,principal.DeviceId);
        var item=new ReclaimCandidate(new("copy","source","",hash,bytes.Length,0),Guid.NewGuid(),Guid.NewGuid(),1);
        foreach(var hours in new[]{-24,24}){
            using var http=new HttpClient(new ReplyHandler(request=>request.Method==HttpMethod.Post
                ?new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{state="recoverable",ingestion_id=item.IngestionId,revision_id=item.RevisionId,source_generation=1,sha256=hash,byte_length=bytes.Length,verified_at=DateTimeOffset.UtcNow.AddHours(hours),restore_url=$"https://storage.example.test/storage/v1/object/sign/sigongnote-originals/{principal.TenantId:D}/original",expires_in=60}))}
                :new(HttpStatusCode.OK){Content=new ByteArrayContent(bytes)}));
            var before=DateTimeOffset.UtcNow;
            var verified=await WindowsCopyMaintenance.VerifyRecoveryAsync(item,session,http,CancellationToken.None);
            Assert.IsNotNull(verified);Assert.IsTrue(verified>=before&&verified<=DateTimeOffset.UtcNow);
        }
    }

    [TestMethod]
    public async Task RecoveryRejectsTruncatedChangedBytesAndCapacityIncludesEncryptionOverhead()
    {
        using var http=new HttpClient(new Handler([1,2,3]));
        Assert.IsFalse(await WindowsCopyMaintenance.DownloadMatchesAsync(http,new Uri("https://storage.example.test/original"),new string('a',64),3,CancellationToken.None));
        Assert.IsFalse(await WindowsCopyMaintenance.DownloadMatchesAsync(http,new Uri("https://storage.example.test/original"),Convert.ToHexString(SHA256.HashData([1,2,3])),4,CancellationToken.None));
        Assert.AreEqual(1048620L,WindowsEncryptedCopyStore.EncryptedSize(1048576));
        Assert.IsTrue(WindowsFolderPolicy.Supported("construction.mp4"));Assert.IsTrue(WindowsFolderPolicy.Supported("construction.docx"));Assert.IsFalse(WindowsFolderPolicy.Supported("construction.dwg"));
    }
}
