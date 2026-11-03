using System.Security.Cryptography;
using System.Text;

namespace Sigongnote.Windows;

public enum FileReadiness { Delayed, Locked, Ready }

/// <summary>Promotes only a twice-observed, unchanged file to the local upload queue.</summary>
public sealed class WindowsFileStabilizer(WindowsStateStore state,
    TimeSpan? settleDelay = null)
{
    private readonly TimeSpan delay = settleDelay ?? TimeSpan.FromSeconds(2);

    public FileReadiness Observe(string sourceId, string root, string path)
    {
        if (!state.SourceSelected(sourceId)) return FileReadiness.Delayed;
        var relative = Path.GetRelativePath(root,path);
        if (Path.IsPathRooted(relative) || relative == ".." ||
            relative.StartsWith(".." + Path.DirectorySeparatorChar,StringComparison.Ordinal))
            throw new IOException("File outside selected scope");
        var token = PathToken(sourceId,relative);
        FileInfo before;
        try {
            before = new FileInfo(path);
            before.Refresh();
            if (!before.Exists) return FileReadiness.Delayed;
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
            return FileReadiness.Locked;
        }
        var prior = state.Observation(sourceId,token);
        var size = before.Length;
        var ticks = before.LastWriteTimeUtc.Ticks;
        if (prior == null || prior.Size != size || prior.WriteTicks != ticks) {
            state.RecordObservation(sourceId,token,relative,size,ticks,"unstable");
            return FileReadiness.Delayed;
        }
        if (prior.State == "ready" && prior.ContentSha256 is { } oldHash) {
            state.QueueStableFile(sourceId,token,oldHash,size,
                CaptureKey(sourceId,token,oldHash));
            return FileReadiness.Ready;
        }
        if (DateTimeOffset.UtcNow - prior.SeenAt < delay)
            return FileReadiness.Delayed;
        if (!state.SourceSelected(sourceId)) return FileReadiness.Delayed;
        try {
            var first = HashCurrentPath(path);
            var second = HashCurrentPath(path);
            before.Refresh();
            if (size != before.Length || ticks != before.LastWriteTimeUtc.Ticks ||
                !string.Equals(first,second,StringComparison.Ordinal)) {
                state.RecordObservation(sourceId,token,relative,before.Length,
                    before.LastWriteTimeUtc.Ticks,"unstable");
                return FileReadiness.Delayed;
            }
            if (!state.SourceSelected(sourceId)) return FileReadiness.Delayed;
            state.RecordObservation(sourceId,token,relative,size,ticks,"ready",first);
            state.QueueStableFile(sourceId,token,first,size,CaptureKey(sourceId,token,first));
            return FileReadiness.Ready;
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
            state.RecordObservation(sourceId,token,relative,size,ticks,"locked");
            return FileReadiness.Locked;
        }
    }

    public static string PathToken(string sourceId, string relativePath) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            sourceId + "\0" + relativePath.ToUpperInvariant())));

    private static string HashCurrentPath(string path)
    {
        using var stream = new FileStream(path,FileMode.Open,FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,1024 * 1024,FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    internal static string CaptureKey(string sourceId, string token, string hash)
    {
        var hex = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            sourceId + "\0" + token + "\0" + hash))).ToLowerInvariant();
        return $"{hex[..8]}-{hex[8..12]}-5{hex[13..16]}-8{hex[17..20]}-{hex[20..32]}";
    }
}
