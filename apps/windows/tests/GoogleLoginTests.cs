using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class GoogleLoginTests
{
    [TestMethod]
    [DataRow("google")]
    [DataRow("custom:naver")]
    [DataRow("custom:kakao")]
    public void AllProvidersKeepNativePkceAndFixedCallback(string provider)
    {
        var sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-provider-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(sandbox);
        try {
            using var login=new WindowsGoogleLogin(new("https://api.example.test/","https://auth.example.test/","publishable",true,true,true),new WindowsTokenVault(Path.Combine(sandbox,"pending")),provider:provider);
            var url=login.AuthorizationUrl();StringAssert.Contains(url.Query,"provider="+Uri.EscapeDataString(provider));
            StringAssert.Contains(url.Query,"code_challenge_method=s256");StringAssert.Contains(Uri.UnescapeDataString(url.Query),WindowsGoogleLogin.Callback);
            Assert.IsFalse(url.AbsoluteUri.Contains("client_secret"));
        } finally {Directory.Delete(sandbox,true);}
    }

    [TestMethod, TestCategory("GoogleLogin")]
    public void ClientSettingsRejectBothSecretKeyFormats()
    {
        string Key(string role)=>"eyJhbGciOiJIUzI1NiJ9."+Convert.ToBase64String(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {role}))).TrimEnd('=').Replace('+','-').Replace('/','_')+".fixture";
        foreach(var key in new[]{"sb_secret_fixture",Key("service_role"),Key("authenticated"),"eyBroken"})
            Assert.ThrowsExactly<InvalidOperationException>(()=>new WindowsConnectionOptions(
                "https://api.example.test","https://auth.example.test",key,true).Validate());
        new WindowsConnectionOptions("https://api.example.test","https://auth.example.test",Key("anon"),true).Validate();
    }

    [TestMethod, TestCategory("GoogleLogin")]
    public void PkceMatchesRfc7636AndCallbackRejectsInjection()
    {
        Assert.AreEqual("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            WindowsGoogleLogin.Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        Assert.AreEqual("good",WindowsGoogleLogin.CallbackCode(new Uri(WindowsGoogleLogin.Callback+"?state=s&code=good"),"s"));
        foreach(var url in new[] {
            WindowsGoogleLogin.Callback+"?state=other&code=good",
            WindowsGoogleLogin.Callback+"?state=s&code=good&code=second",
            WindowsGoogleLogin.Callback+"?state=s&code=good#secret",
            WindowsGoogleLogin.Callback+"?state=s&error=denied",
            "http://localhost:43827/oauth/callback?state=s&code=good",
            "http://127.0.0.1:43828/oauth/callback?state=s&code=good",
        }) Assert.ThrowsExactly<WindowsLoginRequiredException>(()=>WindowsGoogleLogin.CallbackCode(new Uri(url),"s"));
    }

    private sealed class ExchangeHandler : HttpMessageHandler
    {
        public string? Challenge { get; set; }
        public int Calls { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation)
        {
            Calls++;
            Assert.AreEqual("https://auth.example.test/auth/v1/token?grant_type=pkce",request.RequestUri!.AbsoluteUri);
            Assert.AreEqual("publishable",request.Headers.GetValues("apikey").Single());
            using var body=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellation));
            Assert.AreEqual("one-time-code",body.RootElement.GetProperty("auth_code").GetString());
            Assert.AreEqual(Challenge,WindowsGoogleLogin.Challenge(body.RootElement.GetProperty("code_verifier").GetString()!));
            return new(HttpStatusCode.OK) { Content=new StringContent(JsonSerializer.Serialize(new {
                access_token="fixture-access",refresh_token="fixture-refresh",expires_in=3600,user=new { id=Guid.NewGuid() },
            }),Encoding.UTF8,"application/json") };
        }
    }

    [TestMethod, TestCategory("GoogleLogin")]
    public async Task RealLoopbackExchangesOnceAndProtectsTokens()
    {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-google-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var path=Path.Combine(root,"pending.protected");var vault=new WindowsTokenVault(path);
            var handler=new ExchangeHandler();
            using var login=new WindowsGoogleLogin(new("https://api.example.test/","https://auth.example.test/","publishable",true),vault,handler);
            using var browser=new HttpClient();
            Task<HttpResponseMessage>? response=null;
            await login.SignInAsync(url=>{
                var query=url.Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).ToDictionary(p=>p[0],p=>Uri.UnescapeDataString(p[1]));
                Assert.AreEqual("google",query["provider"]);Assert.AreEqual("s256",query["code_challenge_method"]);
                handler.Challenge=query["code_challenge"];
                response=browser.GetAsync(query["redirect_to"]+"&code=one-time-code");
            });
            using var callback=await response!;
            Assert.AreEqual(HttpStatusCode.OK,callback.StatusCode);Assert.AreEqual(1,handler.Calls);
            Assert.IsTrue(vault.Read()!.Contains("fixture-access",StringComparison.Ordinal));
            Assert.IsFalse(Encoding.UTF8.GetString(File.ReadAllBytes(path)).Contains("fixture-access",StringComparison.Ordinal));
        } finally { Directory.Delete(root,true); }
    }

    [TestMethod, TestCategory("GoogleLogin")]
    public async Task CancelClosesListenerWithoutCredentials()
    {
        var path=Path.Combine(Path.GetTempPath(),"sigongnote-cancel-"+Guid.NewGuid().ToString("N"));
        var vault=new WindowsTokenVault(path);
        using var login=new WindowsGoogleLogin(new("https://api.example.test/","https://auth.example.test/","publishable",true),vault);
        using var cancellation=new CancellationTokenSource();
        await Assert.ThrowsAsync<OperationCanceledException>(()=>login.SignInAsync(_=>cancellation.Cancel(),cancellation.Token));
        Assert.IsNull(vault.Read());
        Assert.ThrowsExactly<InvalidOperationException>(()=>new WindowsConnectionOptions("https://api.example.test/","http://127.0.0.1:54321/","public",true).Validate());
    }
}
