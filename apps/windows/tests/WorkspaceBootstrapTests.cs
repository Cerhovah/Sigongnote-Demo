using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class WorkspaceBootstrapTests
{
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(reply(request));
    }
    private static HttpResponseMessage Json(object body,HttpStatusCode status=HttpStatusCode.OK)=>new(status){Content=new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json")};
    [TestMethod]
    public async Task LostCreateResponseRestoresExistingCompanyWithoutSecondPost() {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-workspace-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            var options=new WindowsConnectionOptions("https://api.example.test/","https://auth.example.test/","public");
            var user=Guid.NewGuid();var tenant=Guid.NewGuid();
            var pending=new WindowsTokenVault(Path.Combine(root,"pending"));var drafts=new WindowsTokenVault(Path.Combine(root,"draft"));
            pending.Save(JsonSerializer.Serialize(new WindowsPendingAuth("fixture","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),user,options)));
            var created=false;var posts=0;
            HttpResponseMessage Reply(HttpRequestMessage request) {
                Assert.IsFalse(request.Headers.Contains("X-Tenant-Id"));
                Assert.AreEqual("fixture",request.Headers.Authorization?.Parameter);
                if(request.Method==HttpMethod.Post) {posts++;created=true;Assert.IsTrue(request.Headers.Contains("Idempotency-Key"));throw new HttpRequestException("synthetic lost response");}
                return Json(new {user_id=user,memberships=created ? new[]{new {tenant_id=tenant,tenant_name="합성 회사",role="owner"}} : []});
            }
            using(var client=new WindowsWorkspaceBootstrap(options,pending,drafts,new Handler(Reply)))await Assert.ThrowsExactlyAsync<HttpRequestException>(()=>client.CreateAsync("합성 회사"));
            using(var resumed=new WindowsWorkspaceBootstrap(options,pending,drafts,new Handler(Reply))) {
                Assert.AreEqual("합성 회사",resumed.SuggestedName());
                var companies=await resumed.CreateAsync("다른 이름");Assert.AreEqual(tenant.ToString("D"),companies.Single().tenant_id);
            }
            Assert.AreEqual(1,posts);
        } finally {Directory.Delete(root,true);}
    }
    [TestMethod]
    public async Task PreviousMembershipExplainsInvitationInsteadOfGenericNameError() {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-workspace-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            var options=new WindowsConnectionOptions("https://api.example.test/","https://auth.example.test/","public");var user=Guid.NewGuid();
            var pending=new WindowsTokenVault(Path.Combine(root,"pending"));pending.Save(JsonSerializer.Serialize(new WindowsPendingAuth("fixture","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),user,options)));
            using var client=new WindowsWorkspaceBootstrap(options,pending,new WindowsTokenVault(Path.Combine(root,"draft")),new Handler(request=>request.Method==HttpMethod.Get?Json(new {user_id=user,memberships=Array.Empty<object>()}):Json(new {},HttpStatusCode.Forbidden)));
            await Assert.ThrowsExactlyAsync<WindowsWorkspaceInvitationException>(()=>client.CreateAsync("회사"));
        } finally {Directory.Delete(root,true);}
    }
    [TestMethod]
    public async Task DamagedDraftRecoversExistingCompanyWithoutWrite() {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-workspace-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            var options=new WindowsConnectionOptions("https://api.example.test/","https://auth.example.test/","public");var user=Guid.NewGuid();var tenant=Guid.NewGuid();
            var pending=new WindowsTokenVault(Path.Combine(root,"pending"));var draftPath=Path.Combine(root,"draft");
            pending.Save(JsonSerializer.Serialize(new WindowsPendingAuth("fixture","refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),user,options)));
            File.WriteAllText(draftPath,"broken protected bytes");
            using var client=new WindowsWorkspaceBootstrap(options,pending,new WindowsTokenVault(draftPath),new Handler(request=> {
                Assert.AreEqual(HttpMethod.Get,request.Method);return Json(new {user_id=user,memberships=new[]{new {tenant_id=tenant,tenant_name="fixture",role="owner"}}});
            }));
            Assert.AreEqual("우리 회사",client.SuggestedName());Assert.IsFalse(client.HasDraft());
            Assert.AreEqual(tenant.ToString("D"),(await client.CreateAsync("회사")).Single().tenant_id);
        } finally {Directory.Delete(root,true);}
    }

}
