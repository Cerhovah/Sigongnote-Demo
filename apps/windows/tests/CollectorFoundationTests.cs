using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class CollectorFoundationTests
{
    private static string NewSandbox() => Path.Combine(Path.GetTempPath(),
        "sigongnote-c14-" + Guid.NewGuid().ToString("N"));

    [TestMethod, TestCategory("C14")]
    public void ProtectedFolderScopeAndTokenNeverPersistPlaintext()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"synthetic-work");
            Directory.CreateDirectory(folder);
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var selected = state.SelectFolder(folder);
            Assert.AreEqual("selected",selected.State);
            Assert.AreEqual(selected.Id,state.SelectFolder(folder).Id);
            Assert.AreEqual(1,state.Folders().Count);
            Assert.AreEqual(folder,new WindowsStateStore(database).Folders()[0].RootPath);
            Assert.IsFalse(Encoding.UTF8.GetString(File.ReadAllBytes(database)).Contains(folder,
                StringComparison.Ordinal));
            var tokenPath = Path.Combine(sandbox,"session.protected");
            var tokens = new WindowsTokenVault(tokenPath);
            tokens.Save("fixture-session-value");
            Assert.AreEqual("fixture-session-value",tokens.Read());
            Assert.IsFalse(Encoding.UTF8.GetString(File.ReadAllBytes(tokenPath)).Contains(
                "fixture-session-value",StringComparison.Ordinal));
            tokens.Clear();
            Assert.IsNull(tokens.Read());
            var queueKeyPath = Path.Combine(sandbox,"queue-key.protected");
            var firstKey = new WindowsQueueKey(queueKeyPath).GetOrCreate();
            Assert.AreEqual(32,firstKey.Length);
            CollectionAssert.AreEqual(firstKey,new WindowsQueueKey(queueKeyPath).GetOrCreate());
            Assert.IsFalse(File.ReadAllBytes(queueKeyPath).AsSpan().IndexOf(firstKey) >= 0);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C14")]
    public void LogoutPausesQueueAndSourcesWithoutEditingOriginal()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"synthetic-work");
            Directory.CreateDirectory(folder);
            var original = Path.Combine(folder,"original.xlsx");
            File.WriteAllText(original,"synthetic original");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(folder);
            var connectionString = new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString();
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var insert = connection.CreateCommand();
                insert.CommandText = "INSERT INTO capture_queue(capture_key,source_id,state,created_at,updated_at) VALUES($key,$source,'ready',$now,$now);";
                insert.Parameters.AddWithValue("$key",Guid.NewGuid().ToString("D"));
                insert.Parameters.AddWithValue("$source",source.Id);
                insert.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
                insert.ExecuteNonQuery();
            }
            Assert.AreEqual(1,state.PendingCount());
            state.Logout();
            Assert.AreEqual("paused",new WindowsStateStore(database).Folders()[0].State);
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var query = connection.CreateCommand();
                query.CommandText = "SELECT state FROM capture_queue LIMIT 1;";
                Assert.AreEqual("paused_logout",query.ExecuteScalar());
            }
            Assert.AreEqual("synthetic original",File.ReadAllText(original));
            Assert.AreEqual(source.Id,state.SelectFolder(folder).Id);
            Assert.AreEqual(1,state.Folders().Count);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C14")]
    public void UnreadableQueueKeyIsPreservedAndQueueRequiresReview()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"synthetic-work");
            Directory.CreateDirectory(folder);
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(folder);
            var connectionString = new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString();
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var insert = connection.CreateCommand();
                insert.CommandText = "INSERT INTO capture_queue(capture_key,source_id,state,created_at,updated_at) VALUES($key,$source,'ready',$now,$now);";
                insert.Parameters.AddWithValue("$key",Guid.NewGuid().ToString("D"));
                insert.Parameters.AddWithValue("$source",source.Id);
                insert.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
                insert.ExecuteNonQuery();
            }
            var keyPath = Path.Combine(sandbox,"queue-key.protected");
            var vault = new WindowsQueueKey(keyPath);
            Assert.AreEqual(32,vault.GetOrCreate().Length);
            byte[] invalid = [1,2,3,4];
            File.WriteAllBytes(keyPath,invalid);
            var replacement = vault.GetOrCreate(state.MarkKeyUnrecoverable);
            Assert.AreEqual(32,replacement.Length);
            Assert.IsTrue(state.HadKeyReset());
            Assert.AreEqual("paused",state.Folders()[0].State);
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var query = connection.CreateCommand();
                query.CommandText = "SELECT state FROM capture_queue LIMIT 1;";
                Assert.AreEqual("local_key_lost",query.ExecuteScalar());
            }
            var backups = Directory.GetFiles(sandbox,"queue-key.protected.unrecoverable-*");
            Assert.AreEqual(1,backups.Length);
            CollectionAssert.AreEqual(invalid,File.ReadAllBytes(backups[0]));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void SelectedFolderUsesVolumeIdentityAndRelativePath()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var first = Path.Combine(sandbox,"first");
            var second = Path.Combine(sandbox,"second");
            Directory.CreateDirectory(first);
            Directory.CreateDirectory(second);
            var identity = WindowsVolumeIdentity.Probe(first);
            var other = WindowsVolumeIdentity.Probe(second);
            Assert.AreEqual(identity.VolumeId,other.VolumeId);
            Assert.IsFalse(identity.SameSource(other));
            Assert.AreEqual(first,identity.FindCurrentPath());
            Assert.AreEqual(first,(identity with {
                VolumeId = identity.VolumeId.ToUpperInvariant()
            }).FindCurrentPath());
            Assert.IsFalse(identity.SameSource(other with { RelativePath = identity.RelativePath,
                Serial = "FFFFFFFF" }));
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var selected = state.SelectFolder(first);
            Assert.AreEqual(identity.VolumeId,selected.VolumeId);
            Assert.AreEqual(identity.RelativePath,selected.RelativePath);
            Assert.AreEqual(selected.Id,state.SelectFolder(first).Id);
            Assert.AreNotEqual(selected.Id,state.SelectFolder(second).Id);
            Assert.AreEqual(2,state.Folders().Count);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void VersionOneSourceMustReauthorizeBeforeVolumeScanning()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"synthetic-work");
            Directory.CreateDirectory(folder);
            var database = Path.Combine(sandbox,"state.db");
            var connectionString = new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString();
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var setup = connection.CreateCommand();
                setup.CommandText = """
                    CREATE TABLE folder_sources(source_id TEXT PRIMARY KEY,
                        root_protected BLOB NOT NULL,state TEXT NOT NULL,added_at TEXT NOT NULL);
                    CREATE TABLE capture_queue(capture_key TEXT PRIMARY KEY,
                        source_id TEXT NOT NULL,state TEXT NOT NULL,
                        created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
                    CREATE TABLE local_settings(setting_key TEXT PRIMARY KEY,
                        setting_value TEXT NOT NULL);
                    PRAGMA user_version=1;
                    """;
                setup.ExecuteNonQuery();
                using var insert = connection.CreateCommand();
                insert.CommandText = "INSERT INTO folder_sources VALUES($id,$root,'selected',$added);";
                insert.Parameters.AddWithValue("$id",Guid.NewGuid().ToString("D"));
                insert.Parameters.Add("$root",SqliteType.Blob).Value =
                    new WindowsSecretStore().Protect(folder);
                insert.Parameters.AddWithValue("$added",DateTimeOffset.UtcNow.ToString("O"));
                insert.ExecuteNonQuery();
            }
            var state = new WindowsStateStore(database);
            Assert.AreEqual("needs_reauthorization",state.Folders()[0].State);
            Assert.IsNull(state.Folders()[0].VolumeId);
            Assert.AreEqual("needs_reauthorization",new WindowsStateStore(database).Folders()[0].State);
            var formerId = state.Folders()[0].Id;
            Assert.AreEqual(formerId,state.SelectFolder(folder).Id);
            Assert.AreEqual(1,state.Folders().Count);
            Assert.AreEqual("selected",state.Folders()[0].State);
            using (var verify = new SqliteConnection(connectionString)) {
                verify.Open();
                using var version = verify.CreateCommand();
                version.CommandText = "PRAGMA user_version;";
                Assert.AreEqual(11L,Convert.ToInt64(version.ExecuteScalar()));
            }
        } finally { Directory.Delete(sandbox,true); }
    }
}
