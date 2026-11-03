namespace Sigongnote.Windows;

/// <summary>Serial background drain; local consent and login remain the upload gate.</summary>
public sealed class WindowsUploadWorker : IDisposable
{
    private readonly WindowsStateStore state;
    private readonly Func<bool> hasLogin;
    private readonly Func<CancellationToken,Task<bool>> uploadOne;
    private readonly SemaphoreSlim wake = new(0,1);
    private readonly object sync = new();
    private CancellationTokenSource? active;
    private Task? running;
    private bool disposed;
    private string status = "대기";

    public event Action? StatusChanged;
    public string Status => Volatile.Read(ref status);

    public WindowsUploadWorker(WindowsStateStore state, Func<bool> hasLogin,
        Func<CancellationToken,Task<bool>> uploadOne)
    {
        this.state = state;
        this.hasLogin = hasLogin;
        this.uploadOne = uploadOne;
    }

    public void Start()
    {
        lock (sync) {
            if (disposed) throw new ObjectDisposedException(nameof(WindowsUploadWorker));
            if (active is not null) return;
            state.RecoverInterruptedUploads();
            active = new CancellationTokenSource();
            var token = active.Token;
            running = Task.Run(() => RunAsync(token));
        }
        RequestUpload();
    }

    public void RequestUpload()
    {
        lock (sync) {
            if (active is not null && wake.CurrentCount == 0) wake.Release();
        }
    }

    public void Pause()
    {
        CancellationTokenSource? stop;
        Task? task;
        lock (sync) {
            stop = active;
            task = running;
            active = null;
            running = null;
            stop?.Cancel();
        }
        task?.GetAwaiter().GetResult();
        stop?.Dispose();
        while (wake.Wait(0)) { }
        state.RecoverInterruptedUploads();
        SetStatus("중지됨");
    }

    private async Task RunAsync(CancellationToken cancellation)
    {
        try {
            while (!cancellation.IsCancellationRequested) {
                await wake.WaitAsync(TimeSpan.FromMinutes(1),cancellation);
                if (!hasLogin()) { SetStatus("로그인 필요"); continue; }
                SetStatus("전송 확인 중");
                var processed = false;
                for (var count = 0; count < 20; count++) {
                    cancellation.ThrowIfCancellationRequested();
                    try { processed = await uploadOne(cancellation); }
                    catch (OperationCanceledException) when (cancellation.IsCancellationRequested) {
                        throw;
                    }
                    catch (WindowsLoginRequiredException) {
                        SetStatus("로그인 다시 필요");
                        break;
                    } catch (Exception error) when (error is WindowsSessionUnavailableException or
                        HttpRequestException or IOException or UnauthorizedAccessException) {
                        state.RecoverInterruptedUploads();
                        SetStatus("서버 또는 파일 연결 대기");
                        break;
                    } catch (Exception) {
                        state.RecoverInterruptedUploads();
                        SetStatus("전송 확인 필요");
                        break;
                    }
                    if (!processed) { SetStatus("대기"); break; }
                    SetStatus("전송 처리 중");
                    if (count == 19) RequestUpload();
                }
            }
        } catch (OperationCanceledException) when (cancellation.IsCancellationRequested) {
            // Pause/exit drains the in-flight request before its encrypted copy is disposed.
        }
    }

    private void SetStatus(string value)
    {
        Volatile.Write(ref status,value);
        try { StatusChanged?.Invoke(); } catch (InvalidOperationException) { }
    }

    public void Dispose()
    {
        if (disposed) return;
        Pause();
        lock (sync) disposed = true;
        wake.Dispose();
    }
}
