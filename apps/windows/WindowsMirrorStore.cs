using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace Sigongnote.Windows;

public sealed record MirrorEntry(string Kind,string Id,string Revision,string Hash,string Relative,string State,long WriteTicks=0,long Size=0,string Scope="",string[]? Categories=null);
public sealed record MirrorRetry(string Kind,string Id,int Attempts,long NextAttempt);
public sealed record MirrorJournal(string Identity,string? Cursor,Dictionary<string,MirrorEntry> Entries,Dictionary<string,string> IndexHashes,string ResetAt="0",Dictionary<string,MirrorRetry>? Retries=null,bool More=false,int Protocol=1,Dictionary<string,string>? Scopes=null);
public sealed partial class WindowsStateStore {
    public MirrorJournal Mirror(string source){
        using var db=Open();using var command=db.CreateCommand();
        command.CommandText="CREATE TABLE IF NOT EXISTS mirror_receipts(source_id TEXT PRIMARY KEY,payload BLOB NOT NULL);";command.ExecuteNonQuery();
        command.CommandText="SELECT payload FROM mirror_receipts WHERE source_id=$id";command.Parameters.AddWithValue("$id",source);
        return command.ExecuteScalar() is byte[] bytes?JsonSerializer.Deserialize<MirrorJournal>(secrets.Unprotect(bytes))!:new(Guid.NewGuid().ToString("D"),null,[],[]);
    }
    public void SaveMirror(string source,MirrorJournal journal){
        using var db=Open();using var command=db.CreateCommand();command.CommandText="INSERT INTO mirror_receipts(source_id,payload) VALUES($id,$payload) ON CONFLICT(source_id) DO UPDATE SET payload=excluded.payload";
        command.Parameters.AddWithValue("$id",source);command.Parameters.AddWithValue("$payload",secrets.Protect(JsonSerializer.Serialize(journal)));command.ExecuteNonQuery();
    }
}

public static class WindowsMirrorFiles {
    public static readonly string[] Categories=["약속","도면·자재","납품·작업","청구·지급","점검·하자","분류 확인 전","발행문서","사진대지"];
    public static string Category(string? category)=>category switch{"agreement"=>"약속","drawing_material"=>"도면·자재","delivery_work"=>"납품·작업","billing_payment"=>"청구·지급","inspection_defect"=>"점검·하자",_=>"분류 확인 전"};
    public static string Scope(MirrorJournal journal,string? project,JsonElement change){
        if(project is not null){
            if(!Guid.TryParseExact(project,"D",out _))throw new IOException();
            if(journal.Scopes!.TryGetValue(project,out var prior))return prior;
            var name=change.TryGetProperty("project_name",out var label)&&label.ValueKind==JsonValueKind.String?label.GetString()!:"현장";
            name=new string(name.Select(c=>Path.GetInvalidFileNameChars().Contains(c)||char.IsControl(c)?'_':c).Take(40).ToArray()).Trim(' ','.');
            // Stable project identity separates equal display names and preserves paths after renaming.
            return journal.Scopes[project]=Path.Combine("현장",$"{name}_{project}");
        }
        return change.TryGetProperty("organization_state",out var state)&&state.GetString()=="common"?"회사 공통":"현장 확인 전";
    }
    public static void Safe(string root,string target){
        var boundary=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var file=Path.GetFullPath(target);if(file!=boundary&&!file.StartsWith(boundary+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException();
        for(var cursor=file;;cursor=Path.GetDirectoryName(cursor)!){
            if((File.Exists(cursor)||Directory.Exists(cursor))&&File.GetAttributes(cursor).HasFlag(FileAttributes.ReparsePoint))throw new IOException();
            if(cursor.Equals(boundary,StringComparison.OrdinalIgnoreCase))break;
        }
    }
    public static async Task<string> EnsureRoot(string source,MirrorJournal journal,CancellationToken token,bool company=false){
        var root=Path.Combine(source,"시공노트");Safe(source,root);
        if(!Directory.Exists(root)){
            var temp=Path.Combine(source,".sigongnote-"+journal.Identity);Safe(source,temp);
            Directory.CreateDirectory(temp);var temporaryMarker=Path.Combine(temp,"sigongnote-generated.json");Safe(temp,temporaryMarker);
            if(File.Exists(temporaryMarker)){using var existing=JsonDocument.Parse(await File.ReadAllTextAsync(temporaryMarker,token));if(existing.RootElement.GetProperty("identity").GetString()!=journal.Identity)throw new IOException();}
            else {await using var markerStream=new FileStream(temporaryMarker,FileMode.CreateNew,FileAccess.Write,FileShare.None);await JsonSerializer.SerializeAsync(markerStream,new{version=1,identity=journal.Identity},cancellationToken:token);}
            Directory.Move(temp,root);
        }
        var marker=Path.Combine(root,"sigongnote-generated.json");Safe(root,marker);
        using var doc=JsonDocument.Parse(await File.ReadAllTextAsync(marker,token));
        if(doc.RootElement.GetProperty("identity").GetString()!=journal.Identity)throw new IOException("managed_folder_changed");
        if(!company)foreach(var category in Categories){var dir=Path.Combine(root,category);Safe(root,dir);Directory.CreateDirectory(dir);}
        return root;
    }
    public static async Task<string> Install(string root,string relative,string sha,Func<Stream,Task> download,CancellationToken token){
        var target=Path.Combine(root,relative);Safe(root,target);
        if(File.Exists(target))return await Hash(target,token)==sha?"ready":"edited";
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);Safe(root,target);
        var drive=new DriveInfo(Path.GetPathRoot(target)!);
        if(drive.AvailableFreeSpace<WindowsCopySpace.Reserve(drive.TotalSize)+209715200L)throw new IOException("storage_full");
        var temp=target+"."+Guid.NewGuid()+".tmp";
        try{
            await using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){await download(stream);await stream.FlushAsync(token);stream.Flush(true);}
            if(await Hash(temp,token)!=sha)throw new IOException("file_integrity");
            Safe(root,target);File.Move(temp,target,false);return "ready";
        }finally{if(File.Exists(temp))File.Delete(temp);}
    }
    public static async Task<string> Hash(string file,CancellationToken token){await using var stream=File.OpenRead(file);return Convert.ToHexString(await SHA256.HashDataAsync(stream,token)).ToLowerInvariant();}
    public static async Task WriteIndexes(string root,MirrorJournal journal,CancellationToken token,Action checkpoint){
        static string Html(string value)=>System.Net.WebUtility.HtmlEncode(value);
        var scopes=journal.Entries.Values.Select(e=>e.Scope).Distinct().ToArray();
        foreach(var scope in scopes)foreach(var category in Categories){
            var directory=Path.Combine(scope,category);
            if(!journal.Entries.Values.Any(e=>e.Scope==scope&&(e.Categories?.Contains(category)??Path.GetDirectoryName(e.Relative)==directory)))continue;
            var relative=Path.Combine(directory,"자료목록.html");var target=Path.Combine(root,relative);Safe(root,target);Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if(File.Exists(target)){var current=await Hash(target,token);if(!journal.IndexHashes.TryGetValue(relative,out var expected)||!expected.Split('|').Contains(current))continue;}
            var rows=journal.Entries.Values.Where(e=>e.Scope==scope&&(e.Categories?.Contains(category)??Path.GetDirectoryName(e.Relative)==directory)).Select(e=>e.State=="ready"?$"<li><a href=\"{string.Join("/",Path.GetRelativePath(directory,e.Relative).Split(Path.DirectorySeparatorChar).Select(Uri.EscapeDataString))}\">{Html(Path.GetFileName(e.Relative))}</a></li>":$"<li>{Html(Path.GetFileName(e.Relative))} · {(e.State.StartsWith("edited",StringComparison.Ordinal)?"사용자가 수정한 사본 · 보존됨":"현재 접근/발행 상태 확인 필요 · 이전 사본 보존")}</li>");
            var body=$"<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'\"><title>{category}</title><style>body{{font:20px/1.7 sans-serif;margin:32px}}li{{margin:14px}}</style><h1>{category}</h1><p>자동으로 받은 사본입니다. 원본은 그대로예요. PC가 꺼져 있던 동안의 변경은 연결되면 이어 받습니다.</p><ul>{string.Join("",rows)}</ul></html>";
            // Replace only an unchanged app-owned index; a crash keeps files and cursor replay safe.
            var bytes=Encoding.UTF8.GetBytes(body);var hash=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            var temp=target+"."+Guid.NewGuid()+".tmp";
            try{await File.WriteAllBytesAsync(temp,bytes,token);journal.IndexHashes[relative]=journal.IndexHashes.TryGetValue(relative,out var prior)?prior+"|"+hash:hash;checkpoint();File.Move(temp,target,true);journal.IndexHashes[relative]=hash;}finally{if(File.Exists(temp))File.Delete(temp);}
        }
    }
}
