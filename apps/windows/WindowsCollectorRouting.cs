namespace Sigongnote.Windows;

public sealed record WindowsLocalNativeScope(string source_id,string root,string kind,bool active,string setup_state,int pending,string? error,bool managed_root,string account);

/// <summary>Explicitly consented sources keep the native encrypted upload path; automatic discovery stays local.</summary>
public static class WindowsCollectorRouting
{
    public static bool CollectNatively(WindowsStateStore state,FolderConnection folder,bool localRuntimePrimary)=>
        !localRuntimePrimary || (state.FolderSetupState(folder.Id) is "ready" or "pending" && state.FolderSetup(folder.Id)?.Selection.Kind is "folder" or "photos" or "call_recording");

    public static FolderConnection? Covering(WindowsStateStore state,WindowsVolumeIdentity volume,string? kind=null)=>
        WindowsUpperFolder.Covering(volume,state.Folders().Where(folder=>kind!="call_recording" ||
            state.FolderSetup(folder.Id)?.Selection.Kind=="call_recording" ||
            (folder.RelativePath is not null&&WindowsUpperFolder.Contains(volume.RelativePath,folder.RelativePath))).ToArray());
}

public sealed partial class WindowsStateStore
{
    public IReadOnlyList<WindowsLocalNativeScope> LocalNativeScopes(WindowsPrincipal? principal=null)
    {
        var result=new List<WindowsLocalNativeScope>();
        foreach(var folder in Folders()) {
            var setup=FolderSetup(folder.Id);
            if(setup is null||(principal is not null&&setup.Principal!=principal)||folder.RootPath is null)continue;
            using var db=Open();using var command=db.CreateCommand();
            command.CommandText="SELECT count(*) FROM capture_queue WHERE source_id=$source AND state NOT IN ('acknowledged','revoked_purged');";
            command.Parameters.AddWithValue("$source",folder.Id);
            result.Add(new(folder.Id,folder.RootPath,setup.Selection.Kind,folder.State=="selected",FolderSetupState(folder.Id)??"pending",Convert.ToInt32(command.ExecuteScalar()),Health(folder.Id)?.ErrorCode,setup.Selection.ManagedRoot,$"{setup.Principal.UserId:D}:{setup.Principal.TenantId:D}"));
        }
        return result;
    }
}
