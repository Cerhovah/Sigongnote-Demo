using System.Net;
using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Sigongnote.Contracts;

namespace Sigongnote.Windows;

public sealed record WindowsProjectChoice(string id,string display_name)
{
    public override string ToString()=>display_name;
}
public sealed record WindowsProjectList(WindowsProjectChoice[] projects);
public sealed record WindowsFolderSelection(string Kind,Guid? ProjectId,string? NewProjectName,bool Common,bool RecentOnly=false,bool DownloadCopies=false,bool PlaintextCopies=false,bool Unassigned=false,string? DisplayName=null,bool ManagedRoot=false,bool NewOnly=false,bool JournalCopies=false);
public sealed record WindowsSourceSetup(string LocalSourceId,Guid Key,WindowsPrincipal Principal,
    CapturePolicy Policy,WindowsFolderSelection Selection,string Fingerprint,string? Since,
    Guid? ProjectId=null,Guid? ServerSourceId=null,int? Generation=null);

public static class WindowsCapturePolicy
{
    public static bool Same(object? first,object? second)=>
        first is null || second is null ? first is null && second is null :
        JsonElement.DeepEquals(JsonSerializer.SerializeToElement(first),JsonSerializer.SerializeToElement(second));

    public static CapturePolicy Snapshot(CapturePolicy policy)=>
        JsonSerializer.Deserialize<CapturePolicy>(JsonSerializer.Serialize(policy)) ?? throw new WindowsClientContractException();

    public static CaptureSourceCreateRequestProcessingPolicy SourceRequestSnapshot(CapturePolicy policy)=>
        JsonSerializer.Deserialize<CaptureSourceCreateRequestProcessingPolicy>(JsonSerializer.Serialize(policy)) ?? throw new WindowsClientContractException();

    public static string Describe(CapturePolicy policy)
    {
        static string Provider(string provider)=>provider switch {"anthropic"=>"Anthropic","openai"=>"OpenAI","clova_speech"=>"CLOVA Speech",_=>provider};
        var description=policy.external_processing
            ? $"자료 처리: {Provider(policy.provider)} ({policy.processing_location}) · 업무 기록 정리\n보관: {policy.storage_location} · {policy.retention}"
            : $"보관: {policy.storage_location} · {policy.retention}";
        foreach(var processor in policy.processors??[])
            description+=$"\n장기 녹음 전사: {Provider(processor.provider)} ({processor.processing_location})\n보관: {processor.storage_location} · {processor.retention}";
        return description;
    }
}

public sealed partial class WindowsStateStore
{
    public WindowsSourceSetup? FolderSetup(string sourceId)
    {
        using var db=Open();using var command=db.CreateCommand();
        command.CommandText="SELECT payload_protected FROM folder_setups WHERE source_id=$id";
        command.Parameters.AddWithValue("$id",sourceId);
        return command.ExecuteScalar() is byte[] bytes ? JsonSerializer.Deserialize<WindowsSourceSetup>(secrets.Unprotect(bytes)) : null;
    }
    public string? FolderSetupState(string sourceId)
    {
        using var db=Open();using var command=db.CreateCommand();
        command.CommandText="SELECT state FROM folder_setups WHERE source_id=$id";command.Parameters.AddWithValue("$id",sourceId);
        return command.ExecuteScalar() as string;
    }
    public void SaveFolderSetup(WindowsSourceSetup setup,string status="pending",string? error=null,Guid? replaceKey=null)
    {
        using var db=Open();using var transaction=db.BeginTransaction();using var command=db.CreateCommand();command.Transaction=transaction;
        if(replaceKey.HasValue) {
            command.CommandText="""
                DELETE FROM folder_setups WHERE source_id=$id AND setup_key=$old AND state!='ready'
                AND EXISTS(SELECT 1 FROM folder_sources s WHERE s.source_id=$id AND s.state='selected'
                    AND s.server_source_id IS NULL AND (s.tenant_id IS NULL OR (s.tenant_id=$tenant AND s.user_id=$user AND s.device_id=$device)));
                """;
            command.Parameters.AddWithValue("$id",setup.LocalSourceId);command.Parameters.AddWithValue("$old",replaceKey.Value.ToString("D"));
            command.Parameters.AddWithValue("$tenant",setup.Principal.TenantId.ToString("D"));command.Parameters.AddWithValue("$user",setup.Principal.UserId.ToString("D"));command.Parameters.AddWithValue("$device",setup.Principal.DeviceId.ToString("D"));
            if(command.ExecuteNonQuery()!=1)throw new WindowsSourceConflictException();command.Parameters.Clear();
        }
        command.CommandText="""
            INSERT INTO folder_setups(source_id,setup_key,tenant_id,user_id,device_id,payload_protected,state,error)
            SELECT source_id,$key,$tenant,$user,$device,$payload,$state,$error FROM folder_sources WHERE source_id=$id AND state='selected' AND (tenant_id IS NULL OR (tenant_id=$tenant AND user_id=$user AND device_id=$device))
            ON CONFLICT(source_id) DO UPDATE SET payload_protected=excluded.payload_protected,state=excluded.state,error=excluded.error
            WHERE folder_setups.setup_key=excluded.setup_key AND folder_setups.tenant_id=excluded.tenant_id
              AND folder_setups.user_id=excluded.user_id AND folder_setups.device_id=excluded.device_id;
            """;
        command.Parameters.AddWithValue("$id",setup.LocalSourceId);command.Parameters.AddWithValue("$key",setup.Key.ToString("D"));
        command.Parameters.AddWithValue("$tenant",setup.Principal.TenantId.ToString("D"));command.Parameters.AddWithValue("$user",setup.Principal.UserId.ToString("D"));
        command.Parameters.AddWithValue("$device",setup.Principal.DeviceId.ToString("D"));command.Parameters.AddWithValue("$payload",secrets.Protect(JsonSerializer.Serialize(setup)));
        command.Parameters.AddWithValue("$state",status);command.Parameters.AddWithValue("$error",(object?)error ?? DBNull.Value);
        if(command.ExecuteNonQuery()!=1)throw new WindowsSourceInactiveException();transaction.Commit();
    }
    public IReadOnlyList<string> PendingFolderSetups(WindowsPrincipal principal)
    {
        using var db=Open();using var command=db.CreateCommand();
        command.CommandText="""
            SELECT f.source_id FROM folder_setups f JOIN folder_sources s ON s.source_id=f.source_id
            WHERE f.state='pending' AND s.state='selected' AND f.tenant_id=$tenant AND f.user_id=$user AND f.device_id=$device LIMIT 1;
            """;
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        using var reader=command.ExecuteReader();var result=new List<string>();while(reader.Read())result.Add(reader.GetString(0));return result;
    }
    public static string? KnownFolderKind(string path)
    {
        var segments=path.Split(['\\','/'],StringSplitOptions.RemoveEmptyEntries);
        if(segments.Any(part=>new[]{"recordings","call recordings","call recording","통화 녹음","통화녹음"}.Contains(part,StringComparer.OrdinalIgnoreCase)))return "call_recording";
        if(segments.Any(part=>new[]{"dcim","camera","camera roll"}.Contains(part,StringComparer.OrdinalIgnoreCase)))return "photos";
        return null;
    }
    public bool FolderScopeAllows(CopyCandidate copy)
    {
        return !IsOwnedByChild(copy.SourceId,copy.RelativePath) && FolderScopeAllows(FolderSetup(copy.SourceId),copy.RelativePath,copy.WriteTicks);
    }
    public static bool FolderScopeAllows(WindowsSourceSetup? setup,string relativePath,long writeTicks)
    {
        if(setup is null)return true;
        if(!setup.Selection.NewOnly && setup.Since is not null && (!DateTimeOffset.TryParse(setup.Since,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal,out var since) || writeTicks<since.UtcDateTime.Ticks))return false;
        var known=KnownFolderKind(relativePath);
        if(known is not null && known!=setup.Selection.Kind && !(setup.Selection.ManagedRoot && known=="photos"))return false;
        var ext=Path.GetExtension(relativePath).ToLowerInvariant();
        return setup.Selection.Kind switch {
            "photos"=>new[]{".jpg",".jpeg",".png",".webp",".heic"}.Contains(ext),
            "call_recording"=>new[]{".mp3",".m4a",".wav",".aac",".ogg",".flac",".amr"}.Contains(ext),
            "folder"=>!new[]{".mp3",".m4a",".wav",".aac",".ogg",".flac",".amr"}.Contains(ext),_=>false,
        };
    }
}

public sealed partial class WindowsSessionManager
{
    private static readonly SemaphoreSlim SetupGate=new(1,1);
    public async Task<FolderConnection> ConnectScopedFolderAsync(WindowsStateStore state,WindowsDeviceKeyStore keys,
        string id,WindowsUploadDestination approved,CancellationToken cancellation=default)
    {
        await SetupGate.WaitAsync(cancellation);
        try {
            var session=await CurrentAsync(cancellation);
            if(!approved.Matches(session) || approved.Policy is null || approved.Selection is null)throw new WindowsLoginRequiredException();
            ValidatePolicy(approved.Policy);
            var selection=approved.Selection;
            if((selection.ManagedRoot && (selection.Kind!="folder" || !selection.Unassigned)) || selection.Kind is not ("folder" or "photos" or "call_recording") ||
                (!selection.Common && !selection.Unassigned && selection.ProjectId is null && (string.IsNullOrWhiteSpace(selection.NewProjectName) || selection.NewProjectName.Trim().Length>80)) ||
                selection.ProjectId==Guid.Empty ||
                ((selection.Common || selection.Unassigned) && (selection.ProjectId is not null || selection.NewProjectName is not null)) ||
                (selection.Common && selection.Unassigned))throw new WindowsClientContractException();
            var folder=state.Folders().Single(item=>item.Id==id);
            if(folder.State!="selected" || folder.RelativePath is null ||
                (folder.TenantId.HasValue && new WindowsPrincipal(folder.TenantId.Value,folder.UserId!.Value,folder.DeviceId!.Value)!=session.Principal))throw new WindowsSourceInactiveException();
            var known=WindowsStateStore.KnownFolderKind(folder.RootPath ?? folder.RelativePath);
            if(known is not null && known!=selection.Kind && !(selection.ManagedRoot && known=="photos"))throw new WindowsClientContractException();
            var setup=state.FolderSetup(id);
            var replace=setup is not null && (state.FolderSetupState(id)=="needs_attention" || setup.Principal!=session.Principal || !WindowsCapturePolicy.Same(setup.Policy,approved.Policy) || setup.Selection!=selection);
            if(setup is null || replace) {
                if(folder.ServerSourceId.HasValue || state.FolderSetupState(id)=="ready")throw new WindowsSourceConflictException();
                var oldKey=setup?.Key;var newKey=Guid.NewGuid();
                var reusableProject=setup?.Principal==session.Principal && setup.Selection==selection ? setup.ProjectId : null;
                var key=keys.GetOrCreate(session.TenantId,session.UserId);if(key.DeviceId!=session.DeviceId)throw new WindowsLoginRequiredException();
                var bytes=Convert.FromBase64String(key.PrivateKeyPkcs8);string fingerprint;
                try { fingerprint=Convert.ToHexString(HMACSHA256.HashData(bytes,Encoding.UTF8.GetBytes($"folder:v2:{selection.Kind}:{folder.VolumeId}:{folder.VolumeSerial}:{folder.RelativePath}:{newKey:D}"))).ToLowerInvariant(); }
                finally { CryptographicOperations.ZeroMemory(bytes); }
                setup=new(id,newKey,session.Principal,WindowsCapturePolicy.Snapshot(approved.Policy),selection,fingerprint,
                    selection.NewOnly ? state.ScopeBaseline(id).StartedUtc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture) : selection.RecentOnly ? DateTime.UtcNow.AddDays(-30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture) : null,selection.ProjectId ?? reusableProject);
                state.SaveFolderSetup(setup,replaceKey:oldKey);
            } else if(setup.Principal!=session.Principal || !WindowsCapturePolicy.Same(setup.Policy,approved.Policy) || setup.Selection!=selection)throw new WindowsSourceConflictException();
            return await ResumeScopedFolderAsync(state,setup,session,cancellation);
        } finally { SetupGate.Release(); }
    }
    public async Task ResumeFolderSetupsAsync(WindowsStateStore state,CancellationToken cancellation=default)
    {
        if(!await SetupGate.WaitAsync(0,cancellation))return;
        try {
            var session=await CurrentAsync(cancellation);
            foreach(var id in state.PendingFolderSetups(session.Principal)) {
                var setup=state.FolderSetup(id);if(setup is null)continue;
                try { await ResumeScopedFolderAsync(state,setup,session,cancellation); }
                catch(OperationCanceledException) when(cancellation.IsCancellationRequested) { throw; }
                catch(Exception error) {
                    var temporary=error is HttpRequestException or IOException or WindowsSessionUnavailableException or WindowsLoginRequiredException;
                    try { if(state.SourceSelected(id))state.SaveFolderSetup(state.FolderSetup(id) ?? setup,temporary?"pending":"needs_attention",temporary?"connection_wait":"setup_changed"); }
                    catch(Exception) { /* A paused or replaced source is fenced; other folders continue. */ }
                }
            }
        } finally { SetupGate.Release(); }
    }
    private async Task<FolderConnection> ResumeScopedFolderAsync(WindowsStateStore state,WindowsSourceSetup setup,WindowsSession session,CancellationToken cancellation)
    {
        void Current() {
            var folder=state.Folders().SingleOrDefault(row=>row.Id==setup.LocalSourceId);
            if(folder is null || folder.State!="selected" || ReadSession().Principal!=setup.Principal ||
                (folder.TenantId.HasValue && new WindowsPrincipal(folder.TenantId.Value,folder.UserId!.Value,folder.DeviceId!.Value)!=setup.Principal))throw new WindowsSourceInactiveException();
        }
        Current();
        var policy=await GetJsonAsync<CapturePolicy>(session,"v1/capture-policy",false,cancellation);
        if(!WindowsCapturePolicy.Same(policy,setup.Policy))throw new WindowsSourceConflictException();
        if(!setup.Selection.Common && !setup.Selection.Unassigned && setup.ProjectId is null) {
            var project=await SetupPost<ProjectResponse>(session,"v1/projects",StableSetupKey(setup.Key,"project"),new ProjectCreateRequest(setup.Selection.NewProjectName!),cancellation);
            Current();if(!Guid.TryParse(project.id,out var projectId) || projectId==Guid.Empty)throw new WindowsClientContractException();
            setup=setup with { ProjectId=projectId };state.SaveFolderSetup(setup);
        }
        if(setup.ServerSourceId is null) {
            var scope=new CaptureSourceCreateRequestScope("filesystem",setup.Since is null?"all":"since",setup.Since,"work_dedicated",1,setup.Policy.id,"hmac-sha256-device-v1",processing_lane:setup.Selection.NewOnly?"current":null);
            var body=new CaptureSourceCreateRequest(session.DeviceId.ToString("D"),setup.Selection.Kind,setup.Fingerprint,2,true,true,setup.Policy.external_processing,scope,processing_policy:WindowsCapturePolicy.SourceRequestSnapshot(setup.Policy));
            var source=await CreateSourceAsync(session,StableSetupKey(setup.Key,"source"),body,cancellation);
            Current();setup=setup with { ServerSourceId=source };state.SaveFolderSetup(setup);
        }
        var sources=await GetJsonAsync<CaptureSourcesResponse>(session,"v1/capture-sources",true,cancellation);
        var live=sources.sources.SingleOrDefault(row=>row.id==setup.ServerSourceId.Value.ToString("D")) ?? throw new WindowsSourceInactiveException();
        ValidateSourceSetup(live,setup);
        setup=setup with { Generation=live.generation };Current();state.SaveFolderSetup(setup);
        var binding=new SiteFolderBindingRequest(live.id,live.generation,setup.Fingerprint,setup.Selection.Unassigned?"unassigned":setup.Selection.Common?"company_common":"project",setup.ProjectId?.ToString("D"),setup.Selection.DisplayName);
        await SetupPost<SiteFolderBindingResponse>(session,"v1/site-folder-bindings",StableSetupKey(setup.Key,"binding"),binding,cancellation);
        var mapped=await GetJsonAsync<SiteFolderBindingsResponse>(session,"v1/site-folder-bindings",true,cancellation);
        if(!mapped.bindings.Any(row=>row.source_id==live.id && row.source_generation==live.generation && row.scope_fingerprint==setup.Fingerprint && row.project_id==binding.project_id && row.scope_mode==binding.scope_mode))throw new WindowsSourceInactiveException();
        // Lost acknowledgments and a concurrent revoke cannot turn a stale response into permission.
        sources=await GetJsonAsync<CaptureSourcesResponse>(session,"v1/capture-sources",true,cancellation);
        ValidateSourceSetup(sources.sources.SingleOrDefault(row=>row.id==live.id) ?? throw new WindowsSourceInactiveException(),setup);
        Current();state.BindSource(setup.LocalSourceId,session.Principal,setup.ServerSourceId.Value,live.generation,includeExistingBackfill:true);
        state.SaveFolderSetup(setup,"ready");return state.Folders().Single(row=>row.Id==setup.LocalSourceId);
    }
    private static bool SameInstant(string? first,string? second) {
        if(first is null || second is null)return first==second;
        return DateTimeOffset.TryParse(first,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal,out var a) &&
            DateTimeOffset.TryParse(second,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal,out var b) && a.ToUnixTimeMilliseconds()==b.ToUnixTimeMilliseconds();
    }
    private static void ValidatePolicy(CapturePolicy policy)
    {
        if(new[]{policy.id,policy.purpose,policy.provider,policy.processing_location,policy.storage_location,policy.retention}.Any(string.IsNullOrWhiteSpace) || policy.purpose!="work_records")throw new WindowsClientContractException();
        if(policy.processors is not null && (!policy.external_processing || policy.processors.Length!=1 || policy.processors.Any(processor=>
            processor is null || processor.purpose!="long_stt" || processor.provider is not ("openai" or "clova_speech") ||
            new[]{processor.processing_location,processor.storage_location,processor.retention}.Any(string.IsNullOrWhiteSpace))))throw new WindowsClientContractException();
    }
    private static void ValidateSourceSetup(CaptureSourcesResponseSourcesItem source,WindowsSourceSetup setup)
    {
        var policy=source.processing_policy;
        if(source.kind!=setup.Selection.Kind || source.tenant_id!=setup.Principal.TenantId.ToString("D") || source.device_id!=setup.Principal.DeviceId.ToString("D") ||
            !source.active || !source.device_active || !source.upload_ready || !source.server_upload_consent || source.generation<1 ||
            (setup.Generation.HasValue && source.generation!=setup.Generation) || source.scope_fingerprint!=setup.Fingerprint ||
            source.scope?.capture_method!="filesystem" || source.scope.history_mode!=(setup.Since is null?"all":"since") ||
            source.scope.processing_lane!=(setup.Selection.NewOnly?"current":null) ||
            !SameInstant(source.scope.history_since,setup.Since) || source.scope.scope_mode!="work_dedicated" || source.scope.processing_policy_id!=setup.Policy.id ||
            !WindowsCapturePolicy.Same(policy,setup.Policy))
            throw new WindowsSourceInactiveException();
    }
    private async Task<T> SetupPost<T>(WindowsSession session,string path,Guid key,object body,CancellationToken cancellation)
    {
        using var request=new HttpRequestMessage(HttpMethod.Post,new Uri(new Uri(session.ApiBaseUrl),path)){Content=JsonContent.Create(body,options:Json)};
        request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",session.AccessToken);
        request.Headers.TryAddWithoutValidation("X-Tenant-Id",session.TenantId.ToString("D"));request.Headers.TryAddWithoutValidation("Idempotency-Key",key.ToString("D"));
        using var response=await http.SendAsync(request,cancellation);if(response.StatusCode==HttpStatusCode.Unauthorized)throw new WindowsLoginRequiredException();
        ThrowSourceError(response.StatusCode);if(!response.IsSuccessStatusCode)throw new WindowsSessionUnavailableException();
        return await response.Content.ReadFromJsonAsync<T>(Json,cancellation) ?? throw new WindowsClientContractException();
    }
    private static Guid StableSetupKey(Guid seed,string operation) {
        var bytes=SHA256.HashData(Encoding.UTF8.GetBytes(seed.ToString("D")+":"+operation));bytes[7]=(byte)((bytes[7]&15)|64);bytes[8]=(byte)((bytes[8]&63)|128);return new Guid(bytes.AsSpan(0,16));
    }
}
