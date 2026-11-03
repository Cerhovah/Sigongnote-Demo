namespace Sigongnote.Windows;

/// <summary>Compare physical volume-relative scopes; mount letters and paused scopes do not change ownership.</summary>
public static class WindowsUpperFolder
{
    public static bool Contains(string parent,string path) {
        static string Normalize(string value)=>value=="."?"":value.Replace('/','\\').Trim('\\');
        parent=Normalize(parent);path=Normalize(path);
        return parent.Length==0||path.Equals(parent,StringComparison.OrdinalIgnoreCase)||path.StartsWith(parent+"\\",StringComparison.OrdinalIgnoreCase);
    }
    public static bool SameVolume(FolderConnection folder,WindowsVolumeIdentity volume)=>
        string.Equals(folder.VolumeId,volume.VolumeId,StringComparison.OrdinalIgnoreCase)&&string.Equals(folder.VolumeSerial,volume.Serial,StringComparison.OrdinalIgnoreCase);
    public static FolderConnection? Covering(WindowsVolumeIdentity volume,IReadOnlyList<FolderConnection> folders)=>
        folders.FirstOrDefault(f=>SameVolume(f,volume)&&f.RelativePath is not null&&Contains(f.RelativePath,volume.RelativePath));
    public static IReadOnlyList<string> Children(WindowsVolumeIdentity volume,IReadOnlyList<FolderConnection> folders)=>
        folders.Where(f=>SameVolume(f,volume)&&f.RelativePath is not null&&Contains(volume.RelativePath,f.RelativePath)&&!Contains(f.RelativePath,volume.RelativePath))
            .Select(f=>Path.GetRelativePath(Path.Combine(volume.MountRoot,volume.RelativePath),Path.Combine(volume.MountRoot,f.RelativePath!))).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
}

public sealed partial class WindowsStateStore
{
    public void PauseUnpreparedFolder(string sourceId) {if(FolderSetup(sourceId) is null)PauseSource(sourceId);}
    public bool CanResumeFolder(string sourceId,WindowsPrincipal principal) {
        var folder=Folders().Single(f=>f.Id==sourceId);var setup=FolderSetup(sourceId);
        return (setup is null||setup.Principal==principal)&&(folder.TenantId is null||new WindowsPrincipal(folder.TenantId.Value,folder.UserId!.Value,folder.DeviceId!.Value)==principal);
    }
    public IReadOnlyList<string> ChildScopeExclusions(string sourceId) {
        var folders=Folders();var root=folders.SingleOrDefault(f=>f.Id==sourceId);
        if(root?.VolumeId is null||root.VolumeSerial is null||root.RelativePath is null)return ["."];
        return WindowsUpperFolder.Children(new(root.VolumeId,root.VolumeSerial,@"C:\",root.RelativePath),folders.Where(f=>f.Id!=sourceId).ToArray());
    }
    public bool IsOwnedByChild(string sourceId,string relativePath)=>ChildScopeExclusions(sourceId).Any(child=>child=="."||WindowsUpperFolder.Contains(child,relativePath));
    public int LocalStorageWaitCount() {
        using var db=Open();using var command=db.CreateCommand();command.CommandText="SELECT count(*) FROM capture_queue q JOIN folder_sources s ON s.source_id=q.source_id WHERE q.state='storage_full' AND s.state='selected'";
        return Convert.ToInt32(command.ExecuteScalar());
    }
}

public static class WindowsCopySpace
{
    public const long GiB=1024L*1024*1024;
    // Keep headroom on the queue volume and a bounded encrypted queue, independently of source size.
    public static long Reserve(long totalBytes)=>Math.Clamp(totalBytes/100,GiB/2,GiB);
    public static bool Allows(long totalBytes,long freeBytes,long storedBytes,long encryptedBytes,long allowance)=>
        totalBytes>0&&freeBytes>=0&&storedBytes>=0&&encryptedBytes>0&&storedBytes<=allowance&&encryptedBytes<=allowance-storedBytes&&
        freeBytes>=Reserve(totalBytes)&&encryptedBytes<=freeBytes-Reserve(totalBytes);
    public static string Describe() {
        try{var drive=new DriveInfo(Path.GetPathRoot(WindowsEncryptedCopyStore.DefaultPath)!);return $"이 PC 여유 {drive.AvailableFreeSpace/(double)GiB:N1}GB · 보호 여유 {Reserve(drive.TotalSize)/(double)GiB:N1}GB · 전송 사본 최대 2GB";}
        catch{return "이 PC의 남은 공간을 확인하지 못했어요.";}
    }
}
