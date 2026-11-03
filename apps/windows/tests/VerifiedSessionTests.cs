using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class VerifiedSessionTests
{
    [TestMethod]
    public async Task UploadConsentDestinationUsesVerifiedCompanyAndRejectsChangedPrincipalOrOrigin()
    {
        var sandbox=Path.Combine(Path.GetTempPath(),"sigongnote-destination-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var session=new WindowsSession("https://api.example.test/","https://auth.example.test/",
                "publishable","fixture-access","fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var vault=new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var sameUser=true;
            using var manager=new WindowsSessionManager(vault,new StubHandler(request=> {
                Assert.AreEqual(HttpMethod.Get,request.Method);
                Assert.AreEqual("/v1/me",request.RequestUri!.AbsolutePath);
                return JsonResponse(JsonSerializer.Serialize(new {
                    user_id=sameUser ? session.UserId : Guid.NewGuid(),
                    memberships=new[]{new { tenant_id=session.TenantId,tenant_name="Fixture Company",role="owner" }},
                }));
            }));
            var recipient=await manager.UploadDestinationAsync();
            Assert.AreEqual("Fixture Company",recipient.Company);
            Assert.AreEqual("https://api.example.test",recipient.Origin);
            Assert.IsTrue(recipient.Matches(session));
            Assert.IsFalse(recipient.Matches(session with { TenantId=Guid.NewGuid() }));
            Assert.IsFalse(recipient.Matches(session with { UserId=Guid.NewGuid() }));
            Assert.IsFalse(recipient.Matches(session with { ApiBaseUrl="https://other.example.test/" }));
            sameUser=false;
            await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(()=>manager.UploadDestinationAsync());
        } finally { Directory.Delete(sandbox,true); }
    }

    private sealed class StubHandler(Func<HttpRequestMessage,HttpResponseMessage> reply)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(reply(request));
    }

    private static HttpResponseMessage JsonResponse(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json,Encoding.UTF8,"application/json") };

    [TestMethod, TestCategory("C16")]
    public async Task FolderConsentCreatesPseudonymousSourceThenVerifiesBinding()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-consent-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"private-work");
            Directory.CreateDirectory(root);
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var folder = state.SelectFolder(root,historyDays:30);
            var session = new WindowsSession("https://api.example.test/",
                "https://auth.example.test/","publishable","fixture-access",
                "fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var keys = new WindowsDeviceKeyStore(Path.Combine(sandbox,"device-keys"));
            var key = keys.GetOrCreate(session.TenantId,session.UserId);
            keys.MarkRegistered(session.TenantId,session.UserId,session.DeviceId,
                key.RegistrationKey);
            var serverId = Guid.NewGuid();
            var posts = 0;
            using var manager = new WindowsSessionManager(vault,new StubHandler(request => {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/v1/me") return JsonResponse(JsonSerializer.Serialize(new {
                    user_id = session.UserId,memberships = new[] {
                        new { tenant_id = session.TenantId,tenant_name = "Fixture",
                            role = "owner" },
                    },
                }));
                Assert.AreEqual(session.TenantId.ToString("D"),
                    request.Headers.GetValues("X-Tenant-Id").Single());
                if (request.Method == HttpMethod.Post) {
                    posts++;
                    Assert.AreNotEqual(Guid.Empty,Guid.Parse(
                        request.Headers.GetValues("Idempotency-Key").Single()));
                    var body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                    Assert.IsFalse(body.Contains(root,StringComparison.OrdinalIgnoreCase));
                    using var payload = JsonDocument.Parse(body);
                    Assert.AreEqual("folder",payload.RootElement.GetProperty("kind").GetString());
                    Assert.IsTrue(payload.RootElement.GetProperty("server_upload_consent")
                        .GetBoolean());
                    Assert.IsFalse(payload.RootElement.GetProperty("external_ai_consent")
                        .GetBoolean());
                    Assert.AreEqual(64,payload.RootElement.GetProperty("scope_fingerprint")
                        .GetString()!.Length);
                    return JsonResponse(JsonSerializer.Serialize(new { id = serverId }),
                        HttpStatusCode.Created);
                }
                return JsonResponse(JsonSerializer.Serialize(new { sources = new[] {
                    new { id = serverId,tenant_id = session.TenantId,
                        device_id = session.DeviceId,kind = "folder",upload_ready = true,
                        server_upload_consent = true,active = true,device_active = true,
                        generation = 1 },
                } }));
            }));
            await Assert.ThrowsExactlyAsync<InvalidOperationException>(() =>
                manager.CreateAndBindFolderAsync(state,keys,folder.Id,false));
            Assert.AreEqual(0,posts);
            var bound = await manager.CreateAndBindFolderAsync(state,keys,folder.Id,true);
            Assert.AreEqual(serverId,bound.ServerSourceId);
            Assert.AreEqual(1,posts);
            await manager.CreateAndBindFolderAsync(state,keys,folder.Id,true);
            Assert.AreEqual(1,posts);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task SourcePermissionAndConflictAreNotShownAsNetworkRetries()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-source-error-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var folder = state.SelectFolder(root,historyDays:30);
            var session = new WindowsSession("https://api.example.test/",
                "https://auth.example.test/","publishable","fixture-access",
                "fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var keys = new WindowsDeviceKeyStore(Path.Combine(sandbox,"device-keys"));
            var key = keys.GetOrCreate(session.TenantId,session.UserId);
            keys.MarkRegistered(session.TenantId,session.UserId,session.DeviceId,
                key.RegistrationKey);
            using (var denied = new WindowsSessionManager(vault,new StubHandler(request => {
                Assert.AreEqual(HttpMethod.Post,request.Method);
                Assert.AreEqual("/v1/capture-sources",request.RequestUri!.AbsolutePath);
                return new HttpResponseMessage(HttpStatusCode.Forbidden);
            }))) {
                await Assert.ThrowsExactlyAsync<WindowsSourcePermissionException>(() =>
                    denied.CreateAndBindFolderAsync(state,keys,folder.Id,true));
            }
            using (var conflict = new WindowsSessionManager(vault,new StubHandler(request => {
                Assert.AreEqual(HttpMethod.Post,request.Method);
                Assert.AreEqual("/v1/capture-sources",request.RequestUri!.AbsolutePath);
                return new HttpResponseMessage(HttpStatusCode.Conflict);
            }))) {
                await Assert.ThrowsExactlyAsync<WindowsSourceConflictException>(() =>
                    conflict.CreateAndBindFolderAsync(state,keys,folder.Id,true));
            }
            Assert.IsNull(state.Folders().Single().ServerSourceId);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task BackfillVerificationReportsRevokedSourceAsPermanentFailure()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-revoked-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var folder = state.SelectFolder(root,historyDays:30);
            var session = new WindowsSession("https://api.example.test/",
                "https://auth.example.test/","publishable","fixture-access",
                "fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var serverId = Guid.NewGuid();
            using var manager = new WindowsSessionManager(vault,new StubHandler(request => {
                if (request.RequestUri!.AbsolutePath == "/v1/me")
                    return JsonResponse(JsonSerializer.Serialize(new {
                        user_id = session.UserId,memberships = new[] {
                            new { tenant_id = session.TenantId,tenant_name = "Fixture",
                                role = "owner" },
                        },
                    }));
                Assert.AreEqual("/v1/capture-sources",request.RequestUri.AbsolutePath);
                return JsonResponse(JsonSerializer.Serialize(new { sources = new[] {
                    new { id = serverId,tenant_id = session.TenantId,
                        device_id = session.DeviceId,kind = "folder",upload_ready = false,
                        server_upload_consent = false,active = false,device_active = true,
                        generation = 2 },
                } }));
            }));
            await Assert.ThrowsExactlyAsync<WindowsSourceInactiveException>(() =>
                manager.BindVerifiedFolderAsync(state,folder.Id,serverId));
            Assert.IsNull(state.Folders().Single().ServerSourceId);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task ExpiringSessionRefreshesThenBindsOnlyVerifiedFolder()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-session-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(folder);
            var file = Path.Combine(folder,"synthetic.pdf");
            File.WriteAllText(file,"synthetic");
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(folder);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(source.Id,folder,file);
            stabilizer.Observe(source.Id,folder,file);
            var session = new WindowsSession("http://127.0.0.1:3001/",
                "http://127.0.0.1:54321/","fixture-publishable","old-access",
                "old-refresh",DateTimeOffset.UtcNow.AddSeconds(10).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var serverSourceId = Guid.NewGuid();
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var requests = new List<string>();
            using var manager = new WindowsSessionManager(vault,new StubHandler(request => {
                requests.Add(request.RequestUri!.AbsolutePath);
                if (request.RequestUri!.AbsolutePath == "/auth/v1/token") {
                    Assert.AreEqual(HttpMethod.Post,request.Method);
                    Assert.AreEqual("fixture-publishable",
                        request.Headers.GetValues("apikey").Single());
                    return JsonResponse(JsonSerializer.Serialize(new {
                        access_token = "new-access",refresh_token = "new-refresh",
                        expires_in = 3600,user = new { id = session.UserId },
                    }));
                }
                Assert.AreEqual("new-access",request.Headers.Authorization?.Parameter);
                if (request.RequestUri.AbsolutePath == "/v1/me")
                    return JsonResponse(JsonSerializer.Serialize(new {
                        user_id = session.UserId,memberships = new[] {
                            new { tenant_id = session.TenantId,tenant_name = "Fixture",
                                role = "owner" },
                        },
                    }));
                Assert.AreEqual(session.TenantId.ToString("D"),
                    request.Headers.GetValues("X-Tenant-Id").Single());
                return JsonResponse(JsonSerializer.Serialize(new { sources = new[] {
                    new { id = serverSourceId,tenant_id = session.TenantId,
                        device_id = session.DeviceId,kind = "folder",upload_ready = true,
                        server_upload_consent = true,active = true,device_active = true,
                        generation = 1 },
                } }));
            }));
            var bound = await manager.BindVerifiedFolderAsync(state,source.Id,serverSourceId);
            Assert.AreEqual(serverSourceId,bound.ServerSourceId);
            CollectionAssert.AreEqual(new[] {"/auth/v1/token","/v1/me",
                "/v1/capture-sources"},requests);
            Assert.AreEqual(1,state.BackfillApprovalCount());
            var snapshot = state.BackfillSnapshot(source.Id);
            Assert.AreEqual(1,snapshot.Count);
            Assert.AreEqual(1,state.ApproveExistingBackfill(source.Id,session.Principal,snapshot));
            Assert.AreEqual(0,state.BackfillApprovalCount());
            Assert.AreEqual(0,state.BackfillSnapshot(source.Id).Count);
            Assert.IsFalse(vault.Read()!.Contains("old-refresh",StringComparison.Ordinal));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task WrongDeviceAndRedirectCannotBindOrForwardBearer()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-session-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(folder);
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(folder);
            var session = new WindowsSession("https://api.example.test/",
                "https://auth.example.test/","publishable","fixture-access",
                "fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var serverSourceId = Guid.NewGuid();
            var wrongDeviceHandler = new StubHandler(request => {
                if (request.RequestUri!.AbsolutePath == "/v1/me")
                    return JsonResponse(JsonSerializer.Serialize(new {
                        user_id = session.UserId,memberships = new[] {
                            new { tenant_id = session.TenantId,tenant_name = "Fixture",
                                role = "owner" },
                        },
                    }));
                return JsonResponse(JsonSerializer.Serialize(new { sources = new[] {
                    new { id = serverSourceId,tenant_id = session.TenantId,
                        device_id = Guid.NewGuid(),kind = "folder",upload_ready = true,
                        server_upload_consent = true,active = true,device_active = true,
                        generation = 1 },
                } }));
            });
            using (var manager = new WindowsSessionManager(vault,wrongDeviceHandler)) {
                await Assert.ThrowsExactlyAsync<InvalidOperationException>(() =>
                    manager.BindVerifiedFolderAsync(state,source.Id,serverSourceId));
            }
            Assert.IsNull(state.Folders().Single().ServerSourceId);
            var calls = 0;
            using var redirected = new WindowsSessionManager(vault,new StubHandler(_ => {
                calls++;
                return new HttpResponseMessage(HttpStatusCode.Found) {
                    Headers = { Location = new Uri("https://foreign.example.test/") },
                };
            }));
            await Assert.ThrowsExactlyAsync<WindowsSessionUnavailableException>(() =>
                redirected.BindVerifiedFolderAsync(state,source.Id,serverSourceId));
            Assert.AreEqual(1,calls);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task LostRefreshResponseRetriesWithoutClearingSession()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-session-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var session = new WindowsSession("https://api.example.test/",
                "https://auth.example.test/","publishable","old-access",
                "old-refresh",DateTimeOffset.UtcNow.AddSeconds(1).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var attempts = 0;
            using var manager = new WindowsSessionManager(vault,new StubHandler(_ => {
                if (++attempts == 1) throw new HttpRequestException("synthetic disconnect");
                return JsonResponse(JsonSerializer.Serialize(new {
                    access_token = "new-access",refresh_token = "new-refresh",
                    expires_in = 3600,user = new { id = session.UserId },
                }));
            }));
            Assert.AreEqual("new-access",(await manager.CurrentAsync()).AccessToken);
            Assert.AreEqual(2,attempts);
            Assert.IsNotNull(vault.Read());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task EarlyApi401RefreshesOnceThenContinuesBinding()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-session-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(folder);
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var local = state.SelectFolder(folder);
            var session = new WindowsSession("https://api.example.test/",
                "https://auth.example.test/","publishable","old-access",
                "old-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var serverSourceId = Guid.NewGuid();
            var meCalls = 0;
            var refreshCalls = 0;
            using var manager = new WindowsSessionManager(vault,new StubHandler(request => {
                if (request.RequestUri!.AbsolutePath == "/auth/v1/token") {
                    refreshCalls++;
                    return JsonResponse(JsonSerializer.Serialize(new {
                        access_token = "new-access",refresh_token = "new-refresh",
                        expires_in = 3600,user = new { id = session.UserId },
                    }));
                }
                if (request.RequestUri.AbsolutePath == "/v1/me") {
                    if (++meCalls == 1) return new HttpResponseMessage(HttpStatusCode.Unauthorized);
                    Assert.AreEqual("new-access",request.Headers.Authorization?.Parameter);
                    return JsonResponse(JsonSerializer.Serialize(new {
                        user_id = session.UserId,memberships = new[] {
                            new { tenant_id = session.TenantId,tenant_name = "Fixture",
                                role = "owner" },
                        },
                    }));
                }
                Assert.AreEqual("new-access",request.Headers.Authorization?.Parameter);
                return JsonResponse(JsonSerializer.Serialize(new { sources = new[] {
                    new { id = serverSourceId,tenant_id = session.TenantId,
                        device_id = session.DeviceId,kind = "folder",upload_ready = true,
                        server_upload_consent = true,active = true,device_active = true,
                        generation = 1 },
                } }));
            }));
            var bound = await manager.BindVerifiedFolderAsync(state,local.Id,serverSourceId);
            Assert.AreEqual(serverSourceId,bound.ServerSourceId);
            Assert.AreEqual(2,meCalls);
            Assert.AreEqual(1,refreshCalls);
        } finally { Directory.Delete(sandbox,true); }
    }
}
