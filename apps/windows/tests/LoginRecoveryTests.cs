using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class LoginRecoveryTests
{
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> reply):HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
            =>Task.FromResult(reply(request));
    }
    private static HttpResponseMessage Json(object value)=>new(HttpStatusCode.OK) {
        Content=new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,"application/json"),
    };
    private static readonly JsonSerializerOptions Wire=new(JsonSerializerDefaults.Web);

    [TestMethod]
    public async Task FreshPcRegistersAfterProviderRefreshAndKeepsDeviceOnRetry()
    {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-login-recovery-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var original=new WindowsConnectionOptions("https://api.example.test/","https://auth.example.test/","public",true);
            var refreshed=original with {GoogleEnabled=false,NaverEnabled=true};
            var user=Guid.NewGuid();var tenant=Guid.NewGuid();var device=Guid.NewGuid();
            var pending=new WindowsTokenVault(Path.Combine(root,"pending"));
            var session=new WindowsTokenVault(Path.Combine(root,"session"));
            var keys=new WindowsDeviceKeyStore(Path.Combine(root,"new-device-keys"));
            var posts=0;
            using var client=new WindowsAuthOnboarding(original,pending,session,keys,new Handler(request=> {
                Assert.AreEqual("fixture-access",request.Headers.Authorization?.Parameter);
                if(request.RequestUri!.AbsolutePath=="/v1/me")return Json(new {user_id=user,memberships=new[]{new {tenant_id=tenant,tenant_name="Fixture",role="owner"}}});
                if(request.Method==HttpMethod.Post)posts++;
                else if(posts==0)return new(HttpStatusCode.NotFound);
                return Json(new {id=device,tenant_id=tenant,platform="windows",active=true,version=1,revoked_at=(string?)null});
            }));
            void Authenticate()=>pending.Save(JsonSerializer.Serialize(new WindowsPendingAuth("fixture-access","fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),user,refreshed),Wire));
            Authenticate();
            Assert.HasCount(1,await client.AvailableTenantsAsync());
            using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var enrolled=await client.CompleteEnrollmentAsync(tenant,deadline.Token);
            var key=keys.GetOrCreate(tenant,user);
            Assert.AreEqual(device,enrolled.DeviceId);Assert.IsNotNull(session.Read());Assert.IsNull(pending.Read());
            Authenticate();
            Assert.AreEqual(device,(await client.CompleteEnrollmentAsync(tenant,deadline.Token)).DeviceId);
            Assert.AreEqual(key,keys.GetOrCreate(tenant,user));Assert.AreEqual(1,posts);
        } finally {Directory.Delete(root,true);}
    }

    [TestMethod]
    public async Task NewDeviceDirectoryExistsBeforeEnrollmentLock()
    {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-key-init-"+Guid.NewGuid().ToString("N"));
        try {
            var keys=new WindowsDeviceKeyStore(root);
            using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var first=await keys.AcquireEnrollmentAsync(Guid.NewGuid(),Guid.NewGuid(),deadline.Token);
            Assert.IsTrue(Directory.Exists(root));
        } finally {if(Directory.Exists(root))Directory.Delete(root,true);}
    }

    [TestMethod]
    public async Task ProviderRefreshAllowsNewCompanyButServiceChangesNeverSendCredentials()
    {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-login-boundary-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var original=new WindowsConnectionOptions("https://api.example.test/","https://auth.example.test/","public");
            var user=Guid.NewGuid();var tenant=Guid.NewGuid();
            var pending=new WindowsTokenVault(Path.Combine(root,"pending"));
            var session=new WindowsTokenVault(Path.Combine(root,"session"));
            var draft=new WindowsTokenVault(Path.Combine(root,"draft"));
            var keys=new WindowsDeviceKeyStore(Path.Combine(root,"keys"));
            var calls=0;var created=false;
            HttpResponseMessage Reply(HttpRequestMessage request) {
                calls++;
                if(request.Method==HttpMethod.Post){created=true;return new(HttpStatusCode.Created);}
                return Json(new {user_id=user,memberships=created?new[]{new {tenant_id=tenant,tenant_name="Fixture",role="owner"}}:[]});
            }
            void Authenticate(WindowsConnectionOptions value)=>pending.Save(JsonSerializer.Serialize(new WindowsPendingAuth("fixture-access","fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),user,value),Wire));
            using var onboarding=new WindowsAuthOnboarding(original,pending,session,keys,new Handler(Reply));
            using var bootstrap=new WindowsWorkspaceBootstrap(original,pending,draft,new Handler(Reply));
            Authenticate(original with {NaverEnabled=true});
            Assert.AreEqual("우리 회사",bootstrap.SuggestedName());
            Assert.HasCount(1,await bootstrap.CreateAsync("Fixture"));
            foreach(var changed in new[]{original with {ApiBaseUrl="https://other.example.test/"},original with {SupabaseOrigin="https://other.example.test/"},original with {PublishableKey="other-public"}}) {
                Authenticate(changed);var before=calls;
                await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(()=>onboarding.AvailableTenantsAsync());
                await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(()=>bootstrap.CreateAsync("Fixture"));
                Assert.AreEqual(before,calls);Assert.IsNull(session.Read());
            }
        } finally {Directory.Delete(root,true);}
    }
}
