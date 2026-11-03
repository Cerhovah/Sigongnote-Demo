using System.Security.Cryptography;
using Microsoft.Data.Sqlite;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class FileStabilityTests
{
    private static string NewSandbox() => Path.Combine(Path.GetTempPath(),
        "sigongnote-c15-stability-" + Guid.NewGuid().ToString("N"));

    [TestMethod, TestCategory("C15")]
    public void TwoStableObservationsQueueOneHashAndSurviveRestart()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var sourceFile = Path.Combine(root,"synthetic.xlsx");
            File.WriteAllText(sourceFile,"synthetic source only");
            var expected = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sourceFile)));
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(root);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(source.Id,root,sourceFile));
            Assert.AreEqual(0,state.PendingCount());
            Assert.AreEqual(FileReadiness.Ready,stabilizer.Observe(source.Id,root,sourceFile));
            using (var locked = new FileStream(sourceFile,FileMode.Open,FileAccess.Read,
                FileShare.None)) {
                Assert.AreEqual(FileReadiness.Ready,
                    stabilizer.Observe(source.Id,root,sourceFile));
            }
            Assert.AreEqual(1,state.PendingCount());
            var restarted = new WindowsStateStore(database);
            Assert.AreEqual(1,restarted.PendingCount());
            Assert.AreEqual(0,restarted.PendingFileCount());
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT content_sha256 FROM capture_queue WHERE state='discovered' LIMIT 1;";
            Assert.AreEqual(expected,command.ExecuteScalar());
            Assert.AreEqual("synthetic source only",File.ReadAllText(sourceFile));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void LockedOrChangingFileWaitsWithoutQueueingOldBytes()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var sourceFile = Path.Combine(root,"synthetic.hwp");
            File.WriteAllText(sourceFile,"old");
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(root);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(source.Id,root,sourceFile));
            using (var writer = new FileStream(sourceFile,FileMode.Open,FileAccess.ReadWrite,
                FileShare.None)) {
                Assert.AreEqual(FileReadiness.Locked,
                    stabilizer.Observe(source.Id,root,sourceFile));
                Assert.AreEqual(0,state.PendingCount());
            }
            File.WriteAllText(sourceFile,"new version");
            File.SetLastWriteTimeUtc(sourceFile,DateTime.UtcNow.AddSeconds(3));
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(source.Id,root,sourceFile));
            Assert.AreEqual(0,state.PendingCount());
            Assert.AreEqual(FileReadiness.Ready,stabilizer.Observe(source.Id,root,sourceFile));
            Assert.AreEqual(1,state.PendingCount());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void VersionThreeDatabaseMigratesFileObservationsOnce()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var database = Path.Combine(sandbox,"state.db");
            var source=Guid.NewGuid().ToString("D");var capture=Guid.NewGuid().ToString("D");
            var created=DateTimeOffset.UtcNow.ToString("O");var protectedRoot=new WindowsSecretStore().Protect(sandbox);
            var connectionString = new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString();
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var setup = connection.CreateCommand();
                setup.CommandText = """
                    CREATE TABLE folder_sources(source_id TEXT PRIMARY KEY,
                        root_protected BLOB NOT NULL,state TEXT NOT NULL,
                        added_at TEXT NOT NULL,volume_id TEXT,volume_serial TEXT,
                        relative_path_protected BLOB);
                    CREATE TABLE capture_queue(capture_key TEXT PRIMARY KEY,
                        source_id TEXT NOT NULL,state TEXT NOT NULL,
                        created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
                    CREATE TABLE local_settings(setting_key TEXT PRIMARY KEY,
                        setting_value TEXT NOT NULL);
                    CREATE TABLE source_health(source_id TEXT PRIMARY KEY,
                        state TEXT NOT NULL,last_scan_at TEXT,candidate_count INTEGER,
                        error_code TEXT);
                    PRAGMA user_version=3;
                    """;
                setup.ExecuteNonQuery();
                setup.CommandText="INSERT INTO folder_sources(source_id,root_protected,state,added_at) VALUES($source,$root,'selected',$now); INSERT INTO capture_queue(capture_key,source_id,state,created_at,updated_at) VALUES($capture,$source,'discovered',$now,$now); INSERT INTO local_settings VALUES('synthetic-preserved','original-setting');";
                setup.Parameters.AddWithValue("$source",source);setup.Parameters.AddWithValue("$capture",capture);setup.Parameters.AddWithValue("$root",protectedRoot);setup.Parameters.AddWithValue("$now",created);setup.ExecuteNonQuery();
            }
            _ = new WindowsStateStore(database);
            _ = new WindowsStateStore(database);
            using var verify = new SqliteConnection(connectionString);
            verify.Open();
            using var command = verify.CreateCommand();
            command.CommandText = "PRAGMA user_version;";
            Assert.AreEqual(11L,Convert.ToInt64(command.ExecuteScalar()));
            command.CommandText = "SELECT COUNT(*) FROM pragma_table_info('file_observations');";
            Assert.AreEqual(8L,Convert.ToInt64(command.ExecuteScalar()));
            command.CommandText="SELECT source_id,state,created_at,updated_at FROM capture_queue WHERE capture_key=$capture;";command.Parameters.AddWithValue("$capture",capture);
            using(var row=command.ExecuteReader()){
                Assert.IsTrue(row.Read());Assert.AreEqual(source,row.GetString(0));Assert.AreEqual("discovered",row.GetString(1));
                Assert.AreEqual(created,row.GetString(2));Assert.AreEqual(created,row.GetString(3));Assert.IsFalse(row.Read());
            }
            command.Parameters.Clear();command.CommandText="SELECT setting_value FROM local_settings WHERE setting_key='synthetic-preserved';";
            Assert.AreEqual("original-setting",command.ExecuteScalar());
            command.CommandText="SELECT root_protected FROM folder_sources WHERE source_id=$source;";command.Parameters.AddWithValue("$source",source);
            CollectionAssert.AreEqual(protectedRoot,(byte[])command.ExecuteScalar()!);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void PausedSourceCannotPromoteAnObservedFile()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var path = Path.Combine(root,"synthetic.pdf");
            File.WriteAllText(path,"synthetic");
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(root);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(source.Id,root,path));
            state.PauseSource(source.Id);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(source.Id,root,path));
            Assert.AreEqual(0,state.PendingCount());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void ReaderShareAllowsOfficeStyleReplacement()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var original = Path.Combine(sandbox,"work.xlsx");
            var replacement = Path.Combine(sandbox,"replacement.xlsx");
            File.WriteAllText(original,"first");
            File.WriteAllText(replacement,"second");
            using (var reader = new FileStream(original,FileMode.Open,FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete)) {
                File.Replace(replacement,original,null);
                Assert.AreEqual("second",File.ReadAllText(original));
            }
        } finally { Directory.Delete(sandbox,true); }
    }
}
