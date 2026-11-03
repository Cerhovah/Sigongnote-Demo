using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Sigongnote.Windows;

/// <summary>System-browser PKCE, loopback-only callback, no provider secret on the PC.</summary>
public sealed class WindowsGoogleLogin : IDisposable
{
    public const int CallbackPort=43827;
    public const string Callback="http://127.0.0.1:43827/oauth/callback";
    private readonly string verifier=Base64Url(RandomNumberGenerator.GetBytes(32));
    private readonly string state=Base64Url(RandomNumberGenerator.GetBytes(32));
    private readonly HttpClient http;
    private readonly WindowsConnectionOptions options;
    private readonly WindowsTokenVault pending;
    private readonly string provider;
    public WindowsGoogleLogin(WindowsConnectionOptions options, WindowsTokenVault pending, HttpMessageHandler? handler=null, string provider="google")
    {
        this.options=options.Validate();this.pending=pending;
        if(provider is not ("google" or "custom:naver" or "custom:kakao"))throw new ArgumentException("Unsupported login provider");
        if(!(provider switch {"google"=>options.GoogleEnabled,"custom:naver"=>options.NaverEnabled,"custom:kakao"=>options.KakaoEnabled,_=>false}))throw new InvalidOperationException("Login provider is not enabled");
        this.provider=provider;
        if(new Uri(options.SupabaseOrigin).Scheme!="https")throw new InvalidOperationException("Google login requires HTTPS");
        http=new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect=false,UseCookies=false }) { Timeout=TimeSpan.FromSeconds(20) };
    }
    public void Dispose()=>http.Dispose();
    private static string Base64Url(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
    public static string Challenge(string value)=>Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(value)));
    public Uri AuthorizationUrl()=>new(new Uri(options.SupabaseOrigin),
        "auth/v1/authorize?provider="+Uri.EscapeDataString(provider)+"&redirect_to="+Uri.EscapeDataString(Callback+"?state="+state)+
        "&code_challenge="+Challenge(verifier)+"&code_challenge_method=s256");

    internal async Task<Uri> IdentityAuthorizationAsync(WindowsSession session,CancellationToken cancellation)
    {
        if(session.ApiBaseUrl!=options.ApiBaseUrl || session.SupabaseOrigin!=options.SupabaseOrigin || session.ExpiresAtEpochMs<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())throw new WindowsLoginRequiredException();
        using var request=new HttpRequestMessage(HttpMethod.Get,new Uri(new Uri(options.SupabaseOrigin),"auth/v1/user/identities/authorize"+AuthorizationUrl().Query+"&skip_http_redirect=true"));
        request.Headers.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",session.AccessToken);request.Headers.TryAddWithoutValidation("apikey",options.PublishableKey);
        using var response=await http.SendAsync(request,cancellation);if(!response.IsSuccessStatusCode)throw new WindowsLoginRequiredException();
        using var body=JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
        var raw=body.RootElement.GetProperty("url").GetString();
        if(raw is null || raw.Length>8192 || !Uri.TryCreate(raw,UriKind.Absolute,out var url))throw new WindowsClientContractException();
        var host=provider switch {"custom:naver"=>"nid.naver.com","custom:kakao"=>"kauth.kakao.com",_=>"accounts.google.com"};
        if(url.Scheme!="https" || url.Host!=host || !url.IsDefaultPort || url.UserInfo.Length>0 || url.Fragment.Length>0)throw new WindowsClientContractException();
        return url;
    }

    public static string CallbackCode(Uri url,string expectedState)
    {
        var target=new Uri(Callback);
        if(url.Scheme!=target.Scheme || url.Host!=target.Host || url.Port!=target.Port ||
            url.AbsolutePath!=target.AbsolutePath || url.UserInfo.Length!=0 || url.Fragment.Length!=0)
            throw new WindowsLoginRequiredException();
        var values=new Dictionary<string,string>();
        foreach(var pair in url.Query.TrimStart('?').Split('&')) {
            var parts=pair.Split('=',2);
            if(parts.Length!=2 || !values.TryAdd(WebUtility.UrlDecode(parts[0]),WebUtility.UrlDecode(parts[1])))
                throw new WindowsLoginRequiredException();
        }
        if(values.GetValueOrDefault("state")!=expectedState || values.ContainsKey("error") ||
            !values.TryGetValue("code",out var code) || code.Length is <1 or >2048 ||
            code.Any(c=>char.IsControl(c)||char.IsWhiteSpace(c)))throw new WindowsLoginRequiredException();
        return code;
    }

    public async Task SignInAsync(Action<Uri> openBrowser,CancellationToken cancellation=default,WindowsSession? linkSession=null)
    {
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        // A TCP listener avoids URL ACL/admin changes and binds only loopback.
        var listener=new TcpListener(IPAddress.Loopback,CallbackPort);
        listener.Start(4);
        try {
            openBrowser(linkSession is null ? AuthorizationUrl() : await IdentityAuthorizationAsync(linkSession,timeout.Token));
            while(true) {
                using var connection=await listener.AcceptTcpClientAsync(timeout.Token);
                using var stream=connection.GetStream();
                using var requestLimit=CancellationTokenSource.CreateLinkedTokenSource(timeout.Token);
                requestLimit.CancelAfter(TimeSpan.FromSeconds(3));
                var bytes=new List<byte>();var one=new byte[1];
                try {
                    while(bytes.Count<8192) {
                        if(await stream.ReadAsync(one,requestLimit.Token)!=1)break;
                        bytes.Add(one[0]);
                        if(bytes.Count>=4 && bytes.TakeLast(4).SequenceEqual(new byte[]{13,10,13,10}))break;
                    }
                } catch(OperationCanceledException) when(!timeout.IsCancellationRequested) { continue; }
                  catch(IOException) { continue; }
                var header=Encoding.ASCII.GetString(bytes.ToArray());
                var first=header.Split("\r\n")[0].Split(' ');
                string? code=null;
                try {
                    if(!header.EndsWith("\r\n\r\n",StringComparison.Ordinal) || first.Length!=3 || first[0]!="GET" || !first[1].StartsWith("/oauth/callback?",StringComparison.Ordinal) ||
                        !header.Split("\r\n").Any(line=>line.Equals($"Host: 127.0.0.1:{CallbackPort}",StringComparison.OrdinalIgnoreCase)))
                        throw new WindowsLoginRequiredException();
                    code=CallbackCode(new Uri("http://127.0.0.1:"+CallbackPort+first[1]),state);
                } catch(Exception error) when(error is WindowsLoginRequiredException or UriFormatException) { /* Ignore unrelated loopback probes. */ }
                var content=Encoding.UTF8.GetBytes(code is null ? "Login request not accepted." : "시공노트로 돌아가 주세요. 로그인 결과는 앱에서 확인해 주세요.");
                var response=Encoding.ASCII.GetBytes($"HTTP/1.1 {(code is null ? "400 Bad Request" : "200 OK")}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: {content.Length}\r\n\r\n");
                try { await stream.WriteAsync(response,timeout.Token);await stream.WriteAsync(content,timeout.Token); }
                catch(IOException) { /* A disconnected browser must not lose a valid callback. */ }
                if(code is null)continue;
                await ExchangeAsync(code,timeout.Token,linkSession?.UserId);return;
            }
        } finally { listener.Stop(); }
    }

    internal async Task ExchangeAsync(string code,CancellationToken cancellation,Guid? expectedUser=null)
    {
        using var request=new HttpRequestMessage(HttpMethod.Post,new Uri(new Uri(options.SupabaseOrigin),"auth/v1/token?grant_type=pkce")) {
            Content=JsonContent.Create(new {auth_code=code,code_verifier=verifier}),
        };
        request.Headers.TryAddWithoutValidation("apikey",options.PublishableKey);
        using var response=await http.SendAsync(request,cancellation);
        if(!response.IsSuccessStatusCode)throw new WindowsLoginRequiredException();
        using var result=JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
        var body=result.RootElement;var seconds=body.GetProperty("expires_in").GetInt64();
        var user=Guid.Parse(body.GetProperty("user").GetProperty("id").GetString()!);
        var access=body.GetProperty("access_token").GetString()!;
        var refresh=body.GetProperty("refresh_token").GetString()!;
        if(seconds is <60 or >604800 || user==Guid.Empty || string.IsNullOrWhiteSpace(access) || string.IsNullOrWhiteSpace(refresh))
            throw new WindowsLoginRequiredException();
        if(expectedUser.HasValue && user!=expectedUser.Value)throw new WindowsLoginRequiredException();
        pending.Save(JsonSerializer.Serialize(new WindowsPendingAuth(access,refresh,
            DateTimeOffset.UtcNow.AddSeconds(seconds).ToUnixTimeMilliseconds(),user,options),new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }
}
