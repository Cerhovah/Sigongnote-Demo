using System.Security.Cryptography;
using Microsoft.Data.Sqlite;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class EncryptedCopyTests
{
    private static string NewSandbox() => Path.Combine(Path.GetTempPath(),
        "sigongnote-c16-copy-" + Guid.NewGuid().ToString("N"));

    [TestMethod, TestCategory("C16")]
    public void UploadRangesDecryptAcrossChunkBoundaryAndRejectTampering()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var sourceRoot = Path.Combine(sandbox,"source");
            Directory.CreateDirectory(sourceRoot);
            var sourceFile = Path.Combine(sourceRoot,"synthetic.bin");
            var original = RandomNumberGenerator.GetBytes(1024 * 1024 + 129);
            File.WriteAllBytes(sourceFile,original);
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(sourceRoot);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(source.Id,sourceRoot,sourceFile);
            stabilizer.Observe(source.Id,sourceRoot,sourceFile);
            var candidate = state.CopyCandidates().Single();
            var copyRoot = Path.Combine(sandbox,"copies");
            using var copies = new WindowsEncryptedCopyStore(state,
                RandomNumberGenerator.GetBytes(32),copyRoot);
            Assert.AreEqual(1,copies.StagePending());
            Assert.IsTrue(copies.VerifyCopy(Path.Combine(copyRoot,
                candidate.CaptureKey + ".sgn"),candidate));
            CollectionAssert.AreEqual(original[1_048_570..1_048_590],
                copies.ReadRange(candidate,1_048_570,20));
            CollectionAssert.AreEqual(original,copies.ReadRange(candidate,0,original.Length));
            Assert.ThrowsExactly<ArgumentOutOfRangeException>(() =>
                copies.ReadRange(candidate,original.Length - 1,2));
            var encrypted = Path.Combine(copyRoot,candidate.CaptureKey + ".sgn");
            using (var stream = File.Open(encrypted,FileMode.Open,FileAccess.ReadWrite)) {
                stream.Position = 24 + 4;
                var previous = stream.ReadByte();
                stream.Position--;
                stream.WriteByte((byte)(previous ^ 1));
            }
            Assert.Throws<CryptographicException>(() =>
                copies.ReadRange(candidate,0,100));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void StableOriginalBecomesVerifiedEncryptedReadyCopy()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var sourceRoot = Path.Combine(sandbox,"source");
            Directory.CreateDirectory(sourceRoot);
            var sourceFile = Path.Combine(sourceRoot,"synthetic.xlsx");
            File.WriteAllText(sourceFile,"synthetic original bytes");
            var originalHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sourceFile)));
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(sourceRoot);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(source.Id,sourceRoot,sourceFile));
            Assert.AreEqual(FileReadiness.Ready,stabilizer.Observe(source.Id,sourceRoot,sourceFile));
            var candidate = state.CopyCandidates().Single();
            var key = RandomNumberGenerator.GetBytes(32);
            var copyRoot = Path.Combine(sandbox,"copies");
            using (var copies = new WindowsEncryptedCopyStore(state,key,copyRoot)) {
                Assert.AreEqual(1,copies.StagePending());
                var encrypted = Path.Combine(copyRoot,candidate.CaptureKey + ".sgn");
                Assert.IsTrue(File.Exists(encrypted));
                Assert.IsTrue(copies.VerifyCopy(encrypted,candidate));
                Assert.IsFalse(Convert.ToHexString(File.ReadAllBytes(encrypted)).Contains(
                    Convert.ToHexString(System.Text.Encoding.UTF8.GetBytes("synthetic original")),
                    StringComparison.Ordinal));
                Assert.AreEqual(0,copies.StagePending());
                var bytes = File.ReadAllBytes(encrypted);
                bytes[^1] ^= 1;
                File.WriteAllBytes(encrypted,bytes);
                Assert.IsFalse(copies.VerifyCopy(encrypted,candidate));
            }
            Assert.AreEqual(originalHash,Convert.ToHexString(
                SHA256.HashData(File.ReadAllBytes(sourceFile))));
            Assert.AreEqual(1,new WindowsStateStore(Path.Combine(sandbox,"state.db")).PendingCount());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void ChangedSourceAndInterruptedStageNeverClaimReady()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var sourceRoot = Path.Combine(sandbox,"source");
            Directory.CreateDirectory(sourceRoot);
            var sourceFile = Path.Combine(sourceRoot,"synthetic.hwp");
            File.WriteAllText(sourceFile,"before");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(sourceRoot);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(source.Id,sourceRoot,sourceFile));
            Assert.AreEqual(FileReadiness.Ready,stabilizer.Observe(source.Id,sourceRoot,sourceFile));
            var candidate = state.CopyCandidates().Single();
            Assert.IsTrue(state.BeginCopy(candidate.CaptureKey));
            Assert.AreEqual(0,state.CopyCandidates().Count);
            state.RecoverInterruptedCopies();
            Assert.AreEqual(1,state.CopyCandidates().Count);
            File.WriteAllText(sourceFile,"after-save");
            File.SetLastWriteTimeUtc(sourceFile,DateTime.UtcNow.AddSeconds(3));
            using var copies = new WindowsEncryptedCopyStore(state,
                RandomNumberGenerator.GetBytes(32),Path.Combine(sandbox,"copies"));
            Assert.AreEqual(0,copies.StagePending());
            Assert.AreEqual(0,Directory.GetFiles(Path.Combine(sandbox,"copies"),"*.sgn").Length);
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT state FROM capture_queue WHERE capture_key=$key;";
            command.Parameters.AddWithValue("$key",candidate.CaptureKey);
            Assert.AreEqual("source_changed",command.ExecuteScalar());
            Assert.AreEqual(1,state.CopyIssueCount());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void DisconnectedFolderIsRetriedWhenItReturns()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var sourceRoot = Path.Combine(sandbox,"source");
            Directory.CreateDirectory(sourceRoot);
            var sourceFile = Path.Combine(sourceRoot,"synthetic.pdf");
            File.WriteAllText(sourceFile,"synthetic");
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(sourceRoot);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(source.Id,sourceRoot,sourceFile);
            stabilizer.Observe(source.Id,sourceRoot,sourceFile);
            using var copies = new WindowsEncryptedCopyStore(state,
                RandomNumberGenerator.GetBytes(32),Path.Combine(sandbox,"copies"));
            var disconnected = Path.Combine(sandbox,"offline");
            Directory.Move(sourceRoot,disconnected);
            Assert.AreEqual(0,copies.StagePending());
            Directory.Move(disconnected,sourceRoot);
            Assert.AreEqual(1,copies.StagePending());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void OversizedAndOfflineRowsCannotStarveLocalCopy()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var largeRoot = Path.Combine(sandbox,"large");
            var offlineRoot = Path.Combine(sandbox,"offline");
            var localRoot = Path.Combine(sandbox,"local");
            Directory.CreateDirectory(largeRoot);
            Directory.CreateDirectory(offlineRoot);
            Directory.CreateDirectory(localRoot);
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var large = state.SelectFolder(largeRoot);
            var offline = state.SelectFolder(offlineRoot);
            var hash = new string('A',64);
            for (var index = 0; index < 16; index++) {
                var token = "large-" + index;
                state.RecordObservation(large.Id,token,$"video-{index}.mp4",
                    209_715_201,0,"ready",hash);
                state.QueueStableFile(large.Id,token,hash,209_715_201,
                    Guid.NewGuid().ToString("D"));
                var offlineToken = "offline-" + index;
                state.RecordObservation(offline.Id,offlineToken,$"missing-{index}.pdf",
                    1,0,"ready",hash);
                state.QueueStableFile(offline.Id,offlineToken,hash,1,
                    Guid.NewGuid().ToString("D"));
            }
            state.RecordHealth(offline.Id,"source_offline",errorCode:"volume_unavailable");
            var local = state.SelectFolder(localRoot);
            var localFile = Path.Combine(localRoot,"synthetic.xlsx");
            File.WriteAllText(localFile,"synthetic");
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(local.Id,localRoot,localFile);
            stabilizer.Observe(local.Id,localRoot,localFile);
            using var copies = new WindowsEncryptedCopyStore(state,
                RandomNumberGenerator.GetBytes(32),Path.Combine(sandbox,"copies"));
            Assert.AreEqual(1,copies.StagePending());
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT state,COUNT(*) FROM capture_queue GROUP BY state;";
            using var reader = command.ExecuteReader();
            var counts = new Dictionary<string,long>();
            while (reader.Read()) counts[reader.GetString(0)] = reader.GetInt64(1);
            Assert.AreEqual(16L,counts["too_large"]);
            Assert.AreEqual(16L,counts["discovered"]);
            Assert.AreEqual(1L,counts["ready"]);
        } finally { Directory.Delete(sandbox,true); }
    }
}
