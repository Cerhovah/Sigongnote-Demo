using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Sigongnote.Contracts;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class ScopedFolderSetupTests
{
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(reply(request));
    }
    private static HttpResponseMessage Json(object body,HttpStatusCode status=HttpStatusCode.OK)=>new(status) { Content=new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json") };
    private sealed class Fixture:IDisposable {
        public readonly string Root=Path.Combine(Path.GetTempPath(),"sigongnote-scope-"+Guid.NewGuid().ToString("N"));
        public readonly WindowsStateStore State;
        public readonly WindowsTokenVault Vault;
        public readonly WindowsDeviceKeyStore Keys;
        public readonly WindowsSession Session;
        public readonly FolderConnection Folder;
        public CapturePolicy Policy=new("local-fixture-v1","work_records","local_fixture","development_computer","development_computer","until_user_deletes",false);
        public CapturePolicy? SourcePolicy;
        public readonly Guid Project=Guid.NewGuid(),Source=Guid.NewGuid();
        public readonly Dictionary<string,string> Requests=[];
        public string? LoseAck;
        public bool Revoked,ChangedAccount;
        public int Posts;
        public bool Recent,NewOnly;
        public bool MirrorEnabled,FailMirrorFile,FollowingDocument;
        public readonly Guid Document=Guid.NewGuid(),Revision=Guid.NewGuid();
        public readonly Guid NextDocument=Guid.NewGuid();
        public int PdfDownloads;
        public bool PhotoSheet,Tombstone,ManagedRoot,MaterialMirror,CommonMaterial,UnassignedMaterial;
        public bool CopyAllowed=true;public string ProjectName="합성 현장";
        public string PdfText="%PDF synthetic";
        public Fixture() {
            Directory.CreateDirectory(Root);Directory.CreateDirectory(Path.Combine(Root,"work"));
            State=new WindowsStateStore(Path.Combine(Root,"state.db"));Folder=State.SelectFolder(Path.Combine(Root,"work"));
            Vault=new WindowsTokenVault(Path.Combine(Root,"session.protected"));Keys=new WindowsDeviceKeyStore(Path.Combine(Root,"keys"));
            Session=new("https://api.example.test/","https://auth.example.test/","publishable","fixture-access","fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            Vault.Save(JsonSerializer.Serialize(Session));var key=Keys.GetOrCreate(Session.TenantId,Session.UserId);Keys.MarkRegistered(Session.TenantId,Session.UserId,Session.DeviceId,key.RegistrationKey);
        }
        public WindowsUploadDestination Destination=>new("Fixture","https://api.example.test",Session.Principal,Policy,[],ManagedRoot?new("folder",null,null,false,Recent,MirrorEnabled,Unassigned:true,ManagedRoot:true):new("folder",null,"새 현장",false,Recent,MirrorEnabled,NewOnly:NewOnly));
        public WindowsSessionManager Manager()=>new(Vault,new Handler(Reply));
        private HttpResponseMessage Reply(HttpRequestMessage request) {
            var route=request.RequestUri!.AbsolutePath;
            if(route=="/v1/sync/changes") {
                object Change(Guid id,string sequence)=>new{sequence,kind=MaterialMirror?"material":PhotoSheet?"photo_sheet":"document",id,tombstone=Tombstone,revision_id=Revision,project_id=CommonMaterial||UnassignedMaterial?(Guid?)null:Project,project_name=ProjectName,organization_state=CommonMaterial?"common":UnassignedMaterial?"unassigned":"linked",copy_allowed=CopyAllowed,mime="application/pdf",sha256=Hash(PdfText),categories=new[]{"agreement","delivery_work"},files=PhotoSheet?new[]{new{format="pdf",sha256=Hash(PdfText)}}:new[]{new{format="pdf",sha256=Hash(PdfText)},new{format="xlsx",sha256=Hash("PK synthetic")}}};
                var changes=new List<object>();
                if(!request.RequestUri!.Query.Contains("cursor=")||request.RequestUri.Query.Contains("kind=")){changes.Add(Change(Document,"1"));if(FollowingDocument)changes.Add(Change(NextDocument,"2"));}
                return Json(new {changes,next_cursor=$"{Session.TenantId}:{Session.UserId}:{(FollowingDocument?2:1)}",has_more=false});
            }
            if(route.StartsWith($"/v1/documents/{Document}/files/")||route.StartsWith($"/v1/documents/{NextDocument}/files/")||route==$"/v1/photo-sheets/{Document}/file"){
                var format=route.EndsWith("/pdf")||route.EndsWith("/file")?"pdf":"xlsx";
                if(format=="xlsx"&&FailMirrorFile){FailMirrorFile=false;throw new HttpRequestException("synthetic offline");}
                if(format=="pdf")PdfDownloads++;
                var bytes=Encoding.UTF8.GetBytes(format=="pdf"?PdfText:"PK synthetic");
                return Json(new{name="합성."+format,sha256=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),base64=Convert.ToBase64String(bytes)});
            }
            if(route==$"/v1/work/materials/{Document}/original")return Json(new{url="https://auth.example.test/storage/v1/object/sign/sigongnote-originals/fixture",sha256=Hash(PdfText)});
            if(route=="/v1/capture-policy")return Json(Policy);
            if(route=="/v1/me")return Json(new { user_id=Session.UserId,memberships=new[]{new { tenant_id=Session.TenantId,tenant_name="Fixture",role="owner" }} });
            if(route=="/v1/work/setup")return Json(new { project_id=(string?)null });
            if(route=="/v1/projects" && request.Method==HttpMethod.Get)return Json(new { projects=Array.Empty<object>() });
            Assert.AreEqual(Session.TenantId.ToString("D"),request.Headers.GetValues("X-Tenant-Id").Single());
            if(request.Method==HttpMethod.Post) {
                Posts++;
                var body=request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                Assert.IsFalse(body.Contains(Root,StringComparison.OrdinalIgnoreCase));
                var key=request.Headers.GetValues("Idempotency-Key").Single();Assert.AreEqual('4',key[14]);
                var signature=key+body;
                if(Requests.TryGetValue(route,out var prior))Assert.AreEqual(prior,signature,"Retry must keep key and body");else Requests[route]=signature;
                if(route=="/v1/capture-sources") {
                    using var payload=JsonDocument.Parse(body);var scope=payload.RootElement.GetProperty("scope");
                    Assert.AreEqual(Recent||NewOnly?"since":"all",scope.GetProperty("history_mode").GetString());Assert.AreEqual("filesystem",scope.GetProperty("capture_method").GetString());
                    Assert.AreEqual(2,payload.RootElement.GetProperty("consent_version").GetInt32());
                    Assert.IsTrue(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(Policy),payload.RootElement.GetProperty("processing_policy")),"Source registration must send the full policy shown for consent");
                }
                if(route==LoseAck) { LoseAck=null;throw new HttpRequestException("synthetic lost acknowledgement"); }
                if(route=="/v1/projects")return Json(new { id=Project,display_name="새 현장",version=1 },HttpStatusCode.Created);
                if(route=="/v1/capture-sources")return Json(new { id=Source },HttpStatusCode.Created);
                if(route=="/v1/site-folder-bindings") {
                    if(ChangedAccount)Vault.Save(JsonSerializer.Serialize(Session with {UserId=Guid.NewGuid()}));
                    return Json(Binding());
                }
            }
            var setup=State.FolderSetup(Folder.Id)!;
            if(route=="/v1/capture-sources")return Json(new { sources=new[]{new { id=Source,tenant_id=Session.TenantId,device_id=Session.DeviceId,kind=setup.Selection.Kind,active=!Revoked,device_active=true,upload_ready=true,server_upload_consent=true,generation=1,scope_fingerprint=setup.Fingerprint,
                scope=new { capture_method="filesystem",history_mode=Recent||NewOnly?"since":"all",history_since=setup.Since is null?null:DateTimeOffset.Parse(setup.Since,System.Globalization.CultureInfo.InvariantCulture).ToString("yyyy-MM-ddTHH:mm:ss.fffzzz",System.Globalization.CultureInfo.InvariantCulture),scope_mode="work_dedicated",rule_version=1,processing_policy_id=Policy.id,fingerprint_algorithm="hmac-sha256-device-v1",processing_lane=NewOnly?"current":null },processing_policy=SourcePolicy??Policy }} });
            if(route=="/v1/site-folder-bindings")return Json(new { bindings=new[]{Binding()} });
            throw new AssertFailedException("Unexpected route "+route);
        }
        private static string Hash(string text)=>Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
        private object Binding() { var setup=State.FolderSetup(Folder.Id)!;return new {id=Guid.NewGuid(),source_id=Source,source_generation=1,scope_fingerprint=setup.Fingerprint,scope_mode=ManagedRoot?"unassigned":"project",project_id=ManagedRoot?(Guid?)null:Project,version=1}; }
        public void Dispose() { Assert.IsTrue(Path.GetFullPath(Root).StartsWith(Path.GetFullPath(Path.GetTempPath())));Directory.Delete(Root,true); }
    }
    private static CapturePolicy MultiProcessorPolicy()=>JsonSerializer.Deserialize<CapturePolicy>("""
        {"id":"multi-fixture-v1","purpose":"work_records","provider":"anthropic","processing_location":"primary-region","storage_location":"company-storage","retention":"until_user_deletes","external_processing":true,
        "processors":[{"purpose":"long_stt","provider":"openai","processing_location":"stt-region","storage_location":"stt-storage","retention":"delete_after_transcription"}]}
        """)!;
    private static CapturePolicy ChangedProcessor(CapturePolicy policy,string field,string value) {
        var json=JsonSerializer.SerializeToNode(policy)!;
        json["processors"]![0]![field]=value;
        return json.Deserialize<CapturePolicy>()!;
    }
    [TestMethod]
    public async Task FullProcessorSnapshotSurvivesSavedSetupRetryWithoutReplacingLineage()
    {
        using var f=new Fixture();f.Policy=MultiProcessorPolicy();f.LoseAck="/v1/capture-sources";
        using(var manager=f.Manager())await Assert.ThrowsExactlyAsync<WindowsSessionUnavailableException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination));
        var saved=f.State.FolderSetup(f.Folder.Id)!;
        Assert.HasCount(1,saved.Policy.processors!);Assert.AreEqual("openai",saved.Policy.processors![0].provider);
        Assert.AreEqual("delete_after_transcription",saved.Policy.processors[0].retention);
        using(var resumed=f.Manager()) {
            var approval=await resumed.UploadDestinationAsync(includeSetup:true);
            Assert.AreNotSame(saved.Policy.processors,approval.Policy!.processors);
            await resumed.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,approval with {Selection=f.Destination.Selection});
        }
        Assert.AreEqual("ready",f.State.FolderSetupState(f.Folder.Id));Assert.AreEqual(saved.Key,f.State.FolderSetup(f.Folder.Id)!.Key);
        Assert.AreEqual(saved.Fingerprint,f.State.FolderSetup(f.Folder.Id)!.Fingerprint);Assert.AreEqual(f.Source,f.State.Folders().Single().ServerSourceId);
        using var request=JsonDocument.Parse(f.Requests["/v1/capture-sources"][36..]);
        Assert.IsTrue(request.RootElement.GetProperty("external_ai_consent").GetBoolean());
        Assert.IsTrue(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(f.Policy),request.RootElement.GetProperty("processing_policy")));
    }
    [TestMethod]
    [DataRow("provider","clova_speech")]
    [DataRow("processing_location","changed-region")]
    [DataRow("storage_location","changed-storage")]
    [DataRow("retention","changed-retention")]
    public async Task ChangedProcessorUnderSamePolicyIdCannotRegisterFromOldApproval(string field,string value)
    {
        using var f=new Fixture();f.Policy=MultiProcessorPolicy();var approved=f.Destination;
        f.Policy=ChangedProcessor(f.Policy,field,value);Assert.AreEqual(approved.Policy!.id,f.Policy.id);
        using var manager=f.Manager();await Assert.ThrowsExactlyAsync<WindowsSourceConflictException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,approved));
        Assert.AreEqual(0,f.Posts);Assert.IsNull(f.State.Folders().Single().ServerSourceId);
        Assert.AreEqual(value,f.Policy.processors!.Select(p=>field switch {"provider"=>p.provider,"processing_location"=>p.processing_location,"storage_location"=>p.storage_location,_=>p.retention}).Single());
    }
    [TestMethod]
    public async Task SavedSingleProviderConsentDoesNotInheritANewProcessor()
    {
        using var f=new Fixture();f.Policy=MultiProcessorPolicy() with {processors=null};f.LoseAck="/v1/capture-sources";
        using var manager=f.Manager();await Assert.ThrowsExactlyAsync<WindowsSessionUnavailableException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination));
        var posts=f.Posts;var saved=f.State.FolderSetup(f.Folder.Id)!;f.Policy=MultiProcessorPolicy();
        await manager.ResumeFolderSetupsAsync(f.State);
        Assert.AreEqual("needs_attention",f.State.FolderSetupState(f.Folder.Id));Assert.AreEqual(posts,f.Posts);
        Assert.AreEqual(saved.Key,f.State.FolderSetup(f.Folder.Id)!.Key);Assert.IsNull(f.State.FolderSetup(f.Folder.Id)!.Policy.processors);
        Assert.IsNull(f.State.Folders().Single().ServerSourceId);
    }
    [TestMethod]
    public async Task DifferentProcessorReturnedForSameSourcePolicyCannotEnableUpload()
    {
        using var f=new Fixture();f.Policy=MultiProcessorPolicy();f.SourcePolicy=ChangedProcessor(f.Policy,"retention","changed-retention");
        using var manager=f.Manager();await Assert.ThrowsExactlyAsync<WindowsSourceInactiveException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination));
        Assert.IsFalse(f.Requests.ContainsKey("/v1/site-folder-bindings"));Assert.IsNull(f.State.Folders().Single().ServerSourceId);
        Assert.IsNull(f.State.BeginUpload(f.Session.Principal));
    }
    [TestMethod]
    public async Task NewOnlyScopeRemainsCurrentAndRetainsSinceAfterLostAcknowledgement(){
        using var f=new Fixture();f.NewOnly=true;f.LoseAck="/v1/capture-sources";using var manager=f.Manager();
        await Assert.ThrowsExactlyAsync<WindowsSessionUnavailableException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination));
        var since=f.State.FolderSetup(f.Folder.Id)!.Since;await manager.ResumeFolderSetupsAsync(f.State);
        Assert.AreEqual(since,f.State.FolderSetup(f.Folder.Id)!.Since);using var payload=JsonDocument.Parse(f.Requests["/v1/capture-sources"][36..]);
        Assert.AreEqual("current",payload.RootElement.GetProperty("scope").GetProperty("processing_lane").GetString());Assert.IsFalse(f.State.FolderSetup(f.Folder.Id)!.Selection.JournalCopies);
    }
    [TestMethod]
    public async Task ExplicitRecordingChoiceRegistersItsOwnConsentedCurrentSourceAndBinding(){
        using var f=new Fixture();f.NewOnly=true;f.LoseAck="/v1/capture-sources";using var manager=f.Manager();
        var destination=f.Destination with {Selection=new("call_recording",null,"새 현장",false,NewOnly:true)};
        await Assert.ThrowsExactlyAsync<WindowsSessionUnavailableException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,destination));
        await manager.ResumeFolderSetupsAsync(f.State);Assert.AreEqual("ready",f.State.FolderSetupState(f.Folder.Id));
        using var source=JsonDocument.Parse(f.Requests["/v1/capture-sources"][36..]);var body=source.RootElement;
        Assert.AreEqual("call_recording",body.GetProperty("kind").GetString());Assert.IsTrue(body.GetProperty("local_selection_consent").GetBoolean());Assert.IsTrue(body.GetProperty("server_upload_consent").GetBoolean());Assert.IsFalse(body.GetProperty("external_ai_consent").GetBoolean());
        Assert.AreEqual("current",body.GetProperty("scope").GetProperty("processing_lane").GetString());Assert.AreEqual(f.Policy.id,body.GetProperty("scope").GetProperty("processing_policy_id").GetString());
        Assert.AreEqual(f.Source,f.State.Folders().Single().ServerSourceId);
    }
    [TestMethod]
    public async Task CompanyRootReceivesNewProjectCommonAndUnassignedWithSharedIndexesAndHash(){
        using var f=new Fixture();f.ManagedRoot=true;f.MirrorEnabled=true;f.MaterialMirror=true;
        using var manager=f.Manager();await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);
        using var download=new Handler(_=>new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(f.PdfText)});
        using var mirror=new WindowsMirrorWorker(f.State,manager,download);await mirror.RunOnce();
        var journal=f.State.Mirror(f.Folder.Id);var entry=journal.Entries.Values.Single();StringAssert.StartsWith(entry.Relative,"현장");StringAssert.Contains(entry.Relative,f.Project.ToString());
        var root=Path.Combine(f.Folder.RootPath!,"시공노트");var path=Path.Combine(root,entry.Relative);Assert.AreEqual(f.PdfText,await File.ReadAllTextAsync(path));
        StringAssert.Contains(await File.ReadAllTextAsync(Path.Combine(root,entry.Scope,"납품·작업","자료목록.html")),"../");Assert.AreEqual(1,Directory.GetFiles(root,"*.pdf",SearchOption.AllDirectories).Length);
        Assert.IsFalse(Directory.Exists(Path.Combine(root,entry.Scope,"사진대지")),"Empty categories must not create folders or indexes");
        f.ProjectName="이름 변경";f.State.SaveMirror(f.Folder.Id,journal with {Cursor=null});await mirror.RunOnce();Assert.AreEqual(entry.Relative,f.State.Mirror(f.Folder.Id).Entries.Values.Single().Relative);
        f.CommonMaterial=true;f.State.SaveMirror(f.Folder.Id,f.State.Mirror(f.Folder.Id) with {Cursor=null});await mirror.RunOnce();Assert.IsTrue(f.State.Mirror(f.Folder.Id).Entries.Values.Any(e=>e.State=="ready"&&e.Scope=="회사 공통"));
        f.CommonMaterial=false;f.UnassignedMaterial=true;f.State.SaveMirror(f.Folder.Id,f.State.Mirror(f.Folder.Id) with {Cursor=null});await mirror.RunOnce();Assert.IsTrue(f.State.Mirror(f.Folder.Id).Entries.Values.Any(e=>e.State=="ready"&&e.Scope=="현장 확인 전"));
        f.CopyAllowed=false;f.State.SaveMirror(f.Folder.Id,f.State.Mirror(f.Folder.Id) with {Cursor=null});await mirror.RunOnce();Assert.IsFalse(f.State.Mirror(f.Folder.Id).Entries.Values.Any(e=>e.State=="ready"));Assert.AreEqual(f.PdfText,await File.ReadAllTextAsync(path));
        Assert.AreEqual("분류 확인 전",WindowsMirrorFiles.Category(null));Assert.IsFalse(WindowsFolderPreview.Scan(f.Folder.RootPath!,f.State,f.Folder.Id,CancellationToken.None).Formats.ContainsKey(".pdf"));
    }
    [TestMethod]
    public async Task CompanyMirrorKeepsExisting2001ReceiptsAndReceivesLaterProjectWithoutRebinding(){
        using var f=new Fixture();f.ManagedRoot=true;f.MirrorEnabled=true;using var manager=f.Manager();await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);
        var setup=f.State.FolderSetup(f.Folder.Id)!;var journal=f.State.Mirror(f.Folder.Id);
        for(var i=0;i<2001;i++)journal.Entries["older:"+i]=new("document",Guid.NewGuid().ToString(),Guid.NewGuid().ToString(),new string('a',64),Path.Combine("발행문서",i+".pdf"),"unavailable");
        f.State.SaveMirror(f.Folder.Id,journal);using(var mirror=new WindowsMirrorWorker(f.State,manager))await mirror.RunOnce();
        var saved=f.State.Mirror(f.Folder.Id);Assert.HasCount(2003,saved.Entries);Assert.HasCount(0,saved.Retries!);Assert.AreEqual(setup.Key,f.State.FolderSetup(f.Folder.Id)!.Key);Assert.IsTrue(saved.Entries.Values.Any(e=>e.State=="ready"&&e.Scope.StartsWith("현장")));
        using(var mirror=new WindowsMirrorWorker(f.State,manager))await mirror.RunOnce();Assert.HasCount(2003,f.State.Mirror(f.Folder.Id).Entries);Assert.AreEqual(1,f.PdfDownloads);
    }
    [TestMethod]
    public async Task PhotoSheetAndChangedDocumentPreserveEditedCopiesAndTombstones(){
        using var f=new Fixture();f.MirrorEnabled=true;f.PhotoSheet=true;using var manager=f.Manager();await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);
        using var mirror=new WindowsMirrorWorker(f.State,manager);await mirror.RunOnce();var old=f.State.Mirror(f.Folder.Id).Entries.Values.Single();Assert.AreEqual("photo_sheet",old.Kind);
        var path=Path.Combine(f.Folder.RootPath!,"시공노트",old.Relative);await File.WriteAllTextAsync(path,"user edited copy");
        f.PdfText="%PDF synthetic changed";var journal=f.State.Mirror(f.Folder.Id);f.State.SaveMirror(f.Folder.Id,journal with {Cursor=null});await mirror.RunOnce();
        var next=f.State.Mirror(f.Folder.Id);Assert.HasCount(2,next.Entries);Assert.AreEqual(1,next.Entries.Values.Count(e=>e.State=="edited"));Assert.AreEqual(1,next.Entries.Values.Count(e=>e.State=="ready"));Assert.AreEqual("user edited copy",await File.ReadAllTextAsync(path));
        f.Tombstone=true;f.State.SaveMirror(f.Folder.Id,next with {Cursor=null});await mirror.RunOnce();Assert.IsFalse(f.State.Mirror(f.Folder.Id).Entries.Values.Any(e=>e.State=="ready"));Assert.AreEqual("user edited copy",await File.ReadAllTextAsync(path));
        Assert.IsFalse(WindowsFolderPreview.Scan(f.Folder.RootPath!,f.State,f.Folder.Id,CancellationToken.None).Formats.ContainsKey(".pdf"));
    }
    [TestMethod]
    public async Task FailedFileDoesNotBlockFollowingDocumentOrCursor(){
        using var f=new Fixture();f.MirrorEnabled=true;f.FollowingDocument=true;using var manager=f.Manager();
        await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);f.FailMirrorFile=true;
        using(var mirror=new WindowsMirrorWorker(f.State,manager))await mirror.RunOnce();
        var journal=f.State.Mirror(f.Folder.Id);Assert.IsTrue(journal.Cursor!.EndsWith(":2"));Assert.HasCount(1,journal.Retries!);
        Assert.HasCount(3,journal.Entries);Assert.AreEqual(2,journal.Entries.Values.Count(e=>e.Id==f.NextDocument.ToString()));
    }
    [TestMethod]
    public async Task MirrorRestartsAfterOfflineWithoutRecopyingOrOverwriting(){
        using var f=new Fixture();f.MirrorEnabled=true;using var manager=f.Manager();
        await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);
        f.FailMirrorFile=true;
        using(var mirror=new WindowsMirrorWorker(f.State,manager)){await mirror.RunOnce();StringAssert.Contains(mirror.Status,"못 받은 1개");}
        var pending=f.State.Mirror(f.Folder.Id);Assert.IsNotNull(pending.Cursor);Assert.HasCount(1,pending.Retries!);
        f.State.SaveMirror(f.Folder.Id,pending with {Retries=pending.Retries!.ToDictionary(e=>e.Key,e=>e.Value with {NextAttempt=0})});
        using(var mirror=new WindowsMirrorWorker(f.State,manager)){await mirror.RunOnce();StringAssert.Contains(mirror.Status,"최신 확인");}
        Assert.AreEqual(1,f.PdfDownloads);var journal=f.State.Mirror(f.Folder.Id);Assert.IsNotNull(journal.Cursor);Assert.HasCount(2,journal.Entries);
        var pdf=journal.Entries.Values.Single(e=>e.Relative.EndsWith(".pdf"));var file=Path.Combine(f.Folder.RootPath!,"시공노트",pdf.Relative);await File.WriteAllTextAsync(file,"user edit");
        f.State.SaveMirror(f.Folder.Id,journal with {Cursor=null});
        using(var mirror=new WindowsMirrorWorker(f.State,manager)){await mirror.RunOnce();StringAssert.Contains(mirror.Status,"수정 사본 1개 보존");}
        Assert.AreEqual("user edit",await File.ReadAllTextAsync(file));Assert.AreEqual("edited",f.State.Mirror(f.Folder.Id).Entries.Values.Single(e=>e.Relative.EndsWith(".pdf")).State);
        Assert.IsFalse(WindowsFolderPreview.Scan(f.Folder.RootPath!,f.State,f.Folder.Id,CancellationToken.None).Formats.ContainsKey(".pdf"));
    }
    [TestMethod]
    [DataRow("/v1/projects")]
    [DataRow("/v1/capture-sources")]
    [DataRow("/v1/site-folder-bindings")]
    public async Task LostAckResumesWithoutDuplicatingProjectSourceOrBinding(string route) {
        using var f=new Fixture();f.LoseAck=route;
        using(var manager=f.Manager()) {
            var destination=await manager.UploadDestinationAsync(includeSetup:true);Assert.AreEqual(f.Policy,destination.Policy);
            try { await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);Assert.Fail("Expected lost ACK"); }
            catch(Exception error) when(error is HttpRequestException or WindowsSessionUnavailableException) {}
        }
        Assert.AreEqual("pending",f.State.FolderSetupState(f.Folder.Id));
        Assert.IsNull(f.State.BeginUpload(f.Session.Principal));
        using(var resumed=f.Manager())await resumed.ResumeFolderSetupsAsync(f.State);
        Assert.AreEqual("ready",f.State.FolderSetupState(f.Folder.Id));
        Assert.AreEqual(f.Source,f.State.Folders().Single().ServerSourceId);
        Assert.AreEqual(4,f.Posts);Assert.AreEqual(3,f.Requests.Count);
    }
    [TestMethod]
    public async Task ChangedAccountAfterBindingCannotEnableUpload() {
        using var f=new Fixture();f.ChangedAccount=true;using var manager=f.Manager();
        await Assert.ThrowsExactlyAsync<WindowsSourceInactiveException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination));
        Assert.IsNull(f.State.Folders().Single().ServerSourceId);
        Assert.AreEqual("pending",f.State.FolderSetupState(f.Folder.Id));
        await manager.ResumeFolderSetupsAsync(f.State);Assert.AreEqual(3,f.Posts);
    }
    [TestMethod]
    public async Task RevokedServerSourceStopsPendingConnection() {
        using var f=new Fixture();f.LoseAck="/v1/site-folder-bindings";using var manager=f.Manager();
        await Assert.ThrowsExactlyAsync<HttpRequestException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination));
        f.Revoked=true;await manager.ResumeFolderSetupsAsync(f.State);
        Assert.AreEqual("needs_attention",f.State.FolderSetupState(f.Folder.Id));Assert.IsNull(f.State.Folders().Single().ServerSourceId);
    }
    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ExplicitReconsentRecoversRevokedOrChangedPolicy(bool policyChange) {
        using var f=new Fixture();f.LoseAck="/v1/site-folder-bindings";using var manager=f.Manager();
        await Assert.ThrowsExactlyAsync<HttpRequestException>(()=>manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination));
        var old=f.State.FolderSetup(f.Folder.Id)!;
        if(policyChange)f.Policy=f.Policy with {id="local-fixture-v2"};else f.Revoked=true;
        await manager.ResumeFolderSetupsAsync(f.State);Assert.AreEqual("needs_attention",f.State.FolderSetupState(f.Folder.Id));
        f.Revoked=false;f.Requests.Clear();
        await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);
        Assert.AreEqual("ready",f.State.FolderSetupState(f.Folder.Id));Assert.AreNotEqual(old.Key,f.State.FolderSetup(f.Folder.Id)!.Key);
        Assert.AreNotEqual(old.Fingerprint,f.State.FolderSetup(f.Folder.Id)!.Fingerprint);
    }
    [TestMethod]
    public async Task RecentScopeAcceptsEquivalentTimestampInAnotherCulture() {
        using var f=new Fixture();f.Recent=true;using var manager=f.Manager();
        var before=System.Globalization.CultureInfo.CurrentCulture;
        try {
            System.Globalization.CultureInfo.CurrentCulture=System.Globalization.CultureInfo.GetCultureInfo("fi-FI");
            await manager.ConnectScopedFolderAsync(f.State,f.Keys,f.Folder.Id,f.Destination);
            Assert.AreEqual("ready",f.State.FolderSetupState(f.Folder.Id));
        } finally {System.Globalization.CultureInfo.CurrentCulture=before;}
    }
    [TestMethod]
    public void KindAndHistoryStayNarrowedWithoutRelabelingCameraOrRecording() {
        using var f=new Fixture();
        var setup=new WindowsSourceSetup(f.Folder.Id,Guid.NewGuid(),f.Session.Principal,f.Policy,new("photos",null,null,true),"fixture",DateTime.UtcNow.AddDays(-30).ToString("O"));
        Assert.IsTrue(WindowsStateStore.FolderScopeAllows(setup,"site/photo.jpg",DateTime.UtcNow.Ticks));
        Assert.IsFalse(WindowsStateStore.FolderScopeAllows(setup,"site/photo.jpg",DateTime.UtcNow.AddDays(-31).Ticks));
        Assert.IsFalse(WindowsStateStore.FolderScopeAllows(setup,"site/document.pdf",DateTime.UtcNow.Ticks));
        setup=setup with {Selection=new("folder",null,null,true)};
        Assert.IsFalse(WindowsStateStore.FolderScopeAllows(setup,"DCIM/photo.jpg",DateTime.UtcNow.Ticks));
        Assert.IsFalse(WindowsStateStore.FolderScopeAllows(setup,"Recordings/voice.m4a",DateTime.UtcNow.Ticks));
        Assert.IsTrue(WindowsStateStore.FolderScopeAllows(setup,"site/document.pdf",DateTime.UtcNow.Ticks));
        setup=setup with {Selection=new("call_recording",null,null,true)};
        Assert.IsTrue(WindowsStateStore.FolderScopeAllows(setup,"Recordings/voice.m4a",DateTime.UtcNow.Ticks));
        Assert.IsFalse(WindowsStateStore.FolderScopeAllows(setup,"site/document.pdf",DateTime.UtcNow.Ticks));
    }
}
