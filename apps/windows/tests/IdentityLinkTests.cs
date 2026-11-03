using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class IdentityLinkTests
{
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(reply(request));
    }
    private static HttpResponseMessage Reply(object body,HttpStatusCode status=HttpStatusCode.OK)=>new(status){Content=new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json")};
    private static readonly WindowsConnectionOptions Options=new("https://api.example.test/","https://auth.example.test/","public",true,true,true);
    private static WindowsSession Session()=>new(Options.ApiBaseUrl,Options.SupabaseOrigin,"public","old-access","old-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
    [TestMethod]
    [DataRow("custom:naver","https://nid.naver.com/oauth2.0/authorize?fixture=1")]
    [DataRow("custom:kakao","https://kauth.kakao.com/oauth/authorize?fixture=1")]
    public async Task ExistingBearerStartsExplicitProviderLink(string provider,string url) {
        var path=Path.Combine(Path.GetTempPath(),"sigongnote-link-"+Guid.NewGuid());
        var session=Session();using var login=new WindowsGoogleLogin(Options,new WindowsTokenVault(path),new Handler(request=> {
            Assert.AreEqual("/auth/v1/user/identities/authorize",request.RequestUri!.AbsolutePath);
            Assert.AreEqual("old-access",request.Headers.Authorization?.Parameter);
            StringAssert.Contains(request.RequestUri.Query,"code_challenge_method=s256");StringAssert.Contains(request.RequestUri.Query,"skip_http_redirect=true");
            return Reply(new {url});
        }),provider);
        Assert.AreEqual(url,(await login.IdentityAuthorizationAsync(session,default)).AbsoluteUri);
    }
    [TestMethod]
    public async Task WrongProviderHostAndDifferentUserAreRejectedBeforePendingSave() {
        var path=Path.Combine(Path.GetTempPath(),"sigongnote-link-"+Guid.NewGuid());var pending=new WindowsTokenVault(path);
        using var login=new WindowsGoogleLogin(Options,pending,new Handler(request=>request.Method==HttpMethod.Get?Reply(new {url="https://nid.naver.com.evil.test/authorize"}):Reply(new {access_token="new",refresh_token="refresh",expires_in=3600,user=new {id=Guid.NewGuid()}})),"custom:naver");
        await Assert.ThrowsExactlyAsync<WindowsClientContractException>(()=>login.IdentityAuthorizationAsync(Session(),default));
        await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(()=>login.ExchangeAsync("code",default,Guid.NewGuid()));Assert.IsNull(pending.Read());
    }
    [TestMethod]
    [DataRow(200,false)]
    [DataRow(401,false)]
    [DataRow(200,true)]
    public async Task ReplacementChecksItsOwnTokenAndCannotRestoreLogout(int status,bool logout) {
        var path=Path.Combine(Path.GetTempPath(),"sigongnote-link-"+Guid.NewGuid());var vault=new WindowsTokenVault(path);var before=Session();var raw=JsonSerializer.Serialize(before);vault.Save(raw);var calls=0;
        try {
            using var manager=new WindowsSessionManager(vault,new Handler(request=> {
                calls++;Assert.AreEqual("/v1/me",request.RequestUri!.AbsolutePath);Assert.AreEqual("new-access",request.Headers.Authorization?.Parameter);
                if(logout)vault.Clear();
                return Reply(new {user_id=before.UserId,memberships=new[]{new {tenant_id=before.TenantId,tenant_name="fixture",role="owner"}}},(HttpStatusCode)status);
            }));
            var replacement=new WindowsPendingAuth("new-access","new-refresh",before.ExpiresAtEpochMs,before.UserId,Options);
            if(status==200 && !logout) {
                await manager.ApplyLinkedLoginAsync(before,replacement);
                var actual=await manager.CurrentAsync();Assert.AreEqual(before.Principal,actual.Principal);Assert.AreEqual("new-access",actual.AccessToken);
            } else {
                await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(()=>manager.ApplyLinkedLoginAsync(before,replacement));
                Assert.AreEqual(logout?null:raw,vault.Read());
            }
            Assert.AreEqual(1,calls);
        } finally {vault.Clear();}
    }
}
