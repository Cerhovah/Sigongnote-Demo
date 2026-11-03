using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Sigongnote.Contracts;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class RecordingBridgeTests
{
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation)=>Task.FromResult(reply(request));
    }
    private static HttpResponseMessage Json(object body,HttpStatusCode status=HttpStatusCode.OK)=>new(status){Content=new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json")};
    private sealed class Fixture:IDisposable {
        public readonly string Sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-recording-"+Guid.NewGuid().ToString("N"));
        public readonly WindowsStateStore State;
        public readonly WindowsSession Session;
        public readonly WindowsTokenVault Vault;
        public readonly FolderConnection Folder;
        public readonly WindowsSourceSetup Setup;
        public readonly WindowsEncryptedCopyStore Copies;
        public readonly string FilePath;
        public readonly byte[] Original=RandomNumberGenerator.GetBytes(64_000);
        public readonly Guid Ingestion=Guid.NewGuid(),Revision=Guid.NewGuid();
        public readonly CapturePolicy Policy=new("test-audio-v1","work_records","local_fixture","development_computer","development_computer","until_user_deletes",false);
        public int Prepares,Patches,Completed,TusCreates;
        public bool OfflinePatchOnce,Revoked,WrongPolicy;
        public long Offset;
        public string? PrepareKey,CompleteKey;
        public string Mime="audio/wav";
        public Fixture(string extension="wav") {
            Directory.CreateDirectory(Sandbox);var root=Path.Combine(Sandbox,"통화 녹음");Directory.CreateDirectory(root);
            State=new(Path.Combine(Sandbox,"state.db"));Folder=State.SelectFolder(root);
            Session=new("https://api.example.test/","https://storage.example.test/","publishable","recording-token","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            Vault=new(Path.Combine(Sandbox,"session.protected"));Vault.Save(JsonSerializer.Serialize(Session));
            var source=Guid.NewGuid();Setup=new(Folder.Id,Guid.NewGuid(),Session.Principal,Policy,new("call_recording",null,null,true),new string('a',64),null,ServerSourceId:source,Generation:1);
            State.SaveFolderSetup(Setup,"ready");State.BindSource(Folder.Id,Session.Principal,source,1);
            FilePath=Path.Combine(root,"합성 녹음."+extension);File.WriteAllBytes(FilePath,Original);
            var stabilizer=new WindowsFileStabilizer(State,TimeSpan.Zero);stabilizer.Observe(Folder.Id,root,FilePath);stabilizer.Observe(Folder.Id,root,FilePath);
            Copies=new(State,RandomNumberGenerator.GetBytes(32),Path.Combine(Sandbox,"copies"));Assert.AreEqual(1,Copies.StagePending());
            Mime=extension switch{"mp3"=>"audio/mpeg","m4a"=>"audio/mp4",_=>"audio/wav"};
        }
        public string QueueState {
            get{using var db=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=Path.Combine(Sandbox,"state.db"),Pooling=false}.ToString());db.Open();using var query=db.CreateCommand();query.CommandText="SELECT state FROM capture_queue";return (string)query.ExecuteScalar()!;}
        }
        public void AllowRetry(){using var db=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=Path.Combine(Sandbox,"state.db"),Pooling=false}.ToString());db.Open();using var update=db.CreateCommand();update.CommandText="UPDATE upload_attempts SET retry_after='2000-01-01T00:00:00.0000000+00:00'";update.ExecuteNonQuery();}
        public HttpMessageHandler Network()=>new Handler(Reply);
        private HttpResponseMessage Reply(HttpRequestMessage request){
            var path=request.RequestUri!.AbsolutePath;Assert.AreEqual("recording-token",request.Headers.Authorization?.Parameter);
            if(path=="/v1/me")return Json(new{user_id=Session.UserId,memberships=new[]{new{tenant_id=Session.TenantId,tenant_name="합성회사",role="owner"}}});
            if(path=="/v1/capture-sources")return Json(new{sources=new[]{new{id=Setup.ServerSourceId,tenant_id=Session.TenantId,device_id=Session.DeviceId,kind="call_recording",upload_ready=!Revoked,active=!Revoked,device_active=true,server_upload_consent=!Revoked,external_ai_consent=false,generation=1,scope_fingerprint=Setup.Fingerprint,scope=new{capture_method="filesystem",history_mode="all",history_since=(string?)null,scope_mode="work_dedicated",rule_version=1,processing_policy_id=Policy.id,fingerprint_algorithm="hmac-sha256-device-v1"},processing_policy=WrongPolicy?Policy with{id="changed-policy"}:Policy}}});
            if(path=="/v1/ingestions"){
                Prepares++;var key=request.Headers.GetValues("Idempotency-Key").Single();if(PrepareKey is not null)Assert.AreEqual(PrepareKey,key);PrepareKey=key;
                var body=request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();Assert.IsFalse(body.Contains(Sandbox,StringComparison.OrdinalIgnoreCase));
                using var parsed=JsonDocument.Parse(body);Assert.AreEqual(Mime,parsed.RootElement.GetProperty("declared_mime").GetString());Assert.AreEqual(Convert.ToHexString(SHA256.HashData(Original)).ToLowerInvariant(),parsed.RootElement.GetProperty("sha256").GetString());
                return Json(new{ingestion_id=Ingestion,state="prepared",upload_url=$"https://storage.example.test/storage/v1/object/upload/sign/sigongnote-originals/{Session.TenantId:D}/{Ingestion:D}?token={new string('s',64)}",expires_at=DateTimeOffset.UtcNow.AddHours(1).ToString("O"),upload=new{protocol="tus",endpoint="https://storage.example.test/storage/v1/upload/resumable",signature=new string('s',64),bucket="sigongnote-originals",object_name=$"{Session.TenantId:D}/{Ingestion:D}",chunk_bytes=6291456,upsert=false}},HttpStatusCode.Created);
            }
            if(path=="/storage/v1/upload/resumable"&&request.Method==HttpMethod.Post){TusCreates++;Assert.IsTrue(request.Headers.GetValues("Upload-Metadata").Single().Contains(Convert.ToBase64String(Encoding.UTF8.GetBytes(Mime)),StringComparison.Ordinal));var response=new HttpResponseMessage(HttpStatusCode.Created);response.Headers.Location=new Uri("https://storage.example.test/storage/v1/upload/resumable/recording");return response;}
            if(path=="/storage/v1/upload/resumable/recording"&&request.Method==HttpMethod.Head){var response=new HttpResponseMessage(HttpStatusCode.NoContent);response.Headers.TryAddWithoutValidation("Upload-Offset",Offset.ToString());return response;}
            if(path=="/storage/v1/upload/resumable/recording"&&request.Method==HttpMethod.Patch){
                Patches++;var bytes=request.Content!.ReadAsByteArrayAsync().GetAwaiter().GetResult();CollectionAssert.AreEqual(Original.AsSpan((int)Offset,bytes.Length).ToArray(),bytes);
                Offset+=bytes.Length;if(OfflinePatchOnce){OfflinePatchOnce=false;throw new HttpRequestException("synthetic lost upload response");}
                var response=new HttpResponseMessage(HttpStatusCode.NoContent);response.Headers.TryAddWithoutValidation("Upload-Offset",Offset.ToString());return response;
            }
            if(path==$"/v1/ingestions/{Ingestion:D}/complete"){
                Completed++;Assert.AreEqual(Original.LongLength,Offset);var key=request.Headers.GetValues("Idempotency-Key").Single();if(CompleteKey is not null)Assert.AreEqual(CompleteKey,key);CompleteKey=key;
                return Json(new{ingestion_id=Ingestion,state="queued",blob_id=Guid.NewGuid(),document_id=Guid.NewGuid(),revision_id=Revision,job_id=Guid.NewGuid(),deduplicated=false});
            }
            throw new AssertFailedException("Unexpected fixture route "+path);
        }
        public void Dispose(){Copies.Dispose();var target=Path.GetFullPath(Sandbox);Assert.IsTrue(target.StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase)&&Path.GetFileName(target).StartsWith("sigongnote-recording-",StringComparison.Ordinal));Directory.Delete(target,true);}
    }

    [TestMethod]
    public void CaptureIdentityMatchesLocalJournalBridgeGolden(){
        const string source="11111111-1111-4111-8111-111111111111";var token=WindowsFileStabilizer.PathToken(source,@"현장A\업무 녹음.wav");
        Assert.AreEqual("a17966f0-f35f-5bb3-836e-b5c1b0ad1ea5",WindowsFileStabilizer.CaptureKey(source,token,new string('A',64)));
    }

    [TestMethod]
    public void LocalPrimaryKeepsExplicitRecordingCollectorAndAllowsDedicatedChildScope(){
        using var f=new Fixture();var parent=f.State.SelectFolder(f.Sandbox);
        f.State.SaveFolderSetup(new(parent.Id,Guid.NewGuid(),f.Session.Principal,f.Policy,new("folder",null,null,true),"parent",null));
        Assert.IsTrue(WindowsCollectorRouting.CollectNatively(f.State,f.Folder,true));Assert.IsTrue(WindowsCollectorRouting.CollectNatively(f.State,parent,true));Assert.IsTrue(WindowsCollectorRouting.CollectNatively(f.State,parent,false));
        var volume=WindowsVolumeIdentity.Probe(Path.Combine(f.Sandbox,"통화 녹음"));Assert.AreEqual(f.Folder.Id,WindowsCollectorRouting.Covering(f.State,volume,"call_recording")?.Id);
        var child=Path.Combine(f.Sandbox,"새 녹음");Directory.CreateDirectory(child);Assert.IsNull(WindowsCollectorRouting.Covering(f.State,WindowsVolumeIdentity.Probe(child),"call_recording"));
        Assert.IsNotNull(WindowsCollectorRouting.Covering(f.State,WindowsVolumeIdentity.Probe(child)));
        var unmanaged=f.State.SelectFolder(child);Assert.IsFalse(WindowsCollectorRouting.CollectNatively(f.State,unmanaged,true));
        var results=new WindowsFolderReconciler(f.State).Reconcile(folder=>WindowsCollectorRouting.CollectNatively(f.State,folder,true));CollectionAssert.AreEquivalent(new[]{f.Folder.Id,parent.Id},results.Select(row=>row.SourceId).ToArray());
        Assert.AreEqual(2,f.State.LocalNativeScopes(f.Session.Principal).Count);Assert.AreEqual(0,f.State.LocalNativeScopes(f.Session.Principal with{UserId=Guid.NewGuid()}).Count);
        Assert.IsFalse(WindowsStateStore.FolderScopeAllows(f.State.FolderSetup(parent.Id),"random.wav",DateTime.UtcNow.Ticks));
    }

    [TestMethod]
    [DataRow("mp3")][DataRow("m4a")][DataRow("wav")]
    public async Task RecordingUsesExistingTusResumeAndKeepsOriginalHash(string extension){
        using var f=new Fixture(extension){OfflinePatchOnce=true};using var sessions=new WindowsSessionManager(f.Vault,f.Network());using var transport=new WindowsUploadTransport(f.State,f.Copies,sessions,f.Network());
        Assert.IsTrue(await transport.UploadOneAsync());Assert.AreEqual("retry_wait",f.QueueState);f.AllowRetry();Assert.IsTrue(await transport.UploadOneAsync());Assert.AreEqual("acknowledged",f.QueueState);
        Assert.AreEqual(1,f.Prepares);Assert.AreEqual(1,f.TusCreates);Assert.AreEqual(1,f.Patches,"Accepted bytes are recovered with TUS HEAD, never resent after a lost acknowledgement");Assert.AreEqual(1,f.Completed);
        CollectionAssert.AreEqual(f.Original,File.ReadAllBytes(f.FilePath));Assert.IsFalse(await transport.UploadOneAsync());
    }

    [TestMethod]
    [DataRow(false)][DataRow(true)]
    public async Task RecordingRechecksUploadConsentAndProcessingPolicyBeforeSending(bool changedPolicy){
        using var f=new Fixture(){Revoked=!changedPolicy,WrongPolicy=changedPolicy};using var sessions=new WindowsSessionManager(f.Vault,f.Network());using var transport=new WindowsUploadTransport(f.State,f.Copies,sessions,f.Network());
        Assert.IsTrue(await transport.UploadOneAsync());Assert.AreEqual("permission_lost",f.QueueState);Assert.AreEqual(0,f.Prepares);Assert.AreEqual(0,f.TusCreates);CollectionAssert.AreEqual(f.Original,File.ReadAllBytes(f.FilePath));
    }
}
