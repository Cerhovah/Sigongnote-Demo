using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Sigongnote.Windows;

internal sealed record WindowsUploadTicket(Guid IngestionId, Uri Endpoint,
    string Signature, string Bucket, string ObjectName, int ChunkBytes,
    DateTimeOffset ExpiresAt);
internal sealed class WindowsStorageQuotaException : Exception;
internal sealed class WindowsRevisionConflictException : Exception;

/// <summary>Moves only a verified encrypted snapshot through prepare, TUS and receipt.</summary>
public sealed class WindowsUploadTransport : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly WindowsStateStore state;
    private readonly WindowsEncryptedCopyStore copies;
    private readonly WindowsSessionManager sessions;
    private readonly HttpClient http;
    private DateTimeOffset nextSetupAttempt;
    private DateTimeOffset nextReclaimAttempt;
    private DateTimeOffset nextQuotaAttempt;
    private Guid quotaUser;

    public WindowsUploadTransport(WindowsStateStore state,
        WindowsEncryptedCopyStore copies, WindowsSessionManager sessions,
        HttpMessageHandler? handler = null)
    {
        this.state = state;
        this.copies = copies;
        this.sessions = sessions;
        http = new HttpClient(handler ?? new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false,
        });
        http.Timeout = TimeSpan.FromMinutes(2);
    }

    public void Dispose() => http.Dispose();

    public async Task<bool> UploadOneAsync(CancellationToken cancellation = default)
    {
        var session = await sessions.CurrentAsync(cancellation);
        if(DateTimeOffset.UtcNow>=nextReclaimAttempt&&copies.StoredBytes>=1024L*1024*1024&&WindowsNetworkCost.Unmetered()) {
            nextReclaimAttempt=DateTimeOffset.UtcNow.AddMinutes(1);
            try { if(await WindowsCopyMaintenance.ReclaimAsync(state,copies,session,http,cancellation)>0)copies.StagePending(); }
            catch(Exception) when(!cancellation.IsCancellationRequested) { /* Keep managed copies when proof is unavailable. */ }
        }
        if(state.HasStorageQuotaPause(session.Principal)) {
            if(quotaUser==session.UserId&&DateTimeOffset.UtcNow<nextQuotaAttempt)return false;
            quotaUser=session.UserId;nextQuotaAttempt=DateTimeOffset.UtcNow.AddMinutes(1);
            using var quotaRequest=new HttpRequestMessage(HttpMethod.Get,new Uri(new Uri(session.ApiBaseUrl),"v1/capture-storage"));
            quotaRequest.Headers.Authorization=new AuthenticationHeaderValue("Bearer",session.AccessToken);
            quotaRequest.Headers.Add("X-Tenant-ID",session.TenantId.ToString("D"));
            using var quotaResponse=await SendAsync(quotaRequest,cancellation);
            if(!quotaResponse.IsSuccessStatusCode)return false;
            using var quota=JsonDocument.Parse(await quotaResponse.Content.ReadAsStringAsync(cancellation));
            var limit=quota.RootElement.GetProperty("limit_bytes").GetInt64();
            var used=quota.RootElement.GetProperty("used_bytes").GetInt64();
            var reserved=quota.RootElement.GetProperty("reserved_bytes").GetInt64();
            if(limit!=100_000_000_000L||used<0||reserved<0||used>limit||reserved>limit-used)return false;
            var available=limit-used-reserved;if(available<=0)return false;
            state.ResumeStorageQuota(session.Principal,available);
        }
        if(DateTimeOffset.UtcNow>=nextSetupAttempt && state.PendingFolderSetups(session.Principal).Count>0) {
            nextSetupAttempt=DateTimeOffset.UtcNow.AddSeconds(30);
            using var bounded=CancellationTokenSource.CreateLinkedTokenSource(cancellation);bounded.CancelAfter(TimeSpan.FromSeconds(8));
            try { await sessions.ResumeFolderSetupsAsync(state,bounded.Token); }
            catch(Exception) when(!cancellation.IsCancellationRequested) { /* Other connected folders keep uploading. */ }
        }
        var candidate = state.BeginUpload(session.Principal);
        if (candidate is null) return false;
        try {
            if(!state.FolderScopeAllows(candidate.Copy)) {
                TryFinish(candidate,"quarantined");return true;
            }
            FolderConnection verified;
            try { verified = await sessions.BindVerifiedFolderAsync(state,
                candidate.Copy.SourceId,candidate.ServerSourceId,cancellation); }
            catch (InvalidOperationException) when (!state.UploadStillCurrent(candidate)) {
                TryFinish(candidate,"permission_lost");
                return true;
            }
            if (verified.SourceGeneration != candidate.SourceGeneration ||
                !state.UploadStillCurrent(candidate)) {
                TryFinish(candidate,"permission_lost");
                return true;
            }
            if (!copies.VerifyCopy(candidate.Copy)) {
                state.FinishUpload(candidate.Copy.CaptureKey,"quarantined");
                return true;
            }
            var ticket = candidate.Ticket is null
                ? await PrepareAsync(session,candidate,cancellation)
                : ParseTicket(candidate.Ticket,session,candidate);
            if (ticket.ExpiresAt <= DateTimeOffset.UtcNow) {
                await RecoverOrAbandonAsync(candidate,ticket,cancellation);
                return true;
            }
            var tusUrl = candidate.TusUrl is null
                ? await CreateTusAsync(candidate,ticket,cancellation)
                : ValidateTusUrl(candidate.TusUrl,ticket.Endpoint);
            if (tusUrl is null) {
                await RecoverOrAbandonAsync(candidate,ticket,cancellation);
                return true;
            }
            var offset = await HeadOffsetAsync(candidate,ticket,tusUrl,cancellation);
            if (!offset.HasValue) {
                await RecoverOrAbandonAsync(candidate,ticket,cancellation);
                return true;
            }
            while (offset.Value < candidate.Copy.ByteSize) {
                cancellation.ThrowIfCancellationRequested();
                EnsureCurrent(candidate);
                var count = (int)Math.Min(ticket.ChunkBytes,
                    candidate.Copy.ByteSize - offset.Value);
                var plaintext = copies.ReadRange(candidate.Copy,offset.Value,count);
                try {
                    var next = await PatchAsync(tusUrl,ticket,offset.Value,plaintext,
                        cancellation);
                    if (!next.HasValue) {
                        await RecoverOrAbandonAsync(candidate,ticket,cancellation);
                        return true;
                    }
                    offset = next.Value;
                } finally { CryptographicOperations.ZeroMemory(plaintext); }
            }
            EnsureCurrent(candidate);
            var receipt = await CompleteAsync(candidate,ticket,cancellation);
            if (receipt is null) await AbandonAsync(candidate,ticket,cancellation);
            else state.FinishUpload(candidate.Copy.CaptureKey,"acknowledged",receipt);
        } catch (WindowsRevisionConflictException) {
            TryFinish(candidate,"revision_conflict");
        } catch (WindowsStorageQuotaException) {
            TryFinish(candidate,"storage_quota_paused");
            quotaUser=session.UserId;nextQuotaAttempt=DateTimeOffset.UtcNow.AddMinutes(1);
            return false;
        } catch (WindowsSourceInactiveException) {
            TryFinish(candidate,"permission_lost");
        } catch (WindowsSourcePermissionException) {
            TryFinish(candidate,"permission_lost");
        } catch (WindowsClientContractException) {
            TryFinish(candidate,"quarantined");
        } catch (CryptographicException) {
            TryFinish(candidate,"quarantined");
        } catch (Exception error) when (error is HttpRequestException or IOException or
            WindowsSessionUnavailableException or WindowsLoginRequiredException or
            TaskCanceledException) {
            if (cancellation.IsCancellationRequested) throw;
            TryFinish(candidate,"retry_wait");
        }
        return true;
    }

    private void TryFinish(UploadCandidate candidate, string result)
    {
        try { state.FinishUpload(candidate.Copy.CaptureKey,result,retryAfter:
            result == "retry_wait" ? DateTimeOffset.UtcNow.AddMinutes(1) : null); }
        catch (InvalidOperationException) {
            // A concurrent logout or consent-generation change already fenced this claim.
        }
    }

    private void EnsureCurrent(UploadCandidate candidate)
    {
        if (!state.UploadStillCurrent(candidate) || !state.FolderScopeAllows(candidate.Copy))
            throw new WindowsSourceInactiveException();
    }

    private async Task<WindowsUploadTicket> PrepareAsync(WindowsSession session,
        UploadCandidate candidate, CancellationToken cancellation)
    {
        EnsureCurrent(candidate);
        var body = new Dictionary<string,object> {
            ["client_capture_id"] = candidate.Copy.CaptureKey,
            ["sha256"] = candidate.Copy.ContentSha256.ToLowerInvariant(),
            ["byte_length"] = candidate.Copy.ByteSize,
            ["declared_mime"] = DeclaredMime(candidate.Copy.RelativePath),
            ["source_id"] = candidate.ServerSourceId,
            ["source_generation"] = candidate.SourceGeneration,
        };
        if(candidate.RevisionBase is {} prior){body["document_id"]=prior.DocumentId;body["predecessor_revision_id"]=prior.RevisionId;body["expected_version"]=prior.Version;}
        using var request = ApiRequest(HttpMethod.Post,session,"v1/ingestions",
            candidate.PrepareKey,body);
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Gone or
            HttpStatusCode.NotFound) throw new WindowsSourceInactiveException();
        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new WindowsLoginRequiredException();
        if(response.StatusCode==HttpStatusCode.Conflict) {
            using var error=JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
            if(error.RootElement.TryGetProperty("error",out var revisionError)&&revisionError.TryGetProperty("code",out var revisionCode)&&revisionCode.GetString()=="VERSION_CONFLICT")throw new WindowsRevisionConflictException();
            if(error.RootElement.TryGetProperty("error",out var detail)&&detail.TryGetProperty("code",out var code)&&code.GetString()=="STORAGE_QUOTA_EXCEEDED")throw new WindowsStorageQuotaException();
        }
        if (response.StatusCode is HttpStatusCode.Conflict or
            HttpStatusCode.UnprocessableEntity or HttpStatusCode.BadRequest)
            throw new WindowsClientContractException();
        if (response.StatusCode != HttpStatusCode.Created)
            throw new WindowsSessionUnavailableException();
        var raw = await response.Content.ReadAsStringAsync(cancellation);
        var ticket = ParseTicket(raw,session,candidate);
        state.SavePreparedUpload(candidate.Copy.CaptureKey,ticket.IngestionId,
            raw,ticket.ExpiresAt);
        return ticket;
    }

    private WindowsUploadTicket ParseTicket(string raw, WindowsSession session,
        UploadCandidate candidate)
    {
        try {
            using var document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            if (root.GetProperty("state").GetString() != "prepared")
                throw new WindowsClientContractException();
            var id = root.GetProperty("ingestion_id").GetGuid();
            if (id == Guid.Empty || (candidate.IngestionId.HasValue &&
                candidate.IngestionId != id)) throw new WindowsClientContractException();
            var expiry = root.GetProperty("expires_at").GetDateTimeOffset();
            var upload = root.GetProperty("upload");
            var endpoint = new Uri(upload.GetProperty("endpoint").GetString()!);
            var signed = new Uri(root.GetProperty("upload_url").GetString()!);
            var signature = upload.GetProperty("signature").GetString()!;
            if (!SameOrigin(endpoint,new Uri(session.SupabaseOrigin)) ||
                !SameOrigin(signed,endpoint) ||
                endpoint.AbsolutePath != "/storage/v1/upload/resumable" ||
                upload.GetProperty("protocol").GetString() != "tus" ||
                upload.GetProperty("bucket").GetString() != "sigongnote-originals" ||
                upload.GetProperty("object_name").GetString() !=
                    $"{session.TenantId:D}/{id:D}" ||
                upload.GetProperty("chunk_bytes").GetInt32() != 6 * 1024 * 1024 ||
                upload.GetProperty("upsert").GetBoolean() ||
                signature.Length is < 32 or > 4096 ||
                new UriQuery(signed.Query).Token != signature)
                throw new WindowsClientContractException();
            return new WindowsUploadTicket(id,endpoint,signature,
                "sigongnote-originals",$"{session.TenantId:D}/{id:D}",
                6 * 1024 * 1024,expiry);
        } catch (Exception error) when (error is JsonException or FormatException or
            InvalidOperationException or UriFormatException or ArgumentNullException) {
            throw new WindowsClientContractException();
        }
    }

    private async Task<Uri?> CreateTusAsync(UploadCandidate candidate,
        WindowsUploadTicket ticket, CancellationToken cancellation)
    {
        EnsureCurrent(candidate);
        using var request = new HttpRequestMessage(HttpMethod.Post,ticket.Endpoint) {
            Content = new ByteArrayContent([]),
        };
        await AuthorizeTusAsync(request,ticket,cancellation);
        request.Headers.TryAddWithoutValidation("Upload-Length",
            candidate.Copy.ByteSize.ToString(System.Globalization.CultureInfo.InvariantCulture));
        request.Headers.TryAddWithoutValidation("Upload-Metadata",string.Join(",",new[] {
            Metadata("bucketName",ticket.Bucket),
            Metadata("objectName",ticket.ObjectName),
            Metadata("contentType",DeclaredMime(candidate.Copy.RelativePath)),
        }));
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
            return null;
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode != HttpStatusCode.Created ||
            response.Headers.Location is null) throw new WindowsSessionUnavailableException();
        var url = ValidateTusUrl(new Uri(ticket.Endpoint,response.Headers.Location)
            .ToString(),ticket.Endpoint);
        state.SaveTusUrl(candidate.Copy.CaptureKey,ticket.IngestionId,url.ToString());
        return url;
    }

    private async Task<long?> HeadOffsetAsync(UploadCandidate candidate,
        WindowsUploadTicket ticket, Uri tusUrl, CancellationToken cancellation)
    {
        EnsureCurrent(candidate);
        using var request = new HttpRequestMessage(HttpMethod.Head,tusUrl);
        await AuthorizeTusAsync(request,ticket,cancellation);
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
            return null;
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode != HttpStatusCode.OK &&
            response.StatusCode != HttpStatusCode.NoContent)
            throw new WindowsSessionUnavailableException();
        var offset = Offset(response);
        if (offset < 0 || offset > candidate.Copy.ByteSize)
            throw new WindowsClientContractException();
        return offset;
    }

    private async Task<long?> PatchAsync(Uri url, WindowsUploadTicket ticket,
        long offset, byte[] bytes, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch,url) {
            Content = new ByteArrayContent(bytes),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(
            "application/offset+octet-stream");
        await AuthorizeTusAsync(request,ticket,cancellation);
        request.Headers.TryAddWithoutValidation("Upload-Offset",
            offset.ToString(System.Globalization.CultureInfo.InvariantCulture));
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
            return null;
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode == HttpStatusCode.Conflict)
            throw new WindowsSessionUnavailableException();
        if (response.StatusCode != HttpStatusCode.NoContent)
            throw new WindowsSessionUnavailableException();
        var next = Offset(response);
        if (next != offset + bytes.Length) throw new WindowsClientContractException();
        return next;
    }

    private async Task<string?> CompleteAsync(UploadCandidate candidate,
        WindowsUploadTicket ticket, CancellationToken cancellation)
    {
        EnsureCurrent(candidate);
        var session = await sessions.CurrentAsync(cancellation);
        using var request = ApiRequest(HttpMethod.Post,session,
            $"v1/ingestions/{ticket.IngestionId:D}/complete",candidate.CompleteKey,
            new { sha256=candidate.Copy.ContentSha256.ToLowerInvariant(),
                byte_length=candidate.Copy.ByteSize });
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode == HttpStatusCode.Gone) return null;
        if (response.StatusCode == HttpStatusCode.ServiceUnavailable)
            throw new WindowsSessionUnavailableException();
        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode == HttpStatusCode.Forbidden)
            throw new WindowsSourcePermissionException();
        if(response.StatusCode==HttpStatusCode.Conflict){
            using var error=JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
            if(error.RootElement.GetProperty("error").GetProperty("code").GetString()=="VERSION_CONFLICT")throw new WindowsRevisionConflictException();
        }
        if (response.StatusCode != HttpStatusCode.OK)
            throw new WindowsClientContractException();
        var raw = await response.Content.ReadAsStringAsync(cancellation);
        try {
            using var document = JsonDocument.Parse(raw);
            var body = document.RootElement;
            if (body.GetProperty("ingestion_id").GetGuid() != ticket.IngestionId ||
                body.GetProperty("state").GetString() is not ("queued" or "verified") ||
                body.GetProperty("blob_id").GetGuid() == Guid.Empty ||
                body.GetProperty("document_id").GetGuid() == Guid.Empty ||
                body.GetProperty("revision_id").GetGuid() == Guid.Empty)
                throw new WindowsClientContractException();
            return raw;
        } catch (Exception error) when (error is JsonException or FormatException or
            InvalidOperationException) { throw new WindowsClientContractException(); }
    }

    private async Task RecoverOrAbandonAsync(UploadCandidate candidate,
        WindowsUploadTicket ticket, CancellationToken cancellation)
    {
        // A 503 cannot distinguish a missing object from a transient verify error.
        // Keep the intent and retry; only the server's 410 permits abandonment.
        var receipt = await CompleteAsync(candidate,ticket,cancellation);
        if (receipt is not null) {
            state.FinishUpload(candidate.Copy.CaptureKey,"acknowledged",receipt);
            return;
        }
        await AbandonAsync(candidate,ticket,cancellation);
    }

    private async Task AbandonAsync(UploadCandidate candidate,
        WindowsUploadTicket ticket, CancellationToken cancellation)
    {
        EnsureCurrent(candidate);
        var session = await sessions.CurrentAsync(cancellation);
        using var request = ApiRequest(HttpMethod.Post,session,
            $"v1/ingestions/{ticket.IngestionId:D}/abandon",Guid.NewGuid(),
            new { sha256=candidate.Copy.ContentSha256.ToLowerInvariant(),
                byte_length=candidate.Copy.ByteSize });
        using var response = await SendAsync(request,cancellation);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new WindowsLoginRequiredException();
        if (response.StatusCode != HttpStatusCode.OK)
            throw new WindowsSessionUnavailableException();
        try {
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(
                cancellation));
            var body = document.RootElement;
            if (body.GetProperty("ingestion_id").GetGuid() != ticket.IngestionId ||
                body.GetProperty("state").GetString() != "rejected")
                throw new WindowsClientContractException();
            var reason = body.GetProperty("reason").GetString();
            if (reason is "client_abandoned" or "expired") {
                state.ResetAfterServerRejection(candidate.Copy.CaptureKey,
                    ticket.IngestionId,DateTimeOffset.UtcNow.AddSeconds(10));
            } else if (reason == "source_revoked") {
                state.FinishUpload(candidate.Copy.CaptureKey,"permission_lost");
            } else {
                state.FinishUpload(candidate.Copy.CaptureKey,"quarantined");
            }
        } catch (Exception error) when (error is JsonException or FormatException or
            InvalidOperationException) { throw new WindowsClientContractException(); }
    }

    private async Task AuthorizeTusAsync(HttpRequestMessage request,
        WindowsUploadTicket ticket, CancellationToken cancellation)
    {
        var session = await sessions.CurrentAsync(cancellation);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",
            session.AccessToken);
        request.Headers.TryAddWithoutValidation("Tus-Resumable","1.0.0");
        request.Headers.TryAddWithoutValidation("x-signature",ticket.Signature);
    }

    private static HttpRequestMessage ApiRequest(HttpMethod method,WindowsSession session,
        string path, Guid key, object body)
    {
        var request = new HttpRequestMessage(method,
            new Uri(new Uri(session.ApiBaseUrl),path)) {
            Content = JsonContent.Create(body,options:Json),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",
            session.AccessToken);
        request.Headers.TryAddWithoutValidation("X-Tenant-Id",session.TenantId.ToString("D"));
        request.Headers.TryAddWithoutValidation("Idempotency-Key",key.ToString("D"));
        return request;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
        CancellationToken cancellation)
    {
        try { return await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,
            cancellation); }
        catch (TaskCanceledException) when (!cancellation.IsCancellationRequested) {
            throw new WindowsSessionUnavailableException();
        }
    }

    private static string Metadata(string key,string value) => key + " " +
        Convert.ToBase64String(Encoding.UTF8.GetBytes(value));

    private static long Offset(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("Upload-Offset",out var values) ||
            !long.TryParse(values.SingleOrDefault(),out var offset))
            throw new WindowsClientContractException();
        return offset;
    }

    private static Uri ValidateTusUrl(string value,Uri endpoint)
    {
        if (!Uri.TryCreate(value,UriKind.Absolute,out var url) ||
            !SameOrigin(url,endpoint) || !url.AbsolutePath.StartsWith(
                "/storage/v1/upload/resumable/",StringComparison.Ordinal) ||
            url.UserInfo.Length != 0 || url.Fragment.Length != 0)
            throw new WindowsClientContractException();
        return url;
    }

    private static bool SameOrigin(Uri left,Uri right) =>
        left.Scheme == right.Scheme && left.Host == right.Host && left.Port == right.Port;

    private static string DeclaredMime(string path) => Path.GetExtension(path).ToLowerInvariant() switch {
        ".pdf" => "application/pdf", ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls" => "application/vnd.ms-excel",
        ".hwpx" => "application/zip", ".hwp" => "application/x-ole-storage",
        ".txt" or ".csv" or ".tsv" or ".md" => "text/plain",
        ".mp4" or ".mov" or ".3gp" => "video/mp4", ".webm" => "video/webm",
        ".avi" => "video/x-msvideo", ".mkv" => "video/x-matroska",
        ".mp3" => "audio/mpeg", ".m4a" => "audio/mp4", ".wav" => "audio/wav",
        ".aac" => "audio/aac", ".ogg" => "audio/ogg", ".flac" => "audio/flac", ".amr" => "audio/amr",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    };

    private sealed class UriQuery(string query)
    {
        public string? Token => query.TrimStart('?').Split('&',StringSplitOptions.RemoveEmptyEntries)
            .Select(part => part.Split('=',2))
            .Where(parts => parts[0] == "token" && parts.Length == 2)
            .Select(parts => Uri.UnescapeDataString(parts[1])).FirstOrDefault();
    }
}
