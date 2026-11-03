using System.Text.Json;
namespace Sigongnote.Windows;

public sealed record WindowsRevisionConflict(string CaptureKey,string Name,WindowsRevisionBase Base);
public sealed partial class WindowsStateStore {
    public IReadOnlyList<WindowsRevisionConflict> RevisionConflicts(WindowsPrincipal principal){
        using var db=Open();using var c=db.CreateCommand();c.CommandText="""
            SELECT q.capture_key,o.relative_path_protected,a.revision_base_protected FROM capture_queue q
            JOIN upload_attempts a ON a.capture_key=q.capture_key JOIN folder_sources s ON s.source_id=q.source_id
            JOIN file_observations o ON o.source_id=q.source_id AND o.path_token=q.path_token
            WHERE q.state='revision_conflict' AND q.tenant_id=$tenant AND q.user_id=$user AND q.device_id=$device
              AND s.tenant_id=$tenant AND s.user_id=$user AND s.device_id=$device AND s.state='selected'
              AND s.source_generation=a.source_generation ORDER BY q.rowid LIMIT 20;
            """;
        c.Parameters.AddWithValue("$tenant",principal.TenantId.ToString());c.Parameters.AddWithValue("$user",principal.UserId.ToString());c.Parameters.AddWithValue("$device",principal.DeviceId.ToString());
        using var r=c.ExecuteReader();var result=new List<WindowsRevisionConflict>();
        while(r.Read())if(!r.IsDBNull(2))result.Add(new(r.GetString(0),secrets.Unprotect((byte[])r[1]),JsonSerializer.Deserialize<WindowsRevisionBase>(secrets.Unprotect((byte[])r[2]))!));return result;
    }
    /// <summary>Only a user's explicit confirmation can rebase a rejected copy. No bytes are changed.</summary>
    public void ResumeRevisionConflict(WindowsPrincipal principal,WindowsRevisionConflict expected,WindowsRevisionBase latest){
        if(latest.DocumentId!=expected.Base.DocumentId||latest.Version<expected.Base.Version||latest.RevisionId==Guid.Empty)throw new InvalidOperationException("Revision scope changed");
        using var db=Open();using var tx=db.BeginTransaction(deferred:false);using var c=db.CreateCommand();c.Transaction=tx;
        c.CommandText="""
            SELECT a.revision_base_protected FROM capture_queue q JOIN upload_attempts a ON a.capture_key=q.capture_key
            JOIN folder_sources s ON s.source_id=q.source_id WHERE q.capture_key=$key AND q.state='revision_conflict'
              AND q.tenant_id=$tenant AND q.user_id=$user AND q.device_id=$device
              AND s.tenant_id=$tenant AND s.user_id=$user AND s.device_id=$device AND s.state='selected' AND s.source_generation=a.source_generation;
            """;
        c.Parameters.AddWithValue("$key",expected.CaptureKey);c.Parameters.AddWithValue("$tenant",principal.TenantId.ToString());c.Parameters.AddWithValue("$user",principal.UserId.ToString());c.Parameters.AddWithValue("$device",principal.DeviceId.ToString());
        if(c.ExecuteScalar() is not byte[] bytes||JsonSerializer.Deserialize<WindowsRevisionBase>(secrets.Unprotect(bytes))!=expected.Base)throw new InvalidOperationException("Conflict changed");
        c.CommandText="""
            UPDATE upload_attempts SET revision_base_protected=$base,prepare_key=$prepare,complete_key=$complete,
              ingestion_id=NULL,ticket_protected=NULL,tus_url_protected=NULL,expires_at=NULL,retry_after=NULL WHERE capture_key=$key;
            UPDATE capture_queue SET state='ready' WHERE capture_key=$key;
            """;
        c.Parameters.AddWithValue("$base",secrets.Protect(JsonSerializer.Serialize(latest)));c.Parameters.AddWithValue("$prepare",Guid.NewGuid().ToString());c.Parameters.AddWithValue("$complete",Guid.NewGuid().ToString());c.ExecuteNonQuery();tx.Commit();
    }
}

public static class WindowsRevisionResolution {
    public static async Task<WindowsRevisionBase> LatestAsync(WindowsSessionManager sessions,WindowsSession session,WindowsRevisionConflict conflict,CancellationToken token=default){
        async Task<JsonDocument> Read(Guid id){using var q=JsonDocument.Parse(JsonSerializer.Serialize(new{route="materials.detail",id}));return JsonDocument.Parse(await sessions.WorkRequestAsync(q.RootElement,token,session));}
        using var prior=await Read(conflict.Base.RevisionId);var id=prior.RootElement.GetProperty("revision").GetProperty("latest_revision_id").GetGuid();
        using var detail=await Read(id);var r=detail.RootElement.GetProperty("revision");
        var latest=new WindowsRevisionBase(r.GetProperty("document_id").GetGuid(),r.GetProperty("id").GetGuid(),r.GetProperty("revision_number").GetInt32());
        if(latest.DocumentId!=conflict.Base.DocumentId||latest.RevisionId!=id||latest.Version<conflict.Base.Version)throw new WindowsClientContractException();return latest;
    }
}
