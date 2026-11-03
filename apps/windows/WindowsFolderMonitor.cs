namespace Sigongnote.Windows;

/// <summary>Watcher events are hints; startup and 15-minute reconciliation are authoritative.</summary>
public sealed class WindowsFolderMonitor : IDisposable
{
    private readonly WindowsStateStore state;
    private readonly WindowsFolderReconciler reconciler;
    private readonly WindowsEncryptedCopyStore? copies;
    private readonly Func<FolderConnection,bool>? includes;
    private readonly Dictionary<string,FileSystemWatcher> watchers = [];
    private readonly SemaphoreSlim gate = new(1,1);
    private readonly System.Threading.Timer periodic;
    private readonly System.Threading.Timer debounce;
    private readonly System.Threading.Timer copyRetry;
    private readonly object sync = new();
    private int rerunRequested;
    private bool disposed;

    public event Action? StatusChanged;

    public WindowsFolderMonitor(WindowsStateStore state,
        WindowsEncryptedCopyStore? copies = null,Func<FolderConnection,bool>? includes=null)
    {
        this.state = state;
        this.copies = copies;
        this.includes = includes;
        reconciler = new WindowsFolderReconciler(state);
        periodic = new System.Threading.Timer(_ => RunReconcile(),null,Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan);
        debounce = new System.Threading.Timer(_ => RunReconcile(),null,Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan);
        copyRetry = new System.Threading.Timer(_=>RetryCopies(),null,Timeout.InfiniteTimeSpan,Timeout.InfiniteTimeSpan);
    }

    public void Start() {periodic.Change(TimeSpan.Zero,TimeSpan.FromMinutes(15));copyRetry.Change(TimeSpan.FromSeconds(30),TimeSpan.FromSeconds(30));}

    private async void RetryCopies() {
        if(copies is null||!await gate.WaitAsync(0))return;
        try{if(!disposed&&state.LocalStorageWaitCount()>0){var staged=await Task.Run(()=>copies.StagePending());if(staged>0)StatusChanged?.Invoke();}}
        catch{/* Existing encrypted queue remains available for the next retry. */}
        finally{gate.Release();}
    }

    public void RequestReconcile() => Schedule(TimeSpan.FromSeconds(2));

    private void Schedule(TimeSpan after)
    {
        lock (sync) {
            if (!disposed) debounce.Change(after,Timeout.InfiniteTimeSpan);
        }
    }

    private async void RunReconcile()
    {
        if (!await gate.WaitAsync(0)) {
            Interlocked.Exchange(ref rerunRequested,1);
            return;
        }
        try {
            if (disposed) return;
            var results = await Task.Run(()=>reconciler.Reconcile(includes));
            lock (sync) {
                if (disposed) return;
                var active = results.Where(result => (result.Health == "current" || result.Health == "scan_gap") &&
                    result.CurrentPath != null).ToDictionary(result => result.SourceId);
                foreach (var id in watchers.Keys.Except(active.Keys).ToArray()) {
                    watchers[id].Dispose();
                    watchers.Remove(id);
                }
                foreach (var result in active.Values) {
                    var path = result.CurrentPath!;
                    if (watchers.TryGetValue(result.SourceId,out var old)) {
                        if (string.Equals(old.Path,path,StringComparison.OrdinalIgnoreCase)) continue;
                        old.Dispose();
                        watchers.Remove(result.SourceId);
                    }
                    try {
                        var watcher = new FileSystemWatcher(path) {
                            IncludeSubdirectories = true,
                            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName |
                                NotifyFilters.LastWrite | NotifyFilters.Size,
                        };
                        watcher.Changed += (_,_) => RequestReconcile();
                        watcher.Created += (_,_) => RequestReconcile();
                        watcher.Deleted += (_,_) => RequestReconcile();
                        watcher.Renamed += (_,_) => RequestReconcile();
                        watcher.Error += (_,_) => {
                            try { state.RecordHealth(result.SourceId,"scan_gap",
                                errorCode:"watcher_gap"); }
                            catch (Exception) { /* Periodic reconciliation retries DB errors. */ }
                            RequestReconcile();
                        };
                        watcher.EnableRaisingEvents = true;
                        watchers[result.SourceId] = watcher;
                    } catch (Exception error) when (error is IOException or
                        UnauthorizedAccessException) {
                        state.RecordHealth(result.SourceId,"scan_gap",
                            errorCode:"watcher_unavailable");
                    }
                }
            }
            var staged=copies?.StagePending() ?? 0;
            if (staged>0 || results.Any(result => result.Pending > 0 || result.More)) RequestReconcile();
            else if (results.Any(result => result.Locked > 0))
                Schedule(TimeSpan.FromSeconds(30));
            StatusChanged?.Invoke();
        } catch (Exception) {
            // The periodic pass remains scheduled; no source deletion is inferred.
        } finally {
            gate.Release();
            if (Interlocked.Exchange(ref rerunRequested,0) != 0) RequestReconcile();
        }
    }

    public void Dispose()
    {
        lock (sync) {
            if (disposed) return;
            disposed = true;
            periodic.Dispose();
            debounce.Dispose();
            copyRetry.Dispose();
            foreach (var watcher in watchers.Values) watcher.Dispose();
            watchers.Clear();
        }
    }
}
