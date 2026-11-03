using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class UploadWorkerTests
{
    [TestMethod, TestCategory("C16")]
    public async Task LoginGatePauseDrainAndResumePreserveQueue()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-worker-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var loggedIn = false;
            var calls = 0;
            var cancelled = false;
            var gated = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var resumed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var worker = new WindowsUploadWorker(state,() => loggedIn,async token => {
                if (Interlocked.Increment(ref calls) == 1) {
                    started.TrySetResult();
                    try { await Task.Delay(Timeout.InfiniteTimeSpan,token); }
                    catch (OperationCanceledException) { cancelled = true; throw; }
                }
                resumed.TrySetResult();
                return false;
            });
            worker.StatusChanged += () => {
                if (worker.Status == "로그인 필요") gated.TrySetResult();
            };
            worker.Start();
            await gated.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.AreEqual(0,calls);
            loggedIn = true;
            worker.RequestUpload();
            await started.Task.WaitAsync(TimeSpan.FromSeconds(3));
            worker.Pause();
            Assert.IsTrue(cancelled);
            worker.Start();
            await resumed.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.AreEqual(2,calls);
        } finally { Directory.Delete(sandbox,true); }
    }
}
