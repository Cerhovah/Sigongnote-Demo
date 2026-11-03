using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sigongnote.Contracts;

namespace Sigongnote.Windows;

public sealed record WindowsSession(string ApiBaseUrl, string SupabaseOrigin,
    string PublishableKey, string AccessToken, string RefreshToken,
    long ExpiresAtEpochMs, Guid TenantId, Guid UserId, Guid DeviceId)
{
    public WindowsPrincipal Principal => new(TenantId,UserId,DeviceId);

    public WindowsSession Validate()
    {
        if (ApiBaseUrl is null || SupabaseOrigin is null || PublishableKey is null ||
            AccessToken is null || RefreshToken is null)
            throw new InvalidOperationException("Invalid local session");
        foreach (var raw in new[] { ApiBaseUrl,SupabaseOrigin }) {
            if (!Uri.TryCreate(raw,UriKind.Absolute,out var origin) ||
                origin.UserInfo.Length != 0 || origin.Query.Length != 0 ||
                origin.Fragment.Length != 0 || origin.AbsolutePath != "/" ||
                !(origin.Scheme == "https" || (origin.Scheme == "http" &&
                    origin.Host is "localhost" or "127.0.0.1")))
                throw new InvalidOperationException("Untrusted service origin");
        }
        if (TenantId == Guid.Empty || UserId == Guid.Empty || DeviceId == Guid.Empty ||
            ExpiresAtEpochMs <= 0 || PublishableKey.Length is < 1 or > 4096 ||
            AccessToken.Length is < 1 or > 8192 || RefreshToken.Length is < 1 or > 8192 ||
            new[] { PublishableKey,AccessToken,RefreshToken }.Any(value =>
                value.Contains('\r') || value.Contains('\n')))
            throw new InvalidOperationException("Invalid local session");
        return this;
    }
}

public sealed class WindowsLoginRequiredException : Exception;
public sealed class WindowsSessionUnavailableException : Exception;
public sealed class WindowsSourcePermissionException : Exception;
public sealed class WindowsSourceConflictException : Exception;
public sealed class WindowsSourceInactiveException : Exception;
public sealed class WindowsClientContractException : Exception;
public sealed class WindowsScopeSetupRequiredException : Exception;

public sealed record WindowsFirstSite(string? project_id);
public sealed record WindowsUploadDestination(string Company, string Origin, WindowsPrincipal Principal,
    CapturePolicy? Policy = null, WindowsProjectChoice[]? Projects = null, WindowsFolderSelection? Selection = null, string? FirstProject = null)
{
    public bool Matches(WindowsSession session) => Principal == session.Principal &&
        Origin == new Uri(session.ApiBaseUrl).GetLeftPart(UriPartial.Authority);
}

/// <summary>Serializes refresh rotation and binds folder scope to verified API identity.</summary>
public sealed partial class WindowsSessionManager : IDisposable
{
    private static readonly SemaphoreSlim RefreshGate = new(1,1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly WindowsTokenVault vault;
    private readonly HttpClient http;

    public WindowsSessionManager(WindowsTokenVault vault, HttpMessageHandler? handler = null)
    {
        this.vault = vault;
        http = new HttpClient(handler ?? new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false,
        });
        http.Timeout = TimeSpan.FromSeconds(30);
    }

    public void Dispose() => http.Dispose();

    public async Task<WindowsUploadDestination> UploadDestinationAsync(CancellationToken cancellation = default, bool includeSetup = false)
    {
        var session=await CurrentAsync(cancellation);
        var me=await GetJsonAsync<MeResponse>(session,"v1/me",false,cancellation);
        var company=me.memberships.SingleOrDefault(member=>
            Guid.TryParse(member.tenant_id,out var tenant) && tenant==session.TenantId &&
            member.role is "owner" or "operator");
        if(!Guid.TryParse(me.user_id,out var user) || user!=session.UserId ||
            company is null || string.IsNullOrWhiteSpace(company.tenant_name))
            throw new WindowsLoginRequiredException();
        var policy=includeSetup ? await GetJsonAsync<CapturePolicy>(session,"v1/capture-policy",false,cancellation) : null;
        var projects=includeSetup ? await GetJsonAsync<WindowsProjectList>(session,"v1/projects",true,cancellation) : null;
        var first=includeSetup ? await GetJsonAsync<WindowsFirstSite>(session,"v1/work/setup",true,cancellation) : null;
        if(policy is not null)ValidatePolicy(policy);
        return new WindowsUploadDestination(company.tenant_name,
            new Uri(session.ApiBaseUrl).GetLeftPart(UriPartial.Authority),session.Principal,policy,projects?.projects,FirstProject:first?.project_id);
    }

    public async Task ApplyLinkedLoginAsync(WindowsSession expected,WindowsPendingAuth replacement,CancellationToken cancellation=default)
    {
        if(expected.UserId!=replacement.UserId || replacement.Options.ApiBaseUrl!=expected.ApiBaseUrl || replacement.Options.SupabaseOrigin!=expected.SupabaseOrigin)throw new WindowsLoginRequiredException();
        var next=(expected with {AccessToken=replacement.AccessToken,RefreshToken=replacement.RefreshToken,ExpiresAtEpochMs=replacement.ExpiresAtEpochMs}).Validate();
        if(next.ExpiresAtEpochMs<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())throw new WindowsLoginRequiredException();
        var original=vault.Read() ?? throw new WindowsLoginRequiredException();
        var originalSession=JsonSerializer.Deserialize<WindowsSession>(original,Json) ?? throw new WindowsLoginRequiredException();
        if(originalSession.Principal!=expected.Principal)throw new WindowsLoginRequiredException();
        // Verify the replacement itself; automatic refresh here could validate an old token instead.
        using var request=new HttpRequestMessage(HttpMethod.Get,new Uri(new Uri(next.ApiBaseUrl),"v1/me"));
        request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",next.AccessToken);
        using var response=await http.SendAsync(request,cancellation);
        if(response.StatusCode!=HttpStatusCode.OK)throw new WindowsLoginRequiredException();
        var me=await response.Content.ReadFromJsonAsync<MeResponse>(Json,cancellation) ?? throw new WindowsLoginRequiredException();
        if(!Guid.TryParse(me.user_id,out var linkedUser) || linkedUser!=expected.UserId || !me.memberships.Any(row=>Guid.TryParse(row.tenant_id,out var linkedTenant) && linkedTenant==expected.TenantId && row.role is "owner" or "operator"))throw new WindowsLoginRequiredException();
        await RefreshGate.WaitAsync(cancellation);
        try {var current=ReadSession();if(current.Principal!=expected.Principal || current.ApiBaseUrl!=expected.ApiBaseUrl || current.SupabaseOrigin!=expected.SupabaseOrigin)throw new WindowsLoginRequiredException();if(!vault.ReplaceIfUnchanged(original,JsonSerializer.Serialize(next,Json)))throw new WindowsLoginRequiredException();}
        finally {RefreshGate.Release();}
    }

    public async Task<WindowsSession> CurrentAsync(CancellationToken cancellation = default)
    {
        var session = ReadSession();
        if (session.ExpiresAtEpochMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >
            TimeSpan.FromMinutes(5).TotalMilliseconds) return session;
        await RefreshGate.WaitAsync(cancellation);
        try {
            session = ReadSession();
            if (session.ExpiresAtEpochMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >
                TimeSpan.FromMinutes(5).TotalMilliseconds) return session;
            return await RefreshAsync(session,cancellation);
        } finally { RefreshGate.Release(); }
    }

    public async Task<FolderConnection> BindVerifiedFolderAsync(WindowsStateStore state,
        string localSourceId, Guid serverSourceId, CancellationToken cancellation = default)
    {
        var session = await CurrentAsync(cancellation);
        var me = await GetJsonAsync<MeResponse>(session,"v1/me",false,cancellation);
        session = await CurrentAsync(cancellation);
        if (!Guid.TryParse(me.user_id,out var userId) || userId != session.UserId ||
            !me.memberships.Any(member =>
                Guid.TryParse(member.tenant_id,out var tenant) && tenant == session.TenantId &&
                member.role is "owner" or "operator"))
            throw new WindowsLoginRequiredException();
        var sources = await GetJsonAsync<CaptureSourcesResponse>(session,
            "v1/capture-sources",true,cancellation);
        var source = sources.sources.SingleOrDefault(item =>
            Guid.TryParse(item.id,out var id) && id == serverSourceId);
        if (source is null || !source.upload_ready ||
            !source.server_upload_consent || !source.active || !source.device_active)
            throw new WindowsSourceInactiveException();
        var setup=state.FolderSetup(localSourceId);
        if (setup is not null)ValidateSourceSetup(source,setup);
        if (source.kind != (setup?.Selection.Kind ?? "folder") ||
            !Guid.TryParse(source.tenant_id,out var sourceTenant) ||
            sourceTenant != session.TenantId ||
            !Guid.TryParse(source.device_id,out var sourceDevice) ||
            sourceDevice != session.DeviceId || source.generation < 1)
            throw new InvalidOperationException("Folder source is not authorized for upload");
        state.BindSource(localSourceId,session.Principal,serverSourceId,source.generation);
        return state.Folders().Single(item => item.Id == localSourceId);
    }

    /// <summary>Creates a server source only after an explicit upload choice; paths stay local.</summary>
    public async Task<FolderConnection> CreateAndBindFolderAsync(WindowsStateStore state,
        WindowsDeviceKeyStore keys, string localSourceId, bool approvedUpload,
        CancellationToken cancellation = default)
    {
        if (!approvedUpload) throw new InvalidOperationException("Server upload consent is required");
        var session = await CurrentAsync(cancellation);
        var folder = state.Folders().Single(item => item.Id == localSourceId);
        if (folder.State != "selected" || folder.RootPath is null ||
            folder.VolumeId is null || folder.VolumeSerial is null ||
            folder.RelativePath is null || !Directory.Exists(folder.RootPath) ||
            (folder.TenantId.HasValue && (folder.TenantId != session.TenantId ||
                folder.UserId != session.UserId || folder.DeviceId != session.DeviceId)))
            throw new InvalidOperationException("Folder requires reauthorization");
        if (folder.ServerSourceId.HasValue)
            return await BindVerifiedFolderAsync(state,localSourceId,
                folder.ServerSourceId.Value,cancellation);
        // D04 scope adapter supplies v2 next; never register all-history consent as legacy v1.
        if(state.ScopeBaseline(localSourceId).CutoffUtc.Ticks==0)throw new WindowsScopeSetupRequiredException();
        var key = keys.GetOrCreate(session.TenantId,session.UserId);
        if (key.DeviceId != session.DeviceId)
            throw new WindowsLoginRequiredException();
        var keyBytes = Convert.FromBase64String(key.PrivateKeyPkcs8);
        string fingerprint;
        try {
            var scope = $"folder:v1:{folder.VolumeId}:{folder.VolumeSerial}:{folder.RelativePath}";
            fingerprint = Convert.ToHexString(HMACSHA256.HashData(keyBytes,
                Encoding.UTF8.GetBytes(scope))).ToLowerInvariant();
        } finally { CryptographicOperations.ZeroMemory(keyBytes); }
        var body = new CaptureSourceCreateRequest(session.DeviceId.ToString("D"),"folder",
            fingerprint,1,true,true,false);
        var attemptKey = state.ConnectionAttempt(localSourceId,session.DeviceId);
        try {
            var sourceId = await CreateSourceAsync(session,attemptKey,body,cancellation);
            return await BindVerifiedFolderAsync(state,localSourceId,sourceId,cancellation);
        } catch (Exception error) when (error is WindowsSourceConflictException or
            WindowsSourceInactiveException) {
            state.RotateConnectionAttempt(localSourceId,session.DeviceId);
            throw;
        }
    }

    private async Task<Guid> CreateSourceAsync(WindowsSession session, Guid idempotencyKey,
        CaptureSourceCreateRequest body, CancellationToken cancellation)
    {
        for (var attempt = 0; attempt < 2; attempt++) {
            using var request = new HttpRequestMessage(HttpMethod.Post,
                new Uri(new Uri(session.ApiBaseUrl),"v1/capture-sources")) {
                Content = JsonContent.Create(body,options:Json),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",
                session.AccessToken);
            request.Headers.TryAddWithoutValidation("X-Tenant-Id",
                session.TenantId.ToString("D"));
            request.Headers.TryAddWithoutValidation("Idempotency-Key",
                idempotencyKey.ToString("D"));
            HttpResponseMessage response;
            try { response = await http.SendAsync(request,cancellation); }
            catch (HttpRequestException) { throw new WindowsSessionUnavailableException(); }
            catch (TaskCanceledException) when (!cancellation.IsCancellationRequested) {
                throw new WindowsSessionUnavailableException();
            }
            using (response) {
                if (response.StatusCode == HttpStatusCode.Unauthorized) {
                    if (attempt == 0) {
                        session = await ForceRefreshAsync(session.AccessToken,cancellation);
                        continue;
                    }
                    vault.Clear();
                    throw new WindowsLoginRequiredException();
                }
                ThrowSourceError(response.StatusCode);
                if (response.StatusCode != HttpStatusCode.Created)
                    throw new WindowsSessionUnavailableException();
                try {
                    using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(
                        cancellation));
                    return Guid.Parse(document.RootElement.GetProperty("id").GetString()!);
                } catch (Exception error) when (error is JsonException or FormatException or
                    ArgumentNullException) { throw new WindowsSessionUnavailableException(); }
            }
        }
        throw new WindowsSessionUnavailableException();
    }

    private WindowsSession ReadSession()
    {
        var raw = vault.Read();
        if (raw is null) throw new WindowsLoginRequiredException();
        try { return (JsonSerializer.Deserialize<WindowsSession>(raw,Json) ??
            throw new JsonException()).Validate(); }
        catch (Exception error) when (error is JsonException or InvalidOperationException) {
            vault.Clear();
            throw new WindowsLoginRequiredException();
        }
    }

    private async Task<WindowsSession> ForceRefreshAsync(string previousAccessToken,
        CancellationToken cancellation)
    {
        await RefreshGate.WaitAsync(cancellation);
        try {
            var latest = ReadSession();
            return latest.AccessToken == previousAccessToken ?
                await RefreshAsync(latest,cancellation) : latest;
        } finally { RefreshGate.Release(); }
    }

    private Task<WindowsSession> RefreshAsync(WindowsSession previous,CancellationToken cancellation)
    {
        // The local collector helper and tray both refresh this vault. Hold the named mutex on
        // one worker thread through token rotation so they never reuse a rotated refresh token.
        return Task.Run(()=> {
            using var gate=new Mutex(false,@"Local\Sigongnote.Windows.SessionRefresh");
            var acquired=false;
            try {
                try {acquired=WaitHandle.WaitAny([gate,cancellation.WaitHandle])==0;}
                catch(AbandonedMutexException){acquired=true;}
                if(!acquired)throw new OperationCanceledException(cancellation);
                var latest=ReadSession();
                if(latest.Principal!=previous.Principal)throw new WindowsLoginRequiredException();
                if(latest.AccessToken!=previous.AccessToken)return latest;
                return RefreshWithRetriesAsync(latest,cancellation).GetAwaiter().GetResult();
            }finally{if(acquired)gate.ReleaseMutex();}
        },cancellation);
    }

    private async Task<WindowsSession> RefreshWithRetriesAsync(WindowsSession previous,
        CancellationToken cancellation)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        for (var attempt = 0; attempt < 3; attempt++) {
            try { return await RefreshOnceAsync(previous,cancellation); }
            catch (WindowsSessionUnavailableException) when (attempt < 2 &&
                System.Diagnostics.Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(8)) {
                await Task.Delay(200,cancellation);
            }
        }
        throw new WindowsSessionUnavailableException();
    }

    private async Task<WindowsSession> RefreshOnceAsync(WindowsSession previous,
        CancellationToken cancellation)
    {
        var url = new Uri(new Uri(previous.SupabaseOrigin),
            "auth/v1/token?grant_type=refresh_token");
        using var request = new HttpRequestMessage(HttpMethod.Post,url) {
            Content = JsonContent.Create(new { refresh_token = previous.RefreshToken }),
        };
        request.Headers.TryAddWithoutValidation("apikey",previous.PublishableKey);
        using var callLimit = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        callLimit.CancelAfter(TimeSpan.FromSeconds(2));
        HttpResponseMessage response;
        try { response = await http.SendAsync(request,callLimit.Token); }
        catch (HttpRequestException) { throw new WindowsSessionUnavailableException(); }
        catch (TaskCanceledException) when (!cancellation.IsCancellationRequested) {
            throw new WindowsSessionUnavailableException();
        }
        using (response) {
            if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or
                HttpStatusCode.Forbidden) {
                vault.Clear();
                throw new WindowsLoginRequiredException();
            }
            if (response.StatusCode != HttpStatusCode.OK)
                throw new WindowsSessionUnavailableException();
            try {
                using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(
                    callLimit.Token));
                var root = document.RootElement;
                var userId = Guid.Parse(root.GetProperty("user").GetProperty("id").GetString()!);
                var seconds = root.GetProperty("expires_in").GetInt64();
                if (userId != previous.UserId || seconds is < 60 or > 86_400) {
                    vault.Clear();
                    throw new WindowsLoginRequiredException();
                }
                var refreshed = previous with {
                    AccessToken = root.GetProperty("access_token").GetString()!,
                    RefreshToken = root.GetProperty("refresh_token").GetString()!,
                    ExpiresAtEpochMs = DateTimeOffset.UtcNow.AddSeconds(seconds)
                        .ToUnixTimeMilliseconds(),
                };
                refreshed.Validate();
                vault.Save(JsonSerializer.Serialize(refreshed,Json));
                return refreshed;
            } catch (WindowsLoginRequiredException) { throw; }
              catch (TaskCanceledException) when (!cancellation.IsCancellationRequested) {
                throw new WindowsSessionUnavailableException();
            }
              catch (Exception error) when (error is JsonException or FormatException or
                  InvalidOperationException or ArgumentNullException) {
                throw new WindowsSessionUnavailableException();
            }
        }
    }

    private async Task<T> GetJsonAsync<T>(WindowsSession session, string path,
        bool tenantScoped, CancellationToken cancellation)
    {
        for (var attempt = 0; attempt < 2; attempt++) {
            using var request = new HttpRequestMessage(HttpMethod.Get,
                new Uri(new Uri(session.ApiBaseUrl),path));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",
                session.AccessToken);
            if (tenantScoped) request.Headers.TryAddWithoutValidation("X-Tenant-Id",
                session.TenantId.ToString("D"));
            HttpResponseMessage response;
            try { response = await http.SendAsync(request,cancellation); }
            catch (HttpRequestException) { throw new WindowsSessionUnavailableException(); }
            catch (TaskCanceledException) when (!cancellation.IsCancellationRequested) {
                throw new WindowsSessionUnavailableException();
            }
            using (response) {
                if (response.StatusCode == HttpStatusCode.Unauthorized) {
                    if (attempt == 0) {
                        session = await ForceRefreshAsync(session.AccessToken,cancellation);
                        continue;
                    }
                    vault.Clear();
                    throw new WindowsLoginRequiredException();
                }
                ThrowSourceError(response.StatusCode);
                if (response.StatusCode != HttpStatusCode.OK)
                    throw new WindowsSessionUnavailableException();
                try { return await response.Content.ReadFromJsonAsync<T>(Json,cancellation) ??
                    throw new JsonException(); }
                catch (JsonException) { throw new WindowsSessionUnavailableException(); }
            }
        }
        throw new WindowsSessionUnavailableException();
    }

    private static void ThrowSourceError(HttpStatusCode status)
    {
        if (status == HttpStatusCode.Forbidden)
            throw new WindowsSourcePermissionException();
        if (status is HttpStatusCode.NotFound or HttpStatusCode.Gone)
            throw new WindowsSourceInactiveException();
        if (status is HttpStatusCode.Conflict or HttpStatusCode.UnprocessableEntity)
            throw new WindowsSourceConflictException();
        if (status == HttpStatusCode.BadRequest)
            throw new WindowsClientContractException();
    }
}
