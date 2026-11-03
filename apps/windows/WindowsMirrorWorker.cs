using System.Text.Json;
namespace Sigongnote.Windows;

/// <summary>Runs independently from the work window and upload queue. Each approved destination has a durable receipt.</summary>
public sealed class WindowsMirrorWorker : IDisposable {
    private readonly Dictionary<string,DateTimeOffset> journalChecks=[];
    private readonly WindowsStateStore state;private readonly WindowsSessionManager sessions;
    private readonly HttpClient http;private readonly CancellationTokenSource stop=new();private Task? run;private readonly Action<Exception>? failure;
    public string Status {get;private set;}="PC 사본 대기";
    public WindowsMirrorWorker(WindowsStateStore state,WindowsSessionManager sessions,HttpMessageHandler? handler=null,Action<Exception>? failure=null){this.failure=failure;this.state=state;this.sessions=sessions;http=new(handler??new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}){Timeout=TimeSpan.FromSeconds(60)};}
    public void Start(){run??=Task.Run(async()=>{while(!stop.IsCancellationRequested){try{await RunOnce(stop.Token);}catch(OperationCanceledException) when(stop.IsCancellationRequested){break;}catch{Status="PC 사본 연결 대기";}try{await Task.Delay(10000,stop.Token);}catch(OperationCanceledException){break;}}});}
    public async Task RunOnce(CancellationToken token=default){
        var session=await sessions.CurrentAsync(token);var count=0;var waiting=0;var pending=0;var edited=0;var more=false;
        foreach(var folder in state.Folders()){
            var setup=state.FolderSetup(folder.Id);
            if(folder.State!="selected"||setup?.Principal!=session.Principal||!setup.Selection.DownloadCopies||(!setup.Selection.ManagedRoot&&(setup.Selection.Common||setup.ProjectId is null))||state.FolderSetupState(folder.Id)!="ready")continue;
            try{await SyncFolder(folder,setup,session,token);count++;var latest=state.Mirror(folder.Id);pending+=latest.Retries?.Count??0;edited+=latest.Entries.Values.Count(e=>e.State.StartsWith("edited",StringComparison.Ordinal));more|=latest.More;}catch(OperationCanceledException){throw;}catch(Exception error){waiting++;failure?.Invoke(error);}
        }
        Status=waiting>0?$"PC 사본 {waiting}곳 연결·위치 확인 필요":count>0?$"PC 사본 {count}곳 {(more?"이어 받는 중":"최신 확인")} · 못 받은 {pending}개 자동 재시도 · 수정 사본 {edited}개 보존":"PC 사본 위치 설정 대기";
    }
    private async Task SyncFolder(FolderConnection folder,WindowsSourceSetup setup,WindowsSession session,CancellationToken token){
        if(folder.VolumeId is null||folder.VolumeSerial is null||folder.RelativePath is null||folder.ServerSourceId is null)throw new IOException();
        var source=new WindowsVolumeIdentity(folder.VolumeId,folder.VolumeSerial,"",folder.RelativePath).FindCurrentPath()??throw new IOException();
        await sessions.BindVerifiedFolderAsync(state,folder.Id,folder.ServerSourceId.Value,token);
        var journal=state.Mirror(folder.Id);journal=journal with {Retries=journal.Retries??[],Scopes=journal.Scopes??[],Protocol=2,Cursor=journal.Protocol<2?null:journal.Cursor};state.SaveMirror(folder.Id,journal);
        var root=await WindowsMirrorFiles.EnsureRoot(source,journal,token,setup.Selection.ManagedRoot);
        async Task Current(){var current=await sessions.CurrentAsync(token);var latestSetup=state.FolderSetup(folder.Id);if(current.Principal!=session.Principal||current.ApiBaseUrl!=session.ApiBaseUrl||!state.SourceSelected(folder.Id)||latestSetup?.Principal!=session.Principal||latestSetup.Selection.DownloadCopies!=true||(setup.Selection.JournalCopies&&!latestSetup.Selection.JournalCopies)||latestSetup.Selection.ManagedRoot!=setup.Selection.ManagedRoot||latestSetup.ProjectId!=setup.ProjectId)throw new WindowsLoginRequiredException();}
        foreach(var entry in journal.Entries.ToArray()){
            var path=Path.Combine(root,entry.Value.Relative);WindowsMirrorFiles.Safe(root,path);var info=new FileInfo(path);
            if(entry.Value.State=="ready"&&(!info.Exists||info.LastWriteTimeUtc.Ticks!=entry.Value.WriteTicks||info.Length!=entry.Value.Size)){
                var changed=!info.Exists||await WindowsMirrorFiles.Hash(path,token)!=entry.Value.Hash;
                journal.Entries[entry.Key]=entry.Value with {State=changed?"edited":"ready",WriteTicks=info.Exists?info.LastWriteTimeUtc.Ticks:0,Size=info.Exists?info.Length:0};
            }
        }
        foreach(var retry in journal.Retries!.Values.Where(r=>r.NextAttempt<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Take(10).ToArray()){
            await Current();
            try{
                using var request=JsonDocument.Parse(JsonSerializer.Serialize(new{route="sync.item",id=retry.Id,target_kind=retry.Kind}));
                using var result=JsonDocument.Parse(await sessions.WorkRequestAsync(request.RootElement,token,session));
                await Process(result.RootElement.GetProperty("changes")[0]);
            }catch(Exception error) when(error is not (WindowsLoginRequiredException or OperationCanceledException)){Remember(retry.Kind,retry.Id);}
            state.SaveMirror(folder.Id,journal);
        }
        for(var page=0;page<4;page++){
            await Current();using var request=JsonDocument.Parse(JsonSerializer.Serialize(new{route="sync.changes",sync_version=2,cursor=journal.Cursor},new JsonSerializerOptions{DefaultIgnoreCondition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull}));
            string raw;
            try{raw=await sessions.WorkRequestAsync(request.RootElement,token,session);}
            catch(WindowsWorkRejectedException e) when(e.Code=="DOMAIN_INVARIANT"&&journal.Cursor is not null){
                journal=journal with {Cursor=null,ResetAt="0"};state.SaveMirror(folder.Id,journal);continue;
            }
            using var data=JsonDocument.Parse(raw);
            var reset=data.RootElement.TryGetProperty("reset_sequence",out var resetSequence)?resetSequence.GetString()!:"0";
            if(System.Numerics.BigInteger.Parse(reset)>System.Numerics.BigInteger.Parse(journal.ResetAt)){
                foreach(var entry in journal.Entries.Where(e=>!e.Value.State.StartsWith("edited",StringComparison.Ordinal)).ToArray())journal.Entries[entry.Key]=entry.Value with {State="check_required"};
                var restart=journal.Cursor is not null;journal=journal with {Cursor=null,ResetAt=reset};state.SaveMirror(folder.Id,journal);if(restart)continue;
            }
            foreach(var change in data.RootElement.GetProperty("changes").EnumerateArray()){
                await Current();if(change.GetProperty("kind").GetString()=="reset")continue;
                await Process(change);state.SaveMirror(folder.Id,journal);
            }
            await Current();await WindowsMirrorFiles.WriteIndexes(root,journal,token,()=>state.SaveMirror(folder.Id,journal));
            journal=journal with {Cursor=data.RootElement.GetProperty("next_cursor").GetString(),More=data.RootElement.GetProperty("has_more").GetBoolean()};state.SaveMirror(folder.Id,journal);
            if(!journal.More)break;
        }
        if(setup.Selection.JournalCopies&&(!journalChecks.TryGetValue(folder.Id,out var checkedAt)||DateTimeOffset.UtcNow-checkedAt>TimeSpan.FromSeconds(30))){
            await Current();using var journalRequest=JsonDocument.Parse(JsonSerializer.Serialize(new{route="journal.list",project_id=setup.Selection.ManagedRoot?null:setup.ProjectId?.ToString("D")},new JsonSerializerOptions{DefaultIgnoreCondition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull}));
            using var snapshot=JsonDocument.Parse(await sessions.WorkRequestAsync(journalRequest.RootElement,token,session));await Current();
            await WindowsJournalCopy.Write(root,journal,snapshot.RootElement,session.ApiBaseUrl,token,()=>state.SaveMirror(folder.Id,journal));journalChecks[folder.Id]=DateTimeOffset.UtcNow;
        }
        void Remember(string kind,string id){var key=kind+":"+id;var attempts=(journal.Retries!.GetValueOrDefault(key)?.Attempts??0)+1;journal.Retries[key]=new(kind,id,attempts,DateTimeOffset.UtcNow.AddSeconds(Math.Min(3600,30*Math.Pow(2,Math.Min(attempts-1,7)))).ToUnixTimeMilliseconds());}
        async Task Process(JsonElement change){
            var kind=change.GetProperty("kind").GetString()!;var id=change.GetProperty("id").GetString();
            if(id is null||kind=="reset")return;
            try{await Apply(change,kind);journal.Retries!.Remove(kind+":"+id);}
            catch(Exception error) when(error is not (WindowsLoginRequiredException or OperationCanceledException)){Remember(kind,id);}
        }
        async Task Apply(JsonElement change,string kind){
                var id=change.GetProperty("id").GetString()!;
                var project=change.TryGetProperty("project_id",out var projectValue)&&projectValue.ValueKind==JsonValueKind.String?projectValue.GetString():null;
                if(change.GetProperty("tombstone").GetBoolean()||(!setup.Selection.ManagedRoot&&project!=setup.ProjectId?.ToString("D"))){
                    foreach(var entry in journal.Entries.Where(e=>e.Value.Id==id).ToArray())journal.Entries[entry.Key]=entry.Value with {State=entry.Value.State.StartsWith("edited",StringComparison.Ordinal)?"edited_unavailable":"unavailable"};return;
                }
                var revision=change.GetProperty("revision_id").GetString()!;
                if(!Guid.TryParseExact(id,"D",out _)||!Guid.TryParseExact(revision,"D",out _))throw new IOException();
                if(kind is "document" or "photo_sheet"){
                    foreach(var file in change.GetProperty("files").EnumerateArray()){
                        var format=file.GetProperty("format").GetString()!;if(format is not ("pdf" or "xlsx"))throw new IOException();
                        var hash=file.GetProperty("sha256").GetString()!;await Copy(kind=="photo_sheet"?"사진대지":"발행문서",format,hash,async output=>{
                            using var req=JsonDocument.Parse(JsonSerializer.Serialize(new{route=kind=="photo_sheet"?"sheets.file":"documents.file",id,format}));
                            var json=await sessions.WorkRequestAsync(req.RootElement,token,session);var decoded=WindowsDocumentFile.Decode(json,format);if(decoded.Hash!=hash)throw new IOException();await Current();await output.WriteAsync(decoded.Bytes,token);
                        });
                    }
                }else{
                    if(change.TryGetProperty("copy_allowed",out var copyAllowed)&&!copyAllowed.GetBoolean()){foreach(var entry in journal.Entries.Where(e=>e.Value.Id==id).ToArray())journal.Entries[entry.Key]=entry.Value with {State=entry.Value.State.StartsWith("edited",StringComparison.Ordinal)?"edited_unavailable":"unavailable"};return;}
                    var mime=change.GetProperty("mime").GetString();if(mime is "application/octet-stream" or "application/zip" or "application/x-ole-storage")mime=change.TryGetProperty("declared_mime",out var declared)?declared.GetString():mime;var ext=mime switch{"application/pdf"=>"pdf","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"=>"xlsx","application/vnd.ms-excel"=>"xls","image/jpeg"=>"jpg","image/png"=>"png","image/webp"=>"webp","image/heic" or "image/heif"=>"heic","application/x-hwp" or "application/haansofthwp" or "application/vnd.hancom.hwp"=>"hwp","application/vnd.hancom.hwpx" or "application/hwp+zip"=>"hwpx","text/plain" when setup.Selection.PlaintextCopies=>"txt","text/csv" when setup.Selection.PlaintextCopies=>"csv",_=>null};
                    if(ext is null)return;
                    var category=change.TryGetProperty("categories",out var cats)&&cats.ValueKind==JsonValueKind.Array&&cats.GetArrayLength()>0?cats[0].GetString():null;
                    var directory=WindowsMirrorFiles.Category(category);
                    var hash=change.GetProperty("sha256").GetString()!;
                    await Copy(directory,ext,hash,async output=>{
                        using var req=JsonDocument.Parse(JsonSerializer.Serialize(new{route="materials.original",id}));using var original=JsonDocument.Parse(await sessions.WorkRequestAsync(req.RootElement,token,session));
                        if(original.RootElement.GetProperty("sha256").GetString()!=hash)throw new IOException();
                        var url=new Uri(original.RootElement.GetProperty("url").GetString()!);var origin=new Uri(session.SupabaseOrigin);
                        if(url.Scheme!=origin.Scheme||url.Host!=origin.Host||url.Port!=origin.Port||url.UserInfo.Length>0||!url.AbsolutePath.StartsWith("/storage/v1/object/sign/sigongnote-originals/",StringComparison.Ordinal))throw new IOException();
                        using var response=await http.GetAsync(url,HttpCompletionOption.ResponseHeadersRead,token);response.EnsureSuccessStatusCode();await using var input=await response.Content.ReadAsStreamAsync(token);var buffer=new byte[65536];long total=0;int read;
                        while((read=await input.ReadAsync(buffer,token))>0){total+=read;if(total>209715200)throw new IOException();await output.WriteAsync(buffer.AsMemory(0,read),token);}await Current();
                        using var recheck=JsonDocument.Parse(await sessions.WorkRequestAsync(req.RootElement,token,session));if(recheck.RootElement.GetProperty("sha256").GetString()!=hash)throw new IOException();
                    });
                }
                async Task Copy(string directory,string ext,string hash,Func<Stream,Task> download){
                    if(!System.Text.RegularExpressions.Regex.IsMatch(hash,@"\A[a-f0-9]{64}\z"))throw new IOException();

                    var title=change.TryGetProperty("title",out var label)?label.GetString()??"업무자료":"업무자료";
                    title=new string(title.Select(c=>Path.GetInvalidFileNameChars().Contains(c)?'_':c).Take(40).ToArray()).Trim(' ','.');
                    var scope=setup.Selection.ManagedRoot?WindowsMirrorFiles.Scope(journal,project,change):"";
                    var relative=Path.Combine(scope,directory,$"{title}_{id}_{hash[..12]}.{ext}");
                    var status=await WindowsMirrorFiles.Install(root,relative,hash,download,token);await Current();
                    var key=$"{kind}:{id}:{ext}";
                    if(journal.Entries.TryGetValue(key,out var previous)&&previous.Relative!=relative){

                        journal.Entries[$"history:{key}:{previous.Hash}:{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(previous.Relative)))}"]=previous with {State=previous.State.StartsWith("edited",StringComparison.Ordinal)?previous.State:"superseded"};
                    }
                    var savedFile=new FileInfo(Path.Combine(root,relative));journal.Entries[$"{kind}:{id}:{ext}"]=new(kind,id,revision,hash,relative,status,savedFile.LastWriteTimeUtc.Ticks,savedFile.Length,scope,kind=="material"&&change.TryGetProperty("categories",out var tags)&&tags.ValueKind==JsonValueKind.Array?tags.EnumerateArray().Select(c=>WindowsMirrorFiles.Category(c.GetString())).DefaultIfEmpty("분류 확인 전").Distinct().ToArray():[directory]);
                }

        }
    }
    public void Dispose(){stop.Cancel();try{run?.GetAwaiter().GetResult();}catch(OperationCanceledException){}http.Dispose();stop.Dispose();}
}
