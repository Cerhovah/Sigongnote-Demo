using System.ComponentModel;

namespace Sigongnote.Windows;

public sealed record FolderScanResult(string SourceId, string Health, string? CurrentPath,
    int Candidates, int Pending = 0, int Locked = 0, bool More = false);

/// <summary>Rechecks selected scopes; missing volumes are never interpreted as deleted files.</summary>
public sealed class WindowsFolderReconciler(WindowsStateStore state)
{
    private readonly WindowsFileStabilizer stabilizer = new(state);

    public IReadOnlyList<FolderScanResult> Reconcile(Func<FolderConnection,bool>? includes=null)
    {
        var results = new List<FolderScanResult>();
        foreach (var folder in state.Folders()) {
            if(includes is not null&&!includes(folder))continue;
            if (folder.State != "selected") {
                state.RecordHealth(folder.Id,"paused");
                results.Add(new FolderScanResult(folder.Id,"paused",null,0));
                continue;
            }
            if (folder.VolumeId == null || folder.VolumeSerial == null ||
                folder.RelativePath == null) {
                state.RecordHealth(folder.Id,"scan_gap",errorCode:"volume_identity_missing");
                results.Add(new FolderScanResult(folder.Id,"scan_gap",null,0));
                continue;
            }
            try {
                var identity = new WindowsVolumeIdentity(folder.VolumeId,
                    folder.VolumeSerial,"",folder.RelativePath);
                var path = identity.FindCurrentPath();
                if (path == null) {
                    state.RecordHealth(folder.Id,"source_offline",errorCode:"volume_unavailable");
                    results.Add(new FolderScanResult(folder.Id,"source_offline",null,0));
                    continue;
                }
                var result = state.ScanFolderBatch(folder.Id,path,stabilizer);
                state.RememberMountedPath(folder,path);
                state.RecordHealth(folder.Id,result.Health,result.Candidates,
                    result.More ? "backlog_pending" : result.Health=="scan_gap" ? "partial_inventory" : null);
                results.Add(result);
            } catch (Exception error) when (error is IOException or UnauthorizedAccessException or
                Win32Exception) {
                state.RecordHealth(folder.Id,"scan_gap",errorCode:
                    error is WindowsInventoryLimitException ? "inventory_limit" :
                    "inventory_unavailable");
                results.Add(new FolderScanResult(folder.Id,"scan_gap",null,0));
            }
        }
        return results;
    }

}
