using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;
[TestClass]
public sealed class WorkApiTests
{
    private const string MultiPolicy="""{"id":"synthetic-multi-v1","purpose":"work_records","provider":"anthropic","processing_location":"provider account region","storage_location":"company storage","retention":"until_user_deletes","external_processing":true,"processors":[{"purpose":"long_stt","provider":"openai","processing_location":"provider account region","storage_location":"provider infrastructure","retention":"transcription policy"}]}""";

    [TestMethod]
    public async Task ContextRoutesUseNativeIdentityAndPreserveTheExactServerContract(){
        var id=Guid.NewGuid().ToString();using var policy=JsonDocument.Parse(MultiPolicy);
        var command=JsonSerializer.Serialize(new{action="case.review",id,version=1,state="adopted",reason="합성 근거 확인",command_id=id});
        var lines=JsonSerializer.Serialize(new[]{new{id,description="합성 품목",spec="",unit="개",quantity="12.500000",unit_price="9007199254740993"}});
        var cases=new[]{
            (JsonSerializer.Serialize(new{route="events.list",project_id=id,limit=100}),$"/v1/work/events?project_id={id}&limit=100",(string?)null),
            (JsonSerializer.Serialize(new{route="events.read",id}),$"/v1/work/events/{id}",(string?)null),
            (JsonSerializer.Serialize(new{route="context-learning.list"}),"/v1/context-learning",(string?)null),
            (JsonSerializer.Serialize(new{route="context-learning.command",command}),"/v1/context-learning/commands",command),
            (JsonSerializer.Serialize(new{route="ai.consent",allowed=true,expected_version=3,client_command_id=id,processing_policy=policy.RootElement}),"/v1/local-journal/ai-consent",JsonSerializer.Serialize(new{allowed=true,expected_version=3,client_command_id=id,processing_policy=policy.RootElement})),
            (JsonSerializer.Serialize(new{route="ai.consent",allowed=false,expected_version=4,client_command_id=id}),"/v1/local-journal/ai-consent",JsonSerializer.Serialize(new{allowed=false,expected_version=4,client_command_id=id})),
            (JsonSerializer.Serialize(new{route="documents.prepare",project_id=id,type="estimate",client_command_id=id}),"/v1/document-drafts",JsonSerializer.Serialize(new{project_id=id,type="estimate",client_command_id=id})),
            (JsonSerializer.Serialize(new{route="documents.complete",id,client_command_id=id,lines}),$"/v1/document-drafts/{id}/complete",JsonSerializer.Serialize(new{client_command_id=id,lines}))
        };
        var vault=new WindowsTokenVault(Path.Combine(Path.GetTempPath(),"sigongnote-context-"+Guid.NewGuid()));
        var session=new WindowsSession("https://api.example.test/","https://auth.example.test/","public","access","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
        vault.Save(JsonSerializer.Serialize(session));var index=0;
        try{
            using var manager=new WindowsSessionManager(vault,new Handler(request=>{
                var expected=cases[index++];Assert.AreEqual(expected.Item2,request.RequestUri!.PathAndQuery);
                Assert.AreEqual(expected.Item3 is null?HttpMethod.Get:HttpMethod.Post,request.Method);
                Assert.AreEqual("access",request.Headers.Authorization?.Parameter);Assert.AreEqual(session.TenantId.ToString(),request.Headers.GetValues("X-Tenant-ID").Single());
                Assert.IsFalse(request.Headers.Contains("Idempotency-Key"));
                if(expected.Item3 is null)Assert.IsNull(request.Content);
                else{using var actual=JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());using var body=JsonDocument.Parse(expected.Item3);Assert.IsTrue(JsonElement.DeepEquals(body.RootElement,actual.RootElement));}
                return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"stored\":true}",Encoding.UTF8,"application/json")};
            }));
            foreach(var item in cases){using var payload=JsonDocument.Parse(item.Item1);Assert.AreEqual("{\"stored\":true}",await manager.WorkRequestAsync(payload.RootElement));}
            Assert.AreEqual(cases.Length,index);
        }finally{vault.Clear();}
    }

    [TestMethod]
    public void ContextAndManualDraftRoutesRejectForgedAuthorityAndInvalidContracts(){
        var id=Guid.NewGuid().ToString();
        var invalid=new[]{
            JsonSerializer.Serialize(new{route="events.list",limit=101}),JsonSerializer.Serialize(new{route="events.list",limit=0}),
            JsonSerializer.Serialize(new{route="events.list",project_id="../other"}),JsonSerializer.Serialize(new{route="events.read",id="../original"}),
            JsonSerializer.Serialize(new{route="events.list",tenant_id=id}),JsonSerializer.Serialize(new{route="context-learning.list",user_id=id}),
            JsonSerializer.Serialize(new{route="context-learning.command",command=new string('x',16001)}),JsonSerializer.Serialize(new{route="context-learning.command",command="{}",url="https://other.test"}),
            JsonSerializer.Serialize(new{route="documents.prepare",project_id=id,type="invoice",client_command_id=id}),
            JsonSerializer.Serialize(new{route="documents.prepare",project_id="../other",type="estimate",client_command_id=id}),
            JsonSerializer.Serialize(new{route="documents.prepare",project_id=id,type="estimate"}),JsonSerializer.Serialize(new{route="documents.prepare",project_id=id,type="estimate",client_command_id=id,amount_minor="1"}),
            JsonSerializer.Serialize(new{route="documents.complete",id,client_command_id=id,lines=new string('x',64001)}),JsonSerializer.Serialize(new{route="documents.complete",id,client_command_id=id,lines=""}),
            JsonSerializer.Serialize(new{route="ai.consent",allowed=true,expected_version=-1,client_command_id=id}),JsonSerializer.Serialize(new{route="ai.consent",allowed=true,expected_version=0}),
            JsonSerializer.Serialize(new{route="ai.consent",allowed=true,client_command_id=id}),JsonSerializer.Serialize(new{route="ai.consent",allowed=false,expected_version=0,client_command_id=id,tenant_id=id}),
            "{\"route\":\"ai.consent\",\"allowed\":true,\"expected_version\":0,\"client_command_id\":\""+id+"\",\"processing_policy\":"+MultiPolicy.Replace("\"purpose\":\"long_stt\"","\"purpose\":\"semantic\"")+"}",
            "{\"route\":\"ai.consent\",\"allowed\":true,\"expected_version\":0,\"client_command_id\":\""+id+"\",\"processing_policy\":"+MultiPolicy.Replace("\"provider\":\"openai\"","\"provider\":\"openai\",\"bypass\":true")+"}",
            "{\"route\":\"ai.consent\",\"allowed\":true,\"expected_version\":0,\"client_command_id\":\""+id+"\",\"processing_policy\":"+MultiPolicy.Replace("\"external_processing\":true","\"external_processing\":false")+"}"
        };
        foreach(var raw in invalid){using var payload=JsonDocument.Parse(raw);Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(payload.RootElement));}
    }

    [TestMethod]
    public void EscapedDraftAndLearningPayloadsFitOnlyTheirOwnBoundedBridgeRoutes(){
        var id=Guid.NewGuid().ToString();
        var lines=new string('가',64000);var quantities=new string('가',16000);
        using var payload=JsonDocument.Parse(JsonSerializer.Serialize(new{route="documents.complete",id,client_command_id=id,lines,quantities}));
        var length=JsonSerializer.Serialize(new{bridgeVersion=1,requestId=id,method="workRequest",payload=payload.RootElement}).Length;
        Assert.IsTrue(length>16384);Assert.IsTrue(WindowsWorkForm.AllowsMessageLength("documents.complete",length));
        using var body=JsonDocument.Parse(WindowsWorkRoutes.Body(WindowsWorkRoutes.Decode(payload.RootElement))!);Assert.AreEqual(lines,body.RootElement.GetProperty("lines").GetString());Assert.AreEqual(quantities,body.RootElement.GetProperty("quantities").GetString());
        using var command=JsonDocument.Parse(JsonSerializer.Serialize(new{route="context-learning.command",command=new string('가',16000)}));
        var commandLength=JsonSerializer.Serialize(new{bridgeVersion=1,requestId=id,method="workRequest",payload=command.RootElement}).Length;
        Assert.IsTrue(WindowsWorkForm.AllowsMessageLength("context-learning.command",commandLength));Assert.AreEqual(new string('가',16000),WindowsWorkRoutes.Body(WindowsWorkRoutes.Decode(command.RootElement)));
        Assert.IsFalse(WindowsWorkForm.AllowsMessageLength("events.list",length));Assert.IsFalse(WindowsWorkForm.AllowsMessageLength("context-learning.command",100001));Assert.IsFalse(WindowsWorkForm.AllowsMessageLength("documents.complete",500001));
        Assert.IsTrue(WindowsWorkForm.AllowsMessageLength("photos.command",64000));Assert.IsFalse(WindowsWorkForm.AllowsMessageLength("photos.command",64001));Assert.IsTrue(WindowsWorkForm.AllowsMessageLength("voice.transcribe",1100000));Assert.IsFalse(WindowsWorkForm.AllowsMessageLength("voice.transcribe",1100001));
    }

    [TestMethod]
    public async Task ConsentPolicyChangeAndPermissionFailureAreNotAcceptedOrResubmitted(){
        var id=Guid.NewGuid().ToString();var vault=new WindowsTokenVault(Path.Combine(Path.GetTempPath(),"sigongnote-context-rejected-"+Guid.NewGuid()));
        var session=new WindowsSession("https://api.example.test/","https://auth.example.test/","public","access","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());vault.Save(JsonSerializer.Serialize(session));
        try{
            var count=0;using var manager=new WindowsSessionManager(vault,new Handler(_=>{count++;return new HttpResponseMessage(HttpStatusCode.Gone);}));
            using var payload=JsonDocument.Parse(JsonSerializer.Serialize(new{route="ai.consent",allowed=true,expected_version=0,client_command_id=id}));
            var changed=await Assert.ThrowsExactlyAsync<WindowsWorkRejectedException>(()=>manager.WorkRequestAsync(payload.RootElement));Assert.AreEqual("SOURCE_EXPIRED",changed.Code);Assert.AreEqual(1,count);
            var denied=0;using var forbidden=new WindowsSessionManager(vault,new Handler(_=>{denied++;return new HttpResponseMessage(HttpStatusCode.Forbidden);}));
            using var list=JsonDocument.Parse("{\"route\":\"context-learning.list\"}");await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(()=>forbidden.WorkRequestAsync(list.RootElement));Assert.AreEqual(1,denied);
        }finally{vault.Clear();}
    }

    [TestMethod]
    public async Task UnknownContextWriteWaitsForAnExplicitRetryWithTheSameCommandIdentity(){
        var id=Guid.NewGuid().ToString();var vault=new WindowsTokenVault(Path.Combine(Path.GetTempPath(),"sigongnote-context-retry-"+Guid.NewGuid()));
        var session=new WindowsSession("https://api.example.test/","https://auth.example.test/","public","access","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());vault.Save(JsonSerializer.Serialize(session));
        try{
            var bodies=new List<string>();using var manager=new WindowsSessionManager(vault,new Handler(request=>{
                bodies.Add(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());if(bodies.Count==1)throw new HttpRequestException("synthetic acknowledgement lost");
                return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"stored\":true}")};
            }));
            using var payload=JsonDocument.Parse(JsonSerializer.Serialize(new{route="context-learning.command",command=JsonSerializer.Serialize(new{action="procedure.stop",id,version=2,command_id=id})}));
            await Assert.ThrowsExactlyAsync<HttpRequestException>(()=>manager.WorkRequestAsync(payload.RootElement));Assert.AreEqual(1,bodies.Count);
            Assert.AreEqual("{\"stored\":true}",await manager.WorkRequestAsync(payload.RootElement));Assert.AreEqual(2,bodies.Count);Assert.AreEqual(bodies[0],bodies[1]);using var sent=JsonDocument.Parse(bodies[1]);Assert.AreEqual(id,sent.RootElement.GetProperty("command_id").GetString());
        }finally{vault.Clear();}
    }

    [TestMethod] public void BusinessFormPassesThroughTheRealNativeRoute(){
        var id=Guid.NewGuid().ToString();using var json=JsonDocument.Parse(JsonSerializer.Serialize(new{route="documents.complete",id,client_command_id=id,form=new{issuer=new{name="합성업체",business_number="000-00-00000"},note="가상시험"}}));
        var request=WindowsWorkRoutes.Decode(json.RootElement);using var body=JsonDocument.Parse(WindowsWorkRoutes.Body(request)!);
        Assert.AreEqual("000-00-00000",body.RootElement.GetProperty("form").GetProperty("issuer").GetProperty("business_number").GetString());
        Assert.AreEqual("가상시험",body.RootElement.GetProperty("form").GetProperty("note").GetString());
        Assert.AreEqual($"v1/document-drafts/{id}/complete",WindowsWorkRoutes.Path(request));
    }
    [TestMethod] public void JournalRoutesKeepDateAndProjectScope(){
        var id=Guid.NewGuid().ToString();using var json=JsonDocument.Parse(JsonSerializer.Serialize(new{route="journal.list",project_id=id,q="2026-10-05",cursor=id,category="agreement"}));var r=WindowsWorkRoutes.Decode(json.RootElement);StringAssert.StartsWith(WindowsWorkRoutes.Path(r),"v1/work/journal?");StringAssert.Contains(WindowsWorkRoutes.Path(r),"q=2026-10-05");Assert.IsNull(WindowsWorkRoutes.Body(r));
        using var bad=JsonDocument.Parse("{\"route\":\"journal.list\",\"project_id\":\"other\"}");Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
    }
    [TestMethod] public void FirstSiteSetupUsesOnlyFixedRoutesAndBoundedCommands(){
        foreach(var (route,path) in new[]{("setup.read","v1/work/setup"),("setup.command","v1/work/setup"),("setup.capture","v1/work/setup/capture")}){
            var read=route=="setup.read";
            using var json=JsonDocument.Parse(read?JsonSerializer.Serialize(new{route}):JsonSerializer.Serialize(new{route,command="{}"}));
            var request=WindowsWorkRoutes.Decode(json.RootElement);Assert.AreEqual(path,WindowsWorkRoutes.Path(request));Assert.AreEqual(read?null:"{}",WindowsWorkRoutes.Body(request));
        }
        using var bad=JsonDocument.Parse(JsonSerializer.Serialize(new{route="setup.capture",command=new string('x',16001)}));Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
    }
    [TestMethod] public void LedgerRoutesKeepProjectCategoryAndHistoryCursorBounded(){
        var id=Guid.NewGuid().ToString();
        foreach(var raw in new[]{JsonSerializer.Serialize(new{route="ledger.list",project_id=id,category="delivery_work",cursor="YWJj"}),JsonSerializer.Serialize(new{route="ledger.read",id,cursor=id}),"{\"route\":\"agenda.read\"}"}){using var json=JsonDocument.Parse(raw);var request=WindowsWorkRoutes.Decode(json.RootElement);StringAssert.StartsWith(WindowsWorkRoutes.Path(request),"v1/work/");Assert.IsNull(WindowsWorkRoutes.Body(request));}
        foreach(var raw in new[]{JsonSerializer.Serialize(new{route="ledger.list",cursor="a&tenant_id=other"}),JsonSerializer.Serialize(new{route="ledger.list",project_id="other"}),JsonSerializer.Serialize(new{route="ledger.list",category="paid"}),JsonSerializer.Serialize(new{route="ledger.read",id,cursor="../other"})}){using var bad=JsonDocument.Parse(raw);Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));}
    }
    [TestMethod] public void ContinuationOnlyAcceptsRunIdentity(){
        var id=Guid.NewGuid().ToString();using var input=JsonDocument.Parse(JsonSerializer.Serialize(new{route="agent.continue",id}));
        var r=WindowsWorkRoutes.Decode(input.RootElement);Assert.AreEqual($"v1/agent/runs/{id}/continue",WindowsWorkRoutes.Path(r));Assert.AreEqual("{}",WindowsWorkRoutes.Body(r));
        foreach(var raw in new[]{JsonSerializer.Serialize(new{route="agent.continue",id="../other"}),JsonSerializer.Serialize(new{route="agent.continue",id,command="{}"})}){using var bad=JsonDocument.Parse(raw);Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));}
    }
    [TestMethod] public void ImprovementRoutesRemainBounded(){
        using var list=JsonDocument.Parse("{\"route\":\"improvements.list\"}");Assert.AreEqual("v1/improvements",WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(list.RootElement)));
        using var command=JsonDocument.Parse("{\"route\":\"improvements.command\",\"command\":\"{}\"}");var r=WindowsWorkRoutes.Decode(command.RootElement);Assert.AreEqual("v1/improvements/commands",WindowsWorkRoutes.Path(r));Assert.AreEqual("{}",WindowsWorkRoutes.Body(r));
        using var bad=JsonDocument.Parse(JsonSerializer.Serialize(new{route="improvements.command",command=new string('x',4001)}));Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
    }
    [TestMethod] public void LearningRoutesKeepPurposeWritesAndIdentifiersBounded(){
        const string id="0f8fad5b-d9cb-469f-a165-70867728950e";
        foreach(var (raw,path,body) in new[]{(JsonSerializer.Serialize(new{route="learning.list",cursor=id}),$"v1/learning?cursor={id}",(string?)null),(JsonSerializer.Serialize(new{route="learning.read",id}),$"v1/learning/{id}",(string?)null),(JsonSerializer.Serialize(new{route="learning.command",command="{}"}),"v1/learning/commands","{}")}){
            using var json=JsonDocument.Parse(raw);var r=WindowsWorkRoutes.Decode(json.RootElement);Assert.AreEqual(path,WindowsWorkRoutes.Path(r));Assert.AreEqual(body,WindowsWorkRoutes.Body(r));
        }
        foreach(var raw in new[]{JsonSerializer.Serialize(new{route="learning.command",command=new string('x',4001)}),"{\"route\":\"learning.read\",\"id\":\"../other\"}","{\"route\":\"learning.list\",\"tenant_id\":\"other\"}"}){using var json=JsonDocument.Parse(raw);Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(json.RootElement));}
    }
    [TestMethod] public void RevisionFeedVersionAndSheetRetryHaveFixedRoutes(){
        using var input=JsonDocument.Parse("{\"route\":\"sync.changes\",\"sync_version\":2}");Assert.AreEqual("v1/sync/changes?sync_version=2",WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(input.RootElement)));
        using var invalid=JsonDocument.Parse("{\"route\":\"sync.changes\",\"sync_version\":3}");Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(invalid.RootElement));
        var id=Guid.NewGuid();using var sheet=JsonDocument.Parse(JsonSerializer.Serialize(new{route="sync.item",id,target_kind="photo_sheet"}));Assert.AreEqual($"v1/sync/changes?kind=photo_sheet&id={id}",WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(sheet.RootElement)));
    }
    [TestMethod]
    public void CaptureStatusAndPdfResumeUseFixedAuthenticatedRoutes(){
        var id=Guid.NewGuid().ToString();
        using var input=JsonDocument.Parse(JsonSerializer.Serialize(new{route="evidence.resume",id,command="{}"}));
        var r=WindowsWorkRoutes.Decode(input.RootElement);
        Assert.AreEqual($"v1/evidence/{id}/resume",WindowsWorkRoutes.Path(r));Assert.AreEqual("{}",WindowsWorkRoutes.Body(r));
        using var status=JsonDocument.Parse(JsonSerializer.Serialize(new{route="capture.status"}));
        Assert.AreEqual("v1/capture-status",WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(status.RootElement)));
        using var bad=JsonDocument.Parse(JsonSerializer.Serialize(new{route="evidence.resume",id,command=new string('x',1001)}));
        Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
    }
    [TestMethod]
    public void ActivityRoutesCannotChangeAuthorityAndRejectOversizedBatches(){
        using var consent=JsonDocument.Parse("{\"route\":\"activity.consent\",\"allowed\":true}");
        Assert.AreEqual("v1/work/activity/consent",WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(consent.RootElement)));
        using var append=JsonDocument.Parse(JsonSerializer.Serialize(new{route="activity.append",command="{}"}));
        Assert.AreEqual("{}",WindowsWorkRoutes.Body(WindowsWorkRoutes.Decode(append.RootElement)));
        using var bad=JsonDocument.Parse(JsonSerializer.Serialize(new{route="activity.append",command=new string('x',120001)}));
        Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
        using var forged=JsonDocument.Parse("{\"route\":\"activity.list\",\"tenant_id\":\"other\"}");
        Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(forged.RootElement));
    }
    [TestMethod]
    public void MaterialProjectScopeReachesTheServer(){
        const string id="0f8fad5b-d9cb-469f-a165-70867728950e";
        using var payload=JsonDocument.Parse(JsonSerializer.Serialize(new{route="materials.list",project_id=id,category="agreement"}));
        Assert.IsTrue(WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(payload.RootElement)).Contains("&project_id="+id));
        using var bad=JsonDocument.Parse("{\"route\":\"materials.list\",\"project_id\":\"invalid\"}");
        Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
    }
    [TestMethod]
    public void VoiceRoutesRemainTypedAndBounded(){
        using var valid=JsonDocument.Parse(JsonSerializer.Serialize(new {route="voice.transcribe",id=Guid.NewGuid().ToString(),mime="audio/webm",audio=new string('A',20000),consent_version="short-voice-v1"}));
        Assert.IsNotNull(WindowsWorkRoutes.Decode(valid.RootElement));
        using var invalid=JsonDocument.Parse("{\"route\":\"voice.consent\",\"allowed\":true,\"consent_version\":\"other\"}");
        Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(invalid.RootElement));
    }
    [TestMethod]
    public void DocumentIssueUsesBoundedSnapshotAndAtomicReplacement(){
        var id=Guid.NewGuid().ToString();var prior=Guid.NewGuid().ToString();
        using var input=JsonDocument.Parse(JsonSerializer.Serialize(new{route="documents.issue",id,client_command_id=id,basis_hash=new string('a',64),recipient_confirmation="합성 업체",amount_minor="550000",replacement_id=prior,expected_hash=new string('b',64)}));
        var r=WindowsWorkRoutes.Decode(input.RootElement);Assert.AreEqual($"v1/documents/{prior}/cancel",WindowsWorkRoutes.Path(r));
        using var body=JsonDocument.Parse(WindowsWorkRoutes.Body(r)!);Assert.AreEqual("550000",body.RootElement.GetProperty("replacement").GetProperty("drafts")[0].GetProperty("amount_minor").GetString());
        using var invalid=JsonDocument.Parse(input.RootElement.GetRawText().Replace("550000","-1"));Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(invalid.RootElement));
    }
    [TestMethod]
    public void PartialOrderQuantitiesRemainBoundedAndReachServer(){
        var id=Guid.NewGuid().ToString();const string quantities="[]";
        using var input=JsonDocument.Parse(JsonSerializer.Serialize(new{route="documents.complete",id,client_command_id=id,quantities}));
        using var body=JsonDocument.Parse(WindowsWorkRoutes.Body(WindowsWorkRoutes.Decode(input.RootElement))!);Assert.AreEqual(quantities,body.RootElement.GetProperty("quantities").GetString());
        using var bad=JsonDocument.Parse(JsonSerializer.Serialize(new{route="documents.complete",id,client_command_id=id,quantities=new string('x',16001)}));Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
    }
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(reply(request));
    }
    [TestMethod]
    [DataRow("{\"route\":\"materials.list\",\"url\":\"https://evil.example\"}")]
    [DataRow("{\"route\":\"materials.detail\",\"id\":\"../../auth\"}")]
    [DataRow("{\"route\":\"context\",\"tenant_id\":\"other\"}")]
    public void TypedRoutesRejectAmbientAuthority(string raw){using var payload=JsonDocument.Parse(raw);Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(payload.RootElement));}
    [TestMethod]
    public async Task ReadUsesNativeSessionAndDiscardsAccountChange(){
        var vault=new WindowsTokenVault(Path.Combine(Path.GetTempPath(),"sigongnote-work-"+Guid.NewGuid()));
        var session=new WindowsSession("https://api.example.test/","https://auth.example.test/","public","access","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
        vault.Save(JsonSerializer.Serialize(session));
        try{
            using var manager=new WindowsSessionManager(vault,new Handler(request=>{
                Assert.AreEqual("/v1/work/materials",request.RequestUri!.AbsolutePath);Assert.AreEqual("access",request.Headers.Authorization?.Parameter);
                Assert.AreEqual(session.TenantId.ToString(),request.Headers.GetValues("X-Tenant-ID").Single());vault.Clear();
                return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"materials\":[]}",Encoding.UTF8,"application/json")};
            }));
            using var input=JsonDocument.Parse("{\"route\":\"materials.list\"}");
            await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(()=>manager.WorkRequestAsync(input.RootElement));
        }finally{vault.Clear();}
    }
    [TestMethod]
    public void ConversationAndGuideUseBoundedTypedWrites(){
        const string id="0f8fad5b-d9cb-469f-a165-70867728950e";
        using var input=JsonDocument.Parse(JsonSerializer.Serialize(new{route="conversation.turn",id,client_turn_id=id,text="납품 찾아줘",input_kind="voice"}));
        var turn=WindowsWorkRoutes.Decode(input.RootElement);
        Assert.AreEqual($"v1/conversations/{id}/turns",WindowsWorkRoutes.Path(turn));
        using var body=JsonDocument.Parse(WindowsWorkRoutes.Body(turn)!);
        Assert.AreEqual("납품 찾아줘",body.RootElement.GetProperty("text").GetString());
        Assert.AreEqual("voice",body.RootElement.GetProperty("input_kind").GetString());
        Assert.IsFalse(body.RootElement.TryGetProperty("selected_project_id",out _));
        foreach(var raw in new[]{"{\"route\":\"guide.save\",\"step\":3,\"completed\":true}","{\"route\":\"materials.list\",\"category\":\"other\"}"}){
            using var bad=JsonDocument.Parse(raw);Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(bad.RootElement));
        }
    }
    [TestMethod]
    public void OwnerMemoryAndAnswersStayOnFixedNativeRoutes(){
        foreach(var pair in new[]{("journal.command","v1/work/journal/commands"),("agent.start","v1/agent/runs"),("audio.correct","v1/work/audio/corrections"),("work.reply","v1/work/replies"),("policies.command","v1/owner-policies/commands")}){
            using var json=JsonDocument.Parse(JsonSerializer.Serialize(new{route=pair.Item1,command="{}"}));var r=WindowsWorkRoutes.Decode(json.RootElement);Assert.AreEqual(pair.Item2,WindowsWorkRoutes.Path(r));Assert.AreEqual("{}",WindowsWorkRoutes.Body(r));
            using var oversized=JsonDocument.Parse(JsonSerializer.Serialize(new{route=pair.Item1,command=new string('x',16001)}));Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(oversized.RootElement));
            using var forged=JsonDocument.Parse(JsonSerializer.Serialize(new{route=pair.Item1,command="{}",tenant_id="other"}));Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(forged.RootElement));
        }
    }
}
