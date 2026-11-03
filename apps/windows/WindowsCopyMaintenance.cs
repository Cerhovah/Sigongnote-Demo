using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

namespace Sigongnote.Windows;

public sealed record ReclaimCandidate(CopyCandidate Copy,Guid IngestionId,Guid RevisionId,int Generation);

public sealed partial class WindowsStateStore
{
    public bool HasStorageQuotaPause(WindowsPrincipal principal)
    {
        using var db=Open();using var command=db.CreateCommand();
        command.CommandText="SELECT EXISTS(SELECT 1 FROM capture_queue WHERE user_id=$user AND device_id=$device AND state='storage_quota_paused')";
        command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        return Convert.ToInt32(command.ExecuteScalar())!=0;
    }

    public int ResumeStorageQuota(WindowsPrincipal principal,long availableBytes)
    {
        if(availableBytes<=0)return 0;
        using var db=Open();using var command=db.CreateCommand();
        command.CommandText="""
            UPDATE capture_queue SET state='ready',updated_at=$now
            WHERE state='storage_quota_paused' AND byte_size<=$available
              AND tenant_id=$tenant AND user_id=$user AND device_id=$device
              AND EXISTS(SELECT 1 FROM folder_sources s JOIN upload_attempts a ON a.capture_key=capture_queue.capture_key
                WHERE s.source_id=capture_queue.source_id AND s.state='selected' AND s.source_generation=a.source_generation
                  AND s.tenant_id=$tenant AND s.user_id=$user AND s.device_id=$device);
            """;
        command.Parameters.AddWithValue("$available",availableBytes);command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        return command.ExecuteNonQuery();
    }

    public int StorageQuotaPausedCount()
    {
        using var db=Open();using var command=db.CreateCommand();command.CommandText="SELECT COUNT(*) FROM capture_queue WHERE state='storage_quota_paused'";return Convert.ToInt32(command.ExecuteScalar());
    }
    public IReadOnlyList<ReclaimCandidate> ReclaimCandidates(WindowsPrincipal principal)
    {
        using var db=Open();using var command=db.CreateCommand();
        command.CommandText="""
            SELECT q.capture_key,q.source_id,q.content_sha256,q.byte_size,a.ingestion_id,a.receipt_protected,a.source_generation
            FROM capture_queue q JOIN upload_attempts a ON a.capture_key=q.capture_key
            JOIN folder_sources s ON s.source_id=q.source_id
            LEFT JOIN copy_retention r ON r.capture_key=q.capture_key
            LEFT JOIN copy_reclaim_checks c ON c.capture_key=q.capture_key
            WHERE q.state='acknowledged' AND q.tenant_id=$tenant AND q.user_id=$user AND q.device_id=$device
              AND s.state='selected' AND s.source_generation=a.source_generation
              AND a.receipt_protected IS NOT NULL AND COALESCE(r.hold,0)=0 AND r.reclaimed_at IS NULL
              AND (c.next_at IS NULL OR c.next_at<=$now)
            ORDER BY q.updated_at,q.capture_key LIMIT 4;
            """;
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));
        command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));
        command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        using var reader=command.ExecuteReader();var result=new List<ReclaimCandidate>();
        while(reader.Read()) {
            try {
                using var receipt=JsonDocument.Parse(secrets.Unprotect((byte[])reader[5]));
                result.Add(new(new(reader.GetString(0),reader.GetString(1),"",reader.GetString(2),reader.GetInt64(3),0),
                    Guid.Parse(reader.GetString(4)),receipt.RootElement.GetProperty("revision_id").GetGuid(),reader.GetInt32(6)));
            } catch(Exception error) when(error is CryptographicException or JsonException or FormatException or InvalidOperationException) { }
        }
        return result;
    }

    public void DeferReclaim(string captureKey)
    {
        using var db=Open();using var command=db.CreateCommand();command.CommandText="INSERT INTO copy_reclaim_checks(capture_key,next_at) VALUES($id,$at) ON CONFLICT(capture_key) DO UPDATE SET next_at=excluded.next_at";
        command.Parameters.AddWithValue("$id",captureKey);command.Parameters.AddWithValue("$at",DateTimeOffset.UtcNow.AddMinutes(10).ToString("O"));command.ExecuteNonQuery();
    }

    public bool ReclaimVerifiedCopy(ReclaimCandidate item,WindowsPrincipal principal,DateTimeOffset verifiedAt,Action deleteManagedCopy)
    {
        if(DateTimeOffset.UtcNow-verifiedAt>TimeSpan.FromSeconds(60)||verifiedAt>DateTimeOffset.UtcNow.AddSeconds(5))return false;
        using var db=Open();using var tx=db.BeginTransaction(deferred:false);using var command=db.CreateCommand();command.Transaction=tx;
        command.CommandText="""
            SELECT COUNT(*) FROM capture_queue q JOIN folder_sources s ON s.source_id=q.source_id
            LEFT JOIN copy_retention r ON r.capture_key=q.capture_key
            WHERE q.capture_key=$id AND q.state='acknowledged' AND q.content_sha256=$hash AND q.byte_size=$bytes
             AND q.tenant_id=$tenant AND q.user_id=$user AND q.device_id=$device AND s.state='selected'
             AND s.source_generation=$generation AND COALESCE(r.hold,0)=0 AND r.reclaimed_at IS NULL;
            """;
        command.Parameters.AddWithValue("$id",item.Copy.CaptureKey);command.Parameters.AddWithValue("$hash",item.Copy.ContentSha256);
        command.Parameters.AddWithValue("$bytes",item.Copy.ByteSize);command.Parameters.AddWithValue("$generation",item.Generation);
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        if(Convert.ToInt32(command.ExecuteScalar())!=1)return false;
        deleteManagedCopy();
        command.CommandText="INSERT INTO copy_retention(capture_key,hold,reclaimed_at) VALUES($id,0,$at) ON CONFLICT(capture_key) DO UPDATE SET reclaimed_at=excluded.reclaimed_at";
        command.Parameters.AddWithValue("$at",verifiedAt.ToString("O"));command.ExecuteNonQuery();tx.Commit();return true;
    }
}

public static class WindowsCopyMaintenance
{
    public static async Task<int> ReclaimAsync(WindowsStateStore state,WindowsEncryptedCopyStore copies,WindowsSession session,HttpClient http,CancellationToken cancellation)
    {
        var count=0;
        foreach(var item in state.ReclaimCandidates(session.Principal)) {
            if(copies.StoredBytes<1024L*1024*1024)break;
            state.DeferReclaim(item.Copy.CaptureKey);
            var verifiedAt=await VerifyRecoveryAsync(item,session,http,cancellation);
            if(verifiedAt is not null&&state.ReclaimVerifiedCopy(item,session.Principal,verifiedAt.Value,()=>copies.DeleteManagedCopy(item.Copy.CaptureKey)))count++;
        }
        return count;
    }

    public static async Task<DateTimeOffset?> VerifyRecoveryAsync(ReclaimCandidate item,WindowsSession session,HttpClient http,CancellationToken cancellation)
    {
        using var request=new HttpRequestMessage(HttpMethod.Post,new Uri(new Uri(session.ApiBaseUrl),$"v1/ingestions/{item.IngestionId:D}/durability"));
        request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",session.AccessToken);request.Headers.Add("X-Tenant-ID",session.TenantId.ToString("D"));
        request.Content=JsonContent.Create(new {sha256=item.Copy.ContentSha256.ToLowerInvariant(),byte_length=item.Copy.ByteSize});
        using var response=await http.SendAsync(request,cancellation);if(!response.IsSuccessStatusCode)return null;
        using var doc=JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));var p=doc.RootElement;
        if(p.GetProperty("state").GetString()!="recoverable"||p.GetProperty("ingestion_id").GetGuid()!=item.IngestionId||p.GetProperty("revision_id").GetGuid()!=item.RevisionId||p.GetProperty("source_generation").GetInt32()!=item.Generation||p.GetProperty("byte_length").GetInt64()!=item.Copy.ByteSize||!string.Equals(p.GetProperty("sha256").GetString(),item.Copy.ContentSha256,StringComparison.OrdinalIgnoreCase))return null;
        var url=new Uri(p.GetProperty("restore_url").GetString()!);var origin=new Uri(session.SupabaseOrigin);
        if(url.Scheme!=origin.Scheme||url.Host!=origin.Host||url.Port!=origin.Port||url.UserInfo.Length!=0||!url.AbsolutePath.StartsWith("/storage/v1/object/sign/sigongnote-originals/"+session.TenantId.ToString("D")+"/",StringComparison.Ordinal))return null;
        _=p.GetProperty("verified_at").GetDateTimeOffset(); // Server wall clock is informational only.
        if(!await DownloadMatchesAsync(http,url,item.Copy.ContentSha256,item.Copy.ByteSize,cancellation))return null;
        return DateTimeOffset.UtcNow;
    }

    public static async Task<bool> DownloadMatchesAsync(HttpClient http,Uri url,string sha256,long length,CancellationToken cancellation)
    {
        using var response=await http.GetAsync(url,HttpCompletionOption.ResponseHeadersRead,cancellation);if(!response.IsSuccessStatusCode)return false;
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);await using var stream=await response.Content.ReadAsStreamAsync(cancellation);
        var buffer=new byte[1024*1024];long bytes=0;int read;
        while((read=await stream.ReadAsync(buffer,cancellation))>0){bytes+=read;if(bytes>length)return false;hash.AppendData(buffer,0,read);}
        return bytes==length&&string.Equals(Convert.ToHexString(hash.GetHashAndReset()),sha256,StringComparison.OrdinalIgnoreCase);
    }
}
