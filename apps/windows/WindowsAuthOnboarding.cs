using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Sigongnote.Contracts;

namespace Sigongnote.Windows;

public sealed record WindowsConnectionOptions(string ApiBaseUrl, string SupabaseOrigin,
    string PublishableKey, bool GoogleEnabled=false, bool NaverEnabled=false, bool KakaoEnabled=false)
{
    // Provider availability can refresh while the login dialog is open. It does
    // not change the service to which the verified credentials belong.
    internal bool SameService(WindowsConnectionOptions? other)=>other is not null &&
        ApiBaseUrl==other.ApiBaseUrl && SupabaseOrigin==other.SupabaseOrigin && PublishableKey==other.PublishableKey;

    public WindowsConnectionOptions Validate()
    {
        foreach (var raw in new[] { ApiBaseUrl, SupabaseOrigin }) {
            if (!Uri.TryCreate(raw,UriKind.Absolute,out var origin) ||
                origin.UserInfo.Length != 0 || origin.Query.Length != 0 ||
                origin.Fragment.Length != 0 || origin.AbsolutePath != "/" ||
                !(origin.Scheme == "https" || (origin.Scheme == "http" &&
                    origin.Host is "localhost" or "127.0.0.1")))
                throw new InvalidOperationException("Untrusted service origin");
        }
        if (string.IsNullOrWhiteSpace(PublishableKey) || PublishableKey.Length > 4096 ||
            PublishableKey.Contains('\r') || PublishableKey.Contains('\n'))
            throw new InvalidOperationException("Invalid publishable key");
        if (PublishableKey.StartsWith("sb_secret_",StringComparison.Ordinal))
            throw new InvalidOperationException("Only a public client key is allowed");
        if (PublishableKey.StartsWith("ey",StringComparison.Ordinal) || PublishableKey.Contains('.')) {
            try {
                var parts=PublishableKey.Split('.');
                if(parts.Length!=3)throw new FormatException();
                var payload=parts[1].Replace('-','+').Replace('_','/');
                payload=payload.PadRight((payload.Length+3)/4*4,'=');
                using var doc=JsonDocument.Parse(Convert.FromBase64String(payload));
                if(doc.RootElement.GetProperty("role").GetString()!="anon")throw new FormatException();
            } catch(Exception error) when(error is JsonException or FormatException or KeyNotFoundException or InvalidOperationException) {
                throw new InvalidOperationException("Only an anon JWT is allowed in client settings");
            }
        }
        if((GoogleEnabled || NaverEnabled || KakaoEnabled) && new Uri(SupabaseOrigin).Scheme!="https")
            throw new InvalidOperationException("Google login requires HTTPS");
        return this;
    }
}

public sealed record WindowsPendingAuth(string AccessToken, string RefreshToken,
    long ExpiresAtEpochMs, Guid UserId, WindowsConnectionOptions Options);

public sealed record WindowsDeviceKey(string PrivateKeyPkcs8, string X, string Y,
    Guid RegistrationKey, Guid TenantId, Guid UserId, Guid? DeviceId = null);

/// <summary>A stable per-principal key and idempotency key survive lost registration responses.</summary>
public sealed class WindowsDeviceKeyStore(string root)
{
    private readonly string root = Path.GetFullPath(root);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public WindowsDeviceKey GetOrCreate(Guid tenantId, Guid userId)
    {
        if (tenantId == Guid.Empty || userId == Guid.Empty)
            throw new ArgumentException("Principal is required");
        Directory.CreateDirectory(root);
        var path = KeyPath(tenantId,userId);
        using var guard = Lock(path);
        var vault = new WindowsTokenVault(path);
        var stored = vault.Read();
        if (stored is not null) {
            var existing = JsonSerializer.Deserialize<WindowsDeviceKey>(stored,Json) ??
                throw new InvalidOperationException("Invalid device key");
            if (existing.TenantId != tenantId || existing.UserId != userId ||
                existing.RegistrationKey == Guid.Empty)
                throw new InvalidOperationException("Device key belongs to another principal");
            using var check = ECDsa.Create();
            check.ImportPkcs8PrivateKey(Convert.FromBase64String(existing.PrivateKeyPkcs8),out _);
            var point = check.ExportParameters(false).Q;
            if (Base64Url(point.X!) != existing.X || Base64Url(point.Y!) != existing.Y)
                throw new InvalidOperationException("Invalid device key");
            return existing;
        }
        var created = NewKey(tenantId,userId);
        vault.Save(JsonSerializer.Serialize(created,Json));
        return created;
    }

    public async Task<FileStream> AcquireEnrollmentAsync(Guid tenantId, Guid userId,
        CancellationToken cancellation = default)
    {
        var path = KeyPath(tenantId,userId) + ".enrollment.lock";
        for (var attempt = 0; attempt < 600; attempt++) {
            cancellation.ThrowIfCancellationRequested();
            try { return new FileStream(path,FileMode.OpenOrCreate,FileAccess.ReadWrite,
                FileShare.None); }
            catch (IOException) when (attempt < 599) {
                await Task.Delay(50,cancellation);
            }
        }
        throw new WindowsSessionUnavailableException();
    }

    public WindowsDeviceKey MarkRegistered(Guid tenantId, Guid userId, Guid deviceId,
        Guid expectedRegistrationKey)
    {
        if (deviceId == Guid.Empty) throw new ArgumentException("Device is required",nameof(deviceId));
        var path = KeyPath(tenantId,userId);
        using var guard = Lock(path);
        var vault = new WindowsTokenVault(path);
        var old = JsonSerializer.Deserialize<WindowsDeviceKey>(vault.Read() ?? "",Json) ??
            throw new InvalidOperationException("Device registration key is missing");
        if (old.TenantId != tenantId || old.UserId != userId ||
            old.RegistrationKey != expectedRegistrationKey ||
            (old.DeviceId.HasValue && old.DeviceId != deviceId))
            throw new InvalidOperationException("Device registration changed");
        var updated = old with { DeviceId = deviceId };
        vault.Save(JsonSerializer.Serialize(updated,Json));
        return updated;
    }

    public WindowsDeviceKey RotateRevoked(Guid tenantId, Guid userId, Guid oldDeviceId,
        Guid expectedRegistrationKey)
    {
        var path = KeyPath(tenantId,userId);
        using var guard = Lock(path);
        var vault = new WindowsTokenVault(path);
        var old = JsonSerializer.Deserialize<WindowsDeviceKey>(vault.Read() ?? "",Json) ??
            throw new InvalidOperationException("Device registration key is missing");
        if (old.TenantId != tenantId || old.UserId != userId || old.DeviceId != oldDeviceId ||
            old.RegistrationKey != expectedRegistrationKey)
            throw new InvalidOperationException("Revoked device does not match");
        var next = NewKey(tenantId,userId);
        vault.Save(JsonSerializer.Serialize(next,Json));
        return next;
    }

    private string KeyPath(Guid tenantId, Guid userId)
    {
        Directory.CreateDirectory(root);
        var name = Convert.ToHexString(SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"{tenantId:D}:{userId:D}"))).ToLowerInvariant();
        return Path.Combine(root,name + ".protected");
    }

    private static FileStream Lock(string path)
    {
        for (var attempt = 0; attempt < 100; attempt++) {
            try { return new FileStream(path + ".lock",FileMode.OpenOrCreate,
                FileAccess.ReadWrite,FileShare.None); }
            catch (IOException) when (attempt < 99) { Thread.Sleep(50); }
        }
        throw new IOException("Device enrollment is busy");
    }

    private static WindowsDeviceKey NewKey(Guid tenantId, Guid userId)
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var point = signingKey.ExportParameters(false).Q;
        return new WindowsDeviceKey(
            Convert.ToBase64String(signingKey.ExportPkcs8PrivateKey()),
            Base64Url(point.X!),Base64Url(point.Y!),Guid.NewGuid(),tenantId,userId);
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes)
        .TrimEnd('=').Replace('+','-').Replace('/','_');
}

/// <summary>Email OTP and device enrollment; only verified membership yields a saved session.</summary>
public sealed class WindowsAuthOnboarding : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly Regex Email = new(@"^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{2,63}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private readonly WindowsConnectionOptions options;
    private readonly WindowsTokenVault pendingVault;
    private readonly WindowsTokenVault sessionVault;
    private readonly WindowsDeviceKeyStore devices;
    private readonly HttpClient http;

    public WindowsAuthOnboarding(WindowsConnectionOptions options,
        WindowsTokenVault pendingVault, WindowsTokenVault sessionVault,
        WindowsDeviceKeyStore devices, HttpMessageHandler? handler = null)
    {
        this.options = options.Validate();
        this.pendingVault = pendingVault;
        this.sessionVault = sessionVault;
        this.devices = devices;
        http = new HttpClient(handler ?? new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false,
        }) { Timeout = TimeSpan.FromSeconds(15) };
    }

    public void Dispose() => http.Dispose();

    public async Task RequestCodeAsync(string email, CancellationToken cancellation = default)
    {
        ValidateEmail(email);
        using var request = new HttpRequestMessage(HttpMethod.Post,
            new Uri(new Uri(options.SupabaseOrigin),"auth/v1/otp")) {
            Content = JsonContent.Create(new { email, create_user = false }),
        };
        request.Headers.TryAddWithoutValidation("apikey",options.PublishableKey);
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode is HttpStatusCode.UnprocessableEntity or
            HttpStatusCode.BadRequest or HttpStatusCode.Forbidden)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.NoContent))
            throw new WindowsSessionUnavailableException();
    }

    public async Task VerifyCodeAsync(string email, string code,
        CancellationToken cancellation = default)
    {
        ValidateEmail(email);
        if (!Regex.IsMatch(code,@"^[0-9]{6,8}$",RegexOptions.CultureInvariant))
            throw new ArgumentException("Invalid one-time code",nameof(code));
        using var request = new HttpRequestMessage(HttpMethod.Post,
            new Uri(new Uri(options.SupabaseOrigin),"auth/v1/verify")) {
            Content = JsonContent.Create(new { email, token = code, type = "email" }),
        };
        request.Headers.TryAddWithoutValidation("apikey",options.PublishableKey);
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or
            HttpStatusCode.Forbidden)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode != HttpStatusCode.OK)
            throw new WindowsSessionUnavailableException();
        try {
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
            var root = document.RootElement;
            var seconds = root.GetProperty("expires_in").GetInt64();
            if (seconds is < 60 or > 604_800) throw new JsonException();
            var pending = new WindowsPendingAuth(
                root.GetProperty("access_token").GetString()!,
                root.GetProperty("refresh_token").GetString()!,
                DateTimeOffset.UtcNow.AddSeconds(seconds).ToUnixTimeMilliseconds(),
                Guid.Parse(root.GetProperty("user").GetProperty("id").GetString()!),options);
            if (pending.UserId == Guid.Empty ||
                string.IsNullOrWhiteSpace(pending.AccessToken) ||
                string.IsNullOrWhiteSpace(pending.RefreshToken)) throw new JsonException();
            pendingVault.Save(JsonSerializer.Serialize(pending,Json));
        } catch (Exception error) when (error is JsonException or FormatException or
            KeyNotFoundException or InvalidOperationException or ArgumentNullException) {
            throw new WindowsSessionUnavailableException();
        }
    }

    public async Task<MeResponseMembershipsItem[]> AvailableTenantsAsync(
        CancellationToken cancellation = default)
    {
        var pending = ReadPending();
        var me = await ReadMembershipsAsync(pending,cancellation);
        return me.memberships.Where(member => member.role is "owner" or "operator" &&
            Guid.TryParse(member.tenant_id,out _)).ToArray();
    }

    public async Task<WindowsSession> CompleteEnrollmentAsync(Guid tenantId,
        CancellationToken cancellation = default)
    {
        if (tenantId == Guid.Empty) throw new ArgumentException("Tenant is required",nameof(tenantId));
        var pending = ReadPending();
        var me = await ReadMembershipsAsync(pending,cancellation);
        if (!me.memberships.Any(m => Guid.TryParse(m.tenant_id,out var id) &&
            id == tenantId && m.role is "owner" or "operator"))
            throw new WindowsLoginRequiredException();

        using var enrollmentGuard = await devices.AcquireEnrollmentAsync(
            tenantId,pending.UserId,cancellation);
        var deviceKey = devices.GetOrCreate(tenantId,pending.UserId);
        for (var attempt = 0; attempt < 2; attempt++) {
            var known = await ResolveDeviceAsync(pending,tenantId,deviceKey,cancellation);
            if (known is not null) {
                var knownId = ValidateDevice(known,tenantId);
                devices.MarkRegistered(tenantId,pending.UserId,knownId,
                    deviceKey.RegistrationKey);
                if (known.active) return SaveSession(pending,tenantId,knownId);
                deviceKey = devices.RotateRevoked(tenantId,pending.UserId,knownId,
                    deviceKey.RegistrationKey);
            } else if (deviceKey.DeviceId is { } missingId) {
                deviceKey = devices.RotateRevoked(tenantId,pending.UserId,missingId,
                    deviceKey.RegistrationKey);
            }
            using var registration = ApiRequest(HttpMethod.Post,"v1/devices",
                pending.AccessToken,tenantId,deviceKey.RegistrationKey);
            registration.Content = JsonContent.Create(new DeviceRegistrationRequest(
                "windows","0.1.0",new DeviceRegistrationRequestPublicKeyJwk(
                    "EC","P-256",deviceKey.X,deviceKey.Y)));
            using var response = await SendAsync(registration,cancellation);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                throw new WindowsLoginRequiredException();
            if (response.StatusCode == HttpStatusCode.Conflict && attempt == 0)
                continue;
            if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.Created))
                throw new WindowsSessionUnavailableException();
            DeviceResponse registered;
            try { registered = await response.Content.ReadFromJsonAsync<DeviceResponse>(
                Json,cancellation) ?? throw new JsonException(); }
            catch (JsonException) { throw new WindowsSessionUnavailableException(); }
            var deviceId = ValidateDevice(registered,tenantId);
            devices.MarkRegistered(tenantId,pending.UserId,deviceId,
                deviceKey.RegistrationKey);
            if (registered.active) return SaveSession(pending,tenantId,deviceId);
            deviceKey = devices.RotateRevoked(tenantId,pending.UserId,deviceId,
                deviceKey.RegistrationKey);
        }
        throw new WindowsSessionUnavailableException();
    }

    private WindowsPendingAuth ReadPending()
    {
        try {
            var pending = JsonSerializer.Deserialize<WindowsPendingAuth>(pendingVault.Read() ?? "",Json) ??
                throw new JsonException();
            if (!options.SameService(pending.Options) || pending.UserId == Guid.Empty ||
                pending.ExpiresAtEpochMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
                throw new JsonException();
            return pending;
        } catch (JsonException) { throw new WindowsLoginRequiredException(); }
    }

    private async Task<MeResponse> ReadMembershipsAsync(WindowsPendingAuth pending,
        CancellationToken cancellation)
    {
        using var meRequest = ApiRequest(HttpMethod.Get,"v1/me",pending.AccessToken);
        using var meResponse = await SendAsync(meRequest,cancellation);
        if (meResponse.StatusCode == HttpStatusCode.Unauthorized)
            throw new WindowsLoginRequiredException();
        if (meResponse.StatusCode != HttpStatusCode.OK)
            throw new WindowsSessionUnavailableException();
        MeResponse me;
        try { me = await meResponse.Content.ReadFromJsonAsync<MeResponse>(Json,cancellation) ??
            throw new JsonException(); }
        catch (JsonException) { throw new WindowsSessionUnavailableException(); }
        if (!Guid.TryParse(me.user_id,out var actualUser) || actualUser != pending.UserId)
            throw new WindowsLoginRequiredException();
        return me;
    }

    private async Task<DeviceResponse?> ResolveDeviceAsync(WindowsPendingAuth pending,
        Guid tenantId, WindowsDeviceKey key, CancellationToken cancellation)
    {
        var path = key.DeviceId is { } deviceId ? $"v1/devices/{deviceId:D}" :
            $"v1/devices/by-key/{PublicKeyHash(key)}";
        using var request = ApiRequest(HttpMethod.Get,path,pending.AccessToken,tenantId);
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        if (response.StatusCode != HttpStatusCode.OK)
            throw new WindowsSessionUnavailableException();
        try { return await response.Content.ReadFromJsonAsync<DeviceResponse>(Json,cancellation) ??
            throw new JsonException(); }
        catch (JsonException) { throw new WindowsSessionUnavailableException(); }
    }

    public static string PublicKeyHash(WindowsDeviceKey key)
    {
        var jwk = new DeviceRegistrationRequestPublicKeyJwk("EC","P-256",key.X,key.Y);
        return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(jwk,Json)))).ToLowerInvariant();
    }

    private static Guid ValidateDevice(DeviceResponse device, Guid tenantId)
    {
        if (!Guid.TryParse(device.id,out var deviceId) || deviceId == Guid.Empty ||
            device.tenant_id != tenantId.ToString("D") || device.platform != "windows")
            throw new WindowsSessionUnavailableException();
        return deviceId;
    }

    private WindowsSession SaveSession(WindowsPendingAuth pending, Guid tenantId, Guid deviceId)
    {
        var session = new WindowsSession(options.ApiBaseUrl,options.SupabaseOrigin,
            options.PublishableKey,pending.AccessToken,pending.RefreshToken,
            pending.ExpiresAtEpochMs,tenantId,pending.UserId,deviceId).Validate();
        sessionVault.Save(JsonSerializer.Serialize(session,Json));
        pendingVault.Clear();
        return session;
    }

    private HttpRequestMessage ApiRequest(HttpMethod method, string path, string access,
        Guid? tenant = null, Guid? idempotency = null)
    {
        var request = new HttpRequestMessage(method,new Uri(new Uri(options.ApiBaseUrl),path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",access);
        if (tenant.HasValue)
            request.Headers.TryAddWithoutValidation("X-Tenant-Id",tenant.Value.ToString("D"));
        if (idempotency.HasValue)
            request.Headers.TryAddWithoutValidation("Idempotency-Key",idempotency.Value.ToString("D"));
        return request;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
        CancellationToken cancellation)
    {
        try { return await http.SendAsync(request,cancellation); }
        catch (HttpRequestException) { throw new WindowsSessionUnavailableException(); }
        catch (TaskCanceledException) when (!cancellation.IsCancellationRequested) {
            throw new WindowsSessionUnavailableException();
        }
    }

    private static void ValidateEmail(string email)
    {
        if (email is null || email.Length > 254 || !Email.IsMatch(email))
            throw new ArgumentException("Invalid email",nameof(email));
    }
}
