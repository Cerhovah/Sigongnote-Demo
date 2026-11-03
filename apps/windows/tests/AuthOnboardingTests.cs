using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class AuthOnboardingTests
{
    private sealed class StubHandler(Func<HttpRequestMessage,HttpResponseMessage> reply)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(reply(request));
    }

    private static HttpResponseMessage JsonResponse(object value,
        HttpStatusCode code = HttpStatusCode.OK) => new(code) {
            Content = new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,
                "application/json"),
        };

    [TestMethod, TestCategory("C16")]
    public async Task OtpAndMembershipRegisterDeviceWithRecoverableIdempotency()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var device = Guid.NewGuid();
            var options = new WindowsConnectionOptions("http://127.0.0.1:3001/",
                "http://127.0.0.1:54321/","fixture-publishable");
            var pending = new WindowsTokenVault(Path.Combine(sandbox,"pending.protected"));
            var session = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            var keys = new WindowsDeviceKeyStore(Path.Combine(sandbox,"keys"));
            var registrationCalls = 0;
            string? priorKey = null;
            string? priorJwk = null;
            using var onboarding = new WindowsAuthOnboarding(options,pending,session,keys,
                new StubHandler(request => {
                    if (request.RequestUri!.AbsolutePath.StartsWith("/auth/"))
                        Assert.AreEqual("fixture-publishable",
                            request.Headers.GetValues("apikey").Single());
                    return request.RequestUri.AbsolutePath switch {
                        "/auth/v1/otp" => VerifyOtpRequest(request),
                        "/auth/v1/verify" => JsonResponse(new {
                            access_token = "fixture-access",refresh_token = "fixture-refresh",
                            expires_in = 3600,user = new { id = user },
                        }),
                        "/v1/me" => JsonResponse(new { user_id = user,memberships = new[] {
                            new { tenant_id = tenant,tenant_name = "Fixture",role = "owner" },
                        } }),
                        var path when path.StartsWith("/v1/devices/by-key/",
                            StringComparison.Ordinal) => registrationCalls == 0
                                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                                : JsonResponse(new { id = device,tenant_id = tenant,
                                    platform = "windows",active = true,version = 1,
                                    revoked_at = (string?)null }),
                        "/v1/devices" => Register(request),
                        _ => throw new AssertFailedException("Unexpected endpoint"),
                    };

                    HttpResponseMessage Register(HttpRequestMessage sent)
                    {
                        Assert.AreEqual(tenant.ToString("D"),
                            sent.Headers.GetValues("X-Tenant-Id").Single());
                        Assert.AreEqual("fixture-access",sent.Headers.Authorization?.Parameter);
                        var key = sent.Headers.GetValues("Idempotency-Key").Single();
                        var body = sent.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                        using var doc = JsonDocument.Parse(body);
                        var jwk = doc.RootElement.GetProperty("public_key_jwk").GetRawText();
                        priorKey ??= key;
                        priorJwk ??= jwk;
                        Assert.AreEqual(priorKey,key);
                        Assert.AreEqual(priorJwk,jwk);
                        if (++registrationCalls == 1)
                            throw new HttpRequestException("synthetic response loss");
                        return JsonResponse(new { id = device,tenant_id = tenant,
                            platform = "windows",active = true,version = 1,
                            revoked_at = (string?)null },HttpStatusCode.Created);
                    }
                }));
            await onboarding.RequestCodeAsync("fixture@example.test");
            await onboarding.VerifyCodeAsync("fixture@example.test","123456");
            var workspaces = await onboarding.AvailableTenantsAsync();
            Assert.HasCount(1,workspaces);
            Assert.AreEqual(tenant.ToString("D"),workspaces[0].tenant_id);
            await Assert.ThrowsExactlyAsync<WindowsSessionUnavailableException>(() =>
                onboarding.CompleteEnrollmentAsync(tenant));
            Assert.IsNull(session.Read());
            Assert.IsNotNull(pending.Read());
            var saved = await onboarding.CompleteEnrollmentAsync(tenant);
            Assert.AreEqual(device,saved.DeviceId);
            Assert.AreEqual(1,registrationCalls);
            Assert.AreEqual(priorKey,keys.GetOrCreate(tenant,user)
                .RegistrationKey.ToString("D"));
            Assert.IsNull(pending.Read());
            foreach (var file in new[] { Path.Combine(sandbox,"session.protected"),
                Path.Combine(sandbox,"pending.protected") }.Where(File.Exists)
                .Concat(Directory.GetFiles(Path.Combine(sandbox,"keys"),"*.protected"))) {
                var bytes = File.ReadAllBytes(file);
                foreach (var decoded in new[] { Encoding.UTF8.GetString(bytes),
                    Encoding.Unicode.GetString(bytes) }) {
                    Assert.IsFalse(decoded.Contains("fixture-access",StringComparison.Ordinal));
                    Assert.IsFalse(decoded.Contains("fixture-refresh",StringComparison.Ordinal));
                    Assert.IsFalse(decoded.Contains("BEGIN PRIVATE KEY",StringComparison.Ordinal));
                }
            }
        } finally { Directory.Delete(sandbox,true); }
    }

    private static HttpResponseMessage VerifyOtpRequest(HttpRequestMessage request)
    {
        var body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
        using var json = JsonDocument.Parse(body);
        Assert.AreEqual("fixture@example.test",json.RootElement.GetProperty("email").GetString());
        Assert.IsFalse(json.RootElement.GetProperty("create_user").GetBoolean());
        return JsonResponse(new { });
    }

    [TestMethod, TestCategory("C16")]
    public async Task MissingTenantMembershipNeverRegistersDevice()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var user = Guid.NewGuid();
            var options = new WindowsConnectionOptions("https://api.example.test/",
                "https://auth.example.test/","publishable");
            var pending = new WindowsTokenVault(Path.Combine(sandbox,"pending.protected"));
            var session = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            var count = 0;
            using var onboarding = new WindowsAuthOnboarding(options,pending,session,
                new WindowsDeviceKeyStore(Path.Combine(sandbox,"keys")),
                new StubHandler(request => {
                    count++;
                    return request.RequestUri!.AbsolutePath switch {
                        "/auth/v1/verify" => JsonResponse(new {
                            access_token = "access",refresh_token = "refresh",
                            expires_in = 3600,user = new { id = user },
                        }),
                        "/v1/me" => JsonResponse(new { user_id = user,memberships =
                            Array.Empty<object>() }),
                        _ => throw new AssertFailedException("Unexpected device registration"),
                    };
                }));
            await onboarding.VerifyCodeAsync("fixture@example.test","123456");
            Assert.HasCount(0,await onboarding.AvailableTenantsAsync());
            await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(() =>
                onboarding.CompleteEnrollmentAsync(Guid.NewGuid()));
            Assert.AreEqual(3,count);
            Assert.IsNull(session.Read());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task ExpiredOtpIsLoginFailureNotServiceOutage()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            using var onboarding = new WindowsAuthOnboarding(
                new WindowsConnectionOptions("https://api.example.test/",
                    "https://auth.example.test/","publishable"),
                new WindowsTokenVault(Path.Combine(sandbox,"pending.protected")),
                new WindowsTokenVault(Path.Combine(sandbox,"session.protected")),
                new WindowsDeviceKeyStore(Path.Combine(sandbox,"keys")),
                new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.Forbidden)));
            await Assert.ThrowsExactlyAsync<WindowsLoginRequiredException>(() =>
                onboarding.VerifyCodeAsync("fixture@example.test","000000"));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task ConcurrentFirstKeyCreationKeepsOneRegistrationIdentity()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var keys = new WindowsDeviceKeyStore(Path.Combine(sandbox,"keys"));
            var results = await Task.WhenAll(Enumerable.Range(0,8).Select(_ =>
                Task.Run(() => keys.GetOrCreate(tenant,user))));
            Assert.AreEqual(1,results.Select(result => result.RegistrationKey)
                .Distinct().Count());
            Assert.AreEqual(1,results.Select(result => result.X).Distinct().Count());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task RevokedDeviceRotatesKeyAndRegistersNewDevice()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var oldDevice = Guid.NewGuid();
            var newDevice = Guid.NewGuid();
            var options = new WindowsConnectionOptions("https://api.example.test/",
                "https://auth.example.test/","publishable");
            var pending = new WindowsTokenVault(Path.Combine(sandbox,"pending.protected"));
            var session = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            var keys = new WindowsDeviceKeyStore(Path.Combine(sandbox,"keys"));
            var oldKey = keys.GetOrCreate(tenant,user);
            keys.MarkRegistered(tenant,user,oldDevice,oldKey.RegistrationKey);
            string? newRegistrationKey = null;
            using var onboarding = new WindowsAuthOnboarding(options,pending,session,keys,
                new StubHandler(request => request.RequestUri!.AbsolutePath switch {
                    "/auth/v1/verify" => JsonResponse(new { access_token = "access",
                        refresh_token = "refresh",expires_in = 3600,
                        user = new { id = user } }),
                    "/v1/me" => JsonResponse(new { user_id = user,memberships = new[] {
                        new { tenant_id = tenant,tenant_name = "Fixture",role = "owner" },
                    } }),
                    var path when path == $"/v1/devices/{oldDevice:D}" =>
                        JsonResponse(new { id = oldDevice,tenant_id = tenant,
                            platform = "windows",active = false,version = 2,
                            revoked_at = DateTimeOffset.UtcNow.ToString("O") }),
                    "/v1/devices" => Register(request),
                    var path when path.StartsWith("/v1/devices/by-key/",
                        StringComparison.Ordinal) =>
                        new HttpResponseMessage(HttpStatusCode.NotFound),
                    _ => throw new AssertFailedException("Unexpected endpoint"),
                }));
            HttpResponseMessage Register(HttpRequestMessage request)
            {
                newRegistrationKey = request.Headers.GetValues("Idempotency-Key").Single();
                return JsonResponse(new { id = newDevice,tenant_id = tenant,
                    platform = "windows",active = true,version = 1,
                    revoked_at = (string?)null },HttpStatusCode.Created);
            }
            await onboarding.VerifyCodeAsync("fixture@example.test","123456");
            var result = await onboarding.CompleteEnrollmentAsync(tenant);
            Assert.AreEqual(newDevice,result.DeviceId);
            Assert.AreNotEqual(oldKey.RegistrationKey.ToString("D"),newRegistrationKey);
            Assert.AreNotEqual(oldKey.X,keys.GetOrCreate(tenant,user).X);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task LostRegistrationResponseThenRevocationRotatesBeforeRetry()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var oldDevice = Guid.NewGuid();
            var newDevice = Guid.NewGuid();
            var pending = new WindowsTokenVault(Path.Combine(sandbox,"pending.protected"));
            var session = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            var keys = new WindowsDeviceKeyStore(Path.Combine(sandbox,"keys"));
            var registrations = 0;
            string? firstKey = null;
            string? secondKey = null;
            using var onboarding = new WindowsAuthOnboarding(
                new WindowsConnectionOptions("https://api.example.test/",
                    "https://auth.example.test/","publishable"),pending,session,keys,
                new StubHandler(request => request.RequestUri!.AbsolutePath switch {
                    "/auth/v1/verify" => JsonResponse(new { access_token = "access",
                        refresh_token = "refresh",expires_in = 3600,
                        user = new { id = user } }),
                    "/v1/me" => JsonResponse(new { user_id = user,memberships = new[] {
                        new { tenant_id = tenant,tenant_name = "Fixture",role = "owner" },
                    } }),
                    var path when path.StartsWith("/v1/devices/by-key/",
                        StringComparison.Ordinal) => registrations == 0
                            ? new HttpResponseMessage(HttpStatusCode.NotFound)
                            : JsonResponse(new { id = oldDevice,tenant_id = tenant,
                                platform = "windows",active = false,version = 2,
                                revoked_at = DateTimeOffset.UtcNow.ToString("O") }),
                    "/v1/devices" => Register(request),
                    _ => throw new AssertFailedException("Unexpected endpoint"),
                }));
            HttpResponseMessage Register(HttpRequestMessage request)
            {
                var key = request.Headers.GetValues("Idempotency-Key").Single();
                if (++registrations == 1) {
                    firstKey = key;
                    throw new HttpRequestException("synthetic lost response");
                }
                secondKey = key;
                return JsonResponse(new { id = newDevice,tenant_id = tenant,
                    platform = "windows",active = true,version = 1,
                    revoked_at = (string?)null },HttpStatusCode.Created);
            }
            await onboarding.VerifyCodeAsync("fixture@example.test","123456");
            await Assert.ThrowsExactlyAsync<WindowsSessionUnavailableException>(() =>
                onboarding.CompleteEnrollmentAsync(tenant));
            Assert.IsNull(keys.GetOrCreate(tenant,user).DeviceId);
            var result = await onboarding.CompleteEnrollmentAsync(tenant);
            Assert.AreEqual(newDevice,result.DeviceId);
            Assert.AreNotEqual(firstKey,secondKey);
            Assert.AreEqual(2,registrations);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task CompetingEnrollmentCannotBindRotatedKeyToOldDevice()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var oldDevice = Guid.NewGuid();
            var keys = new WindowsDeviceKeyStore(Path.Combine(sandbox,"keys"));
            var old = keys.GetOrCreate(tenant,user);
            keys.MarkRegistered(tenant,user,oldDevice,old.RegistrationKey);
            using var first = await keys.AcquireEnrollmentAsync(tenant,user);
            var secondTask = keys.AcquireEnrollmentAsync(tenant,user);
            await Task.Delay(100);
            Assert.IsFalse(secondTask.IsCompleted);
            var rotated = keys.RotateRevoked(tenant,user,oldDevice,
                old.RegistrationKey);
            Assert.ThrowsExactly<InvalidOperationException>(() =>
                keys.MarkRegistered(tenant,user,oldDevice,old.RegistrationKey));
            Assert.IsNull(keys.GetOrCreate(tenant,user).DeviceId);
            Assert.AreNotEqual(old.RegistrationKey,rotated.RegistrationKey);
            first.Dispose();
            using var second = await secondTask;
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void PublicKeyHashMatchesServerJsonOrder()
    {
        var key = new WindowsDeviceKey("",
            new string('A',43),new string('B',43),Guid.NewGuid(),
            Guid.NewGuid(),Guid.NewGuid());
        Assert.AreEqual("4c5d8382bdefbf53409a4fea32c9dceb2a797f5ba85240ee45cf3231b6c4cd0a",
            WindowsAuthOnboarding.PublicKeyHash(key));
    }

    [TestMethod, TestCategory("C16")]
    public void LocalConnectionConfigNeverAcceptsRemotePlainHttp()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-auth-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var path = Path.Combine(sandbox,"connection.json");
            File.WriteAllText(path,JsonSerializer.Serialize(new {
                apiBaseUrl = "http://remote.example.test/",
                supabaseOrigin = "https://auth.example.test/",
                publishableKey = "public",
            }));
            Assert.IsNull(WindowsConnectionSettings.Read(path));
            File.WriteAllText(path,JsonSerializer.Serialize(new {
                apiBaseUrl = "http://127.0.0.1:3001/",
                supabaseOrigin = "http://127.0.0.1:54321/",
                publishableKey = "public",
            }));
            Assert.IsNotNull(WindowsConnectionSettings.Read(path));
        } finally { Directory.Delete(sandbox,true); }
    }
}
