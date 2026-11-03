using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Sigongnote.Windows;

/// <summary>Creates app-private encrypted snapshots without changing source files.</summary>
public sealed class WindowsEncryptedCopyStore : IDisposable
{
    private const int ChunkBytes = 1024 * 1024;
    private const long MaxFileBytes = 209_715_200;
    private const long MaxPendingBytes = 2L * 1024 * 1024 * 1024;
    private readonly WindowsStateStore state;
    private readonly byte[] key;
    private readonly string root;

    public WindowsEncryptedCopyStore(WindowsStateStore state, byte[] queueKey, string root)
    {
        if (queueKey.Length != 32) throw new ArgumentException("Queue key must be 32 bytes");
        this.state = state;
        key = (byte[])queueKey.Clone();
        this.root = Path.GetFullPath(root);
        Directory.CreateDirectory(this.root);
    }

    public static string DefaultPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Sigongnote","copies");

    public long StoredBytes => Directory.EnumerateFiles(root,"*.sgn").Sum(file=>new FileInfo(file).Length);
    public static long EncryptedSize(long size) => checked(24+size+20*((size+ChunkBytes-1)/ChunkBytes));
    public void DeleteManagedCopy(string captureKey)
    {
        if(!Guid.TryParse(captureKey,out var id)||id.ToString("D")!=captureKey)throw new ArgumentException("Invalid copy");
        var path=Path.Combine(root,captureKey+".sgn");
        if(File.Exists(path)) {
            if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new IOException("Copy link rejected");
            File.Delete(path);
        }
    }

    public int StagePending(int maximum = 16)
    {
        var staged = 0;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var batch = 0; batch < 4 && staged < maximum; batch++) {
            var recent = state.CopyCandidates(maximum);
            var candidates = recent.Take(3).Concat(state.CopyCandidates(1,true)).Concat(recent.Skip(3))
                .Where(candidate => seen.Add(candidate.CaptureKey)).ToArray();
            if (candidates.Length == 0) break;
            foreach (var candidate in candidates) {
                if(staged>=maximum)break;
                if (Stage(candidate)) staged++;
            }
        }
        return staged;
    }

    public bool Stage(CopyCandidate candidate)
    {
        if (!Guid.TryParse(candidate.CaptureKey,out _) || !state.BeginCopy(candidate.CaptureKey))
            return false;
        var destination = Path.Combine(root,candidate.CaptureKey + ".sgn");
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".new";
        try {
            var usedBytes=StoredBytes;
            var drive=new DriveInfo(Path.GetPathRoot(root)!);
            if(!state.FolderScopeAllows(candidate)){state.CompleteCopy(candidate.CaptureKey,"scope_excluded");return false;}
            var allowance=candidate.WriteTicks>=DateTime.UtcNow.AddDays(-7).Ticks ? MaxPendingBytes : MaxPendingBytes*9/10;
            if (candidate.ByteSize is < 1 or > MaxFileBytes) {
                state.CompleteCopy(candidate.CaptureKey,"too_large");
                return false;
            }
            if (!WindowsCopySpace.Allows(drive.TotalSize,drive.AvailableFreeSpace,usedBytes,EncryptedSize(candidate.ByteSize),allowance)) {
                state.CompleteCopy(candidate.CaptureKey,"storage_full");
                return false;
            }
            if (File.Exists(destination) && VerifyCopy(destination,candidate)) {
                state.CompleteCopy(candidate.CaptureKey,"ready");
                return true;
            }
            var folder = state.Folders().SingleOrDefault(item => item.Id == candidate.SourceId);
            if (folder is null || folder.State != "selected" || folder.VolumeId is null ||
                folder.VolumeSerial is null || folder.RelativePath is null) {
                state.CompleteCopy(candidate.CaptureKey,"source_unavailable");
                return false;
            }
            var sourceRoot = new WindowsVolumeIdentity(folder.VolumeId,folder.VolumeSerial,
                "",folder.RelativePath).FindCurrentPath();
            if (sourceRoot is null) {
                state.CompleteCopy(candidate.CaptureKey,"source_unavailable");
                return false;
            }
            var sourcePath = Path.GetFullPath(Path.Combine(sourceRoot,candidate.RelativePath));
            if (!IsWithin(sourceRoot,sourcePath) || HasReparseComponent(sourceRoot,sourcePath)) {
                state.CompleteCopy(candidate.CaptureKey,"copy_error");
                return false;
            }
            if (!SourceMatches(sourcePath,candidate)) {
                state.CompleteCopy(candidate.CaptureKey,"source_changed");
                return false;
            }
            if (!EncryptSnapshot(sourcePath,temporary,candidate) ||
                (!state.SourceSelected(candidate.SourceId)||!state.FolderScopeAllows(candidate))) {
                state.CompleteCopy(candidate.CaptureKey,"source_changed");
                return false;
            }
            File.Move(temporary,destination,true);
            state.CompleteCopy(candidate.CaptureKey,"ready");
            return true;
        } catch (IOException error) {
            state.CompleteCopy(candidate.CaptureKey,IsDiskFull(error) ? "storage_full" :
                "source_unavailable");
            return false;
        } catch (UnauthorizedAccessException) {
            state.CompleteCopy(candidate.CaptureKey,"source_unavailable");
            return false;
        } finally {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public bool VerifyCopy(string path, CopyCandidate candidate)
    {
        try {
            using var input = new BinaryReader(File.OpenRead(path));
            if (new string(input.ReadChars(4)) != "SGN1") return false;
            var prefix = input.ReadBytes(8);
            if (prefix.Length != 8 || input.ReadInt32() != ChunkBytes ||
                input.ReadInt64() != candidate.ByteSize) return false;
            using var aes = new AesGcm(key,16);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long remaining = candidate.ByteSize;
            uint index = 0;
            while (remaining > 0) {
                var count = input.ReadInt32();
                if (count != Math.Min(ChunkBytes,remaining)) return false;
                var ciphertext = input.ReadBytes(count);
                var tag = input.ReadBytes(16);
                if (ciphertext.Length != count || tag.Length != 16) return false;
                var plaintext = new byte[count];
                aes.Decrypt(Nonce(prefix,index++),ciphertext,tag,plaintext);
                hash.AppendData(plaintext);
                remaining -= count;
            }
            return input.BaseStream.Position == input.BaseStream.Length &&
                string.Equals(Convert.ToHexString(hash.GetHashAndReset()),
                    candidate.ContentSha256,StringComparison.OrdinalIgnoreCase);
        } catch (Exception error) when (error is IOException or CryptographicException or
            EndOfStreamException) { return false; }
    }

    public bool VerifyCopy(CopyCandidate candidate) => VerifyCopy(
        Path.Combine(root,candidate.CaptureKey + ".sgn"),candidate);

    /// <summary>Decrypts one bounded upload range in memory; no plaintext file is created.</summary>
    public byte[] ReadRange(CopyCandidate candidate, long offset, int length)
    {
        if (!Guid.TryParse(candidate.CaptureKey,out _) || offset < 0 || length < 1 ||
            length > 6 * 1024 * 1024 || offset > candidate.ByteSize - length)
            throw new ArgumentOutOfRangeException(nameof(offset));
        var path = Path.Combine(root,candidate.CaptureKey + ".sgn");
        using var input = new BinaryReader(new FileStream(path,FileMode.Open,
            FileAccess.Read,FileShare.Read,ChunkBytes,FileOptions.SequentialScan));
        if (new string(input.ReadChars(4)) != "SGN1")
            throw new CryptographicException("Invalid encrypted copy");
        var prefix = input.ReadBytes(8);
        if (prefix.Length != 8 || input.ReadInt32() != ChunkBytes ||
            input.ReadInt64() != candidate.ByteSize)
            throw new CryptographicException("Invalid encrypted copy");
        var result = new byte[length];
        var written = 0;
        using var aes = new AesGcm(key,16);
        while (written < length) {
            var position = offset + written;
            var index = position / ChunkBytes;
            var within = (int)(position % ChunkBytes);
            input.BaseStream.Position = 24 + index * (ChunkBytes + 20L);
            var expected = (int)Math.Min(ChunkBytes,candidate.ByteSize - index * ChunkBytes);
            if (input.ReadInt32() != expected)
                throw new CryptographicException("Invalid encrypted chunk");
            var ciphertext = input.ReadBytes(expected);
            var tag = input.ReadBytes(16);
            if (ciphertext.Length != expected || tag.Length != 16)
                throw new CryptographicException("Truncated encrypted chunk");
            var plaintext = new byte[expected];
            try {
                aes.Decrypt(Nonce(prefix,checked((uint)index)),ciphertext,tag,plaintext);
                var amount = Math.Min(length - written,expected - within);
                plaintext.AsSpan(within,amount).CopyTo(result.AsSpan(written));
                written += amount;
            } finally { CryptographicOperations.ZeroMemory(plaintext); }
        }
        return result;
    }

    private bool EncryptSnapshot(string sourcePath, string temporary, CopyCandidate candidate)
    {
        var metadata = new FileInfo(sourcePath);
        metadata.Refresh();
        if (metadata.Length != candidate.ByteSize ||
            metadata.LastWriteTimeUtc.Ticks != candidate.WriteTicks) return false;
        using var source = new FileStream(sourcePath,FileMode.Open,FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,ChunkBytes,FileOptions.SequentialScan);
        using var output = new BinaryWriter(new FileStream(temporary,FileMode.CreateNew,
            FileAccess.Write,FileShare.None,ChunkBytes,FileOptions.WriteThrough));
        var prefix = RandomNumberGenerator.GetBytes(8);
        output.Write("SGN1".ToCharArray());
        output.Write(prefix);
        output.Write(ChunkBytes);
        output.Write(candidate.ByteSize);
        using var aes = new AesGcm(key,16);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var plaintext = new byte[ChunkBytes];
        var ciphertext = new byte[ChunkBytes];
        var tag = new byte[16];
        long remaining = candidate.ByteSize;
        uint index = 0;
        while (remaining > 0) {
            var count = (int)Math.Min(ChunkBytes,remaining);
            source.ReadExactly(plaintext.AsSpan(0,count));
            hash.AppendData(plaintext,0,count);
            aes.Encrypt(Nonce(prefix,index++),plaintext.AsSpan(0,count),
                ciphertext.AsSpan(0,count),tag);
            output.Write(count);
            output.Write(ciphertext,0,count);
            output.Write(tag);
            remaining -= count;
        }
        output.Flush();
        source.Dispose();
        metadata.Refresh();
        return metadata.Exists && metadata.Length == candidate.ByteSize &&
            metadata.LastWriteTimeUtc.Ticks == candidate.WriteTicks &&
            string.Equals(Convert.ToHexString(hash.GetHashAndReset()),
                candidate.ContentSha256,StringComparison.OrdinalIgnoreCase) &&
            string.Equals(HashPath(sourcePath),
                candidate.ContentSha256,StringComparison.OrdinalIgnoreCase);
    }

    private static string HashPath(string path)
    {
        using var stream = new FileStream(path,FileMode.Open,FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,ChunkBytes,FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static byte[] Nonce(byte[] prefix, uint index)
    {
        var nonce = new byte[12];
        prefix.CopyTo(nonce,0);
        BinaryPrimitives.WriteUInt32BigEndian(nonce.AsSpan(8),index);
        return nonce;
    }

    private static bool SourceMatches(string path, CopyCandidate candidate)
    {
        var info = new FileInfo(path);
        info.Refresh();
        return info.Exists && info.Length == candidate.ByteSize &&
            info.LastWriteTimeUtc.Ticks == candidate.WriteTicks;
    }

    private static bool IsWithin(string root, string path)
    {
        var prefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) +
            Path.DirectorySeparatorChar;
        return path.StartsWith(prefix,StringComparison.OrdinalIgnoreCase);
    }

    private static bool HasReparseComponent(string root, string path)
    {
        var relative = Path.GetRelativePath(root,path);
        var current = root;
        foreach (var part in relative.Split(Path.DirectorySeparatorChar,
            StringSplitOptions.RemoveEmptyEntries)) {
            current = Path.Combine(current,part);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
        }
        return false;
    }

    private static bool IsDiskFull(IOException error) =>
        (error.HResult & 0xFFFF) is 112 or 39;

    public void Dispose() => CryptographicOperations.ZeroMemory(key);
}
