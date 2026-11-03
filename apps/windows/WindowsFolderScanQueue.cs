using Microsoft.Data.Sqlite;

namespace Sigongnote.Windows;

public sealed partial class WindowsStateStore
{
    /// <summary>Bounded durable discovery; source paths stay protected by the existing user vault.</summary>
    public FolderScanResult ScanFolderBatch(string sourceId,string root,WindowsFileStabilizer stabilizer)
    {
        using var db=Open();
        int Execute(string sql,params (string,object)[] values) {
            using var command=db.CreateCommand();command.CommandText=sql;
            command.Parameters.AddWithValue("$source",sourceId);
            foreach(var (name,value) in values)command.Parameters.AddWithValue(name,value);
            return command.ExecuteNonQuery();
        }
        long Count(string sql) {
            using var command=db.CreateCommand();command.CommandText=sql;
            command.Parameters.AddWithValue("$source",sourceId);
            return Convert.ToInt64(command.ExecuteScalar());
        }
        long generation=0;string? runState=null;
        using(var command=db.CreateCommand()) {
            command.CommandText="SELECT generation,state FROM scan_runs WHERE source_id=$source";
            command.Parameters.AddWithValue("$source",sourceId);
            using var reader=command.ExecuteReader();
            if(reader.Read()){generation=reader.GetInt64(0);runState=reader.GetString(1);}
        }
        if(runState!="running") {
            generation++;
            using var transaction=db.BeginTransaction();
            using var command=db.CreateCommand();command.Transaction=transaction;
            command.CommandText="""
                INSERT OR REPLACE INTO scan_runs VALUES($source,$generation,'running');
                DELETE FROM scan_directories WHERE source_id=$source;
                INSERT INTO scan_directories VALUES($source,$token,$path,0,'todo');
                """;
            command.Parameters.AddWithValue("$source",sourceId);command.Parameters.AddWithValue("$generation",generation);
            command.Parameters.AddWithValue("$token",WindowsFileStabilizer.PathToken(sourceId,""));
            command.Parameters.AddWithValue("$path",secrets.Protect("."));command.ExecuteNonQuery();transaction.Commit();
        }
        if(Count("SELECT count(*) FROM scan_directories WHERE source_id=$source AND state='todo'")==0)
            Execute("UPDATE scan_directories SET state='todo' WHERE source_id=$source AND state='done'");
        var exclusions=ChildScopeExclusions(sourceId);
        bool Excluded(string path)=>exclusions.Any(child=>child=="."||WindowsUpperFolder.Contains(child,path));
        var baseline=ScopeBaseline(sourceId);var setup=FolderSetup(sourceId);var processed=0;
        for(var directories=0;directories<20 && processed<400;directories++) {
            if(!SourceSelected(sourceId))return new(sourceId,"paused",root,0);
            string? token=null;byte[]? protectedPath=null;var depth=0;
            using(var command=db.CreateCommand()) {
                command.CommandText="SELECT path_token,path_protected,depth FROM scan_directories WHERE source_id=$source AND state='todo' ORDER BY depth,path_token LIMIT 1";
                command.Parameters.AddWithValue("$source",sourceId);using var reader=command.ExecuteReader();
                if(reader.Read()){token=reader.GetString(0);protectedPath=(byte[])reader[1];depth=reader.GetInt32(2);}
            }
            if(token is null)break;
            try {
                var directory=Path.GetFullPath(Path.Combine(root,secrets.Unprotect(protectedPath!)));
                if(depth>32 || !SafeRoute(root,directory))throw new IOException("directory_gap");
                if(Excluded(Path.GetRelativePath(root,directory)) || File.Exists(Path.Combine(directory,"sigongnote-generated.json"))) {
                    Execute("UPDATE scan_directories SET state='done' WHERE source_id=$source AND path_token=$token",("$token",token));continue;
                }
                var complete=true;
                foreach(var item in Directory.EnumerateFileSystemEntries(directory,"*",new EnumerationOptions {
                    RecurseSubdirectories=false,IgnoreInaccessible=false,AttributesToSkip=FileAttributes.Hidden|FileAttributes.System|FileAttributes.ReparsePoint })) {
                    if(processed>=400){complete=false;break;}
                    if(!SourceSelected(sourceId))return new(sourceId,"paused",root,0);
                    var relative=Path.GetRelativePath(root,item);var itemToken=WindowsFileStabilizer.PathToken(sourceId,relative);
                    if(Excluded(relative))continue;
                    if(Directory.Exists(item)) {
                        if(Execute("INSERT OR IGNORE INTO scan_directories VALUES($source,$token,$path,$depth,'todo')",("$token",itemToken),("$path",secrets.Protect(relative)),("$depth",depth+1))>0)processed++;
                        continue;
                    }
                    try {
                    var file=new FileInfo(item);
                    if(UnchangedEntry(itemToken,file))continue;
                    var outside=file.LastWriteTimeUtc<baseline.CutoffUtc && (baseline.Completed ?
                        (file.CreationTimeUtc<baseline.StartedUtc && baseline.ExcludedFingerprints.Contains(WindowsFolderPolicy.MetadataFingerprint(file))) : file.CreationTimeUtc<baseline.StartedUtc);
                    if(outside && !baseline.Completed)Execute("INSERT OR IGNORE INTO excluded_baseline_files VALUES($source,$hash)",("$hash",WindowsFolderPolicy.MetadataFingerprint(file)));
                    var allowed=!outside && WindowsFolderPolicy.Supported(item) && FolderScopeAllows(setup,relative,file.LastWriteTimeUtc.Ticks);
                    // Discover large originals without hashing/copying gigabytes that cannot be uploaded yet.
                    var tooLarge=allowed&&file.Length>209715200;
                    Execute("INSERT OR REPLACE INTO scan_entries VALUES($source,$token,$path,$generation,$state,$modified,$size)",
                        ("$token",itemToken),("$path",secrets.Protect(relative)),("$generation",generation),("$state",tooLarge?"held":allowed?"pending":"excluded"),("$modified",file.LastWriteTimeUtc.Ticks),("$size",file.Length));
                    processed++;
                    } catch(Exception error) when(error is IOException or UnauthorizedAccessException) {
                        Execute("INSERT OR REPLACE INTO scan_entries VALUES($source,$token,$path,$generation,'held',0,0)",
                            ("$token",itemToken),("$path",secrets.Protect(relative)),("$generation",generation));
                        processed++;
                    }
                }
                if(complete)Execute("UPDATE scan_directories SET state='done' WHERE source_id=$source AND path_token=$token",("$token",token));
            } catch(Exception error) when(error is IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException) {
                Execute("UPDATE scan_directories SET state='gap' WHERE source_id=$source AND path_token=$token",("$token",token));
            }
        }
        var pendingFiles=new List<(string Token,byte[] Path)>();
        using(var command=db.CreateCommand()) {
            command.CommandText="SELECT path_token,path_protected FROM scan_entries WHERE source_id=$source AND generation=$generation AND state='pending' ORDER BY modified_ticks DESC LIMIT 100";
            command.Parameters.AddWithValue("$source",sourceId);command.Parameters.AddWithValue("$generation",generation);
            using var reader=command.ExecuteReader();while(reader.Read())pendingFiles.Add((reader.GetString(0),(byte[])reader[1]));
        }
        foreach(var item in pendingFiles) {
            try {
                var target=Path.Combine(root,secrets.Unprotect(item.Path));
                if(!File.Exists(target)) {
                    Execute("UPDATE scan_entries SET state='gone' WHERE source_id=$source AND path_token=$token",("$token",item.Token));continue;
                }
                if(!SafeRoute(root,target))throw new IOException("path_changed");
                if(IsOwnedByChild(sourceId,Path.GetRelativePath(root,target)) || !FolderScopeAllows(setup,Path.GetRelativePath(root,target),File.GetLastWriteTimeUtc(target).Ticks)) {
                    Execute("UPDATE scan_entries SET state='excluded' WHERE source_id=$source AND path_token=$token",("$token",item.Token));continue;
                }
                var readiness=stabilizer.Observe(sourceId,root,target);
                if(readiness==FileReadiness.Delayed && !File.Exists(target)) {
                    Execute("UPDATE scan_entries SET state='gone' WHERE source_id=$source AND path_token=$token",("$token",item.Token));continue;
                }
                if(readiness!=FileReadiness.Delayed)Execute("UPDATE scan_entries SET state=$state WHERE source_id=$source AND path_token=$token",("$state",readiness==FileReadiness.Ready?"done":"held"),("$token",item.Token));
            } catch(Exception error) when(error is IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException) {
                Execute("UPDATE scan_entries SET state='held' WHERE source_id=$source AND path_token=$token",("$token",item.Token));
            }
        }
        var remaining=Count("SELECT count(*) FROM scan_directories WHERE source_id=$source AND state='todo'");
        var pending=Count($"SELECT count(*) FROM scan_entries WHERE source_id=$source AND generation={generation} AND state='pending'");
        var held=Count($"SELECT count(*) FROM scan_entries WHERE source_id=$source AND generation={generation} AND state='held'");
        var gaps=Count("SELECT count(*) FROM scan_directories WHERE source_id=$source AND state='gap'");
        var candidates=Count($"SELECT count(*) FROM scan_entries WHERE source_id=$source AND generation={generation} AND state!='excluded'");
        if(remaining==0 && !baseline.Completed && gaps==0)CompleteScopeBaseline(sourceId,[]);
        var more=remaining>0 || pending>0;
        if(!more)Execute("UPDATE scan_runs SET state='finished' WHERE source_id=$source");
        return new(sourceId,gaps>0 || held>0 || remaining>0?"scan_gap":"current",root,(int)candidates,(int)pending,(int)held,more);

        bool UnchangedEntry(string token,FileInfo file) {
            using var command=db.CreateCommand();command.CommandText="SELECT generation,modified_ticks,observed_size FROM scan_entries WHERE source_id=$source AND path_token=$token";
            command.Parameters.AddWithValue("$source",sourceId);command.Parameters.AddWithValue("$token",token);
            using var reader=command.ExecuteReader();
            return reader.Read() && reader.GetInt64(0)==generation && reader.GetInt64(1)==file.LastWriteTimeUtc.Ticks && reader.GetInt64(2)==file.Length;
        }
    }
    private static bool SafeRoute(string root,string path) {
        root=Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        path=Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var relative=Path.GetRelativePath(root,path);
        if(Path.IsPathRooted(relative)||relative==".."||relative.StartsWith(".."+Path.DirectorySeparatorChar,StringComparison.Ordinal))return false;
        for(string? cursor=path;cursor is not null;cursor=Path.GetDirectoryName(cursor)) {
            // The explicitly selected root may itself be redirected; nested links remain excluded.
            if(string.Equals(cursor,root,StringComparison.OrdinalIgnoreCase))return true;
            if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0)return false;
        }
        return false;
    }
}
