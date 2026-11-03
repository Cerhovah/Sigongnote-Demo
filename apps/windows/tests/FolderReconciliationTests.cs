using Microsoft.Data.Sqlite;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class FolderReconciliationTests
{
    [TestMethod]
    public void RemovedPendingFileSettlesAndTrailingRootSeparatorIsAccepted()
    {
        var sandbox=NewSandbox();Directory.CreateDirectory(sandbox);
        try {
            var root=Path.Combine(sandbox,"work");Directory.CreateDirectory(root);
            var original=Path.Combine(root,"temporary.txt");File.WriteAllText(original,"fixture");
            var state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var folder=state.SelectFolder(root);
            var first=state.ScanFolderBatch(folder.Id,root+Path.DirectorySeparatorChar,new WindowsFileStabilizer(state));
            Assert.IsTrue(first.More);
            File.Move(original,Path.Combine(sandbox,"preserved-original.txt"));
            var next=state.ScanFolderBatch(folder.Id,root,new WindowsFileStabilizer(state));
            Assert.IsFalse(next.More);
            Assert.AreEqual("fixture",File.ReadAllText(Path.Combine(sandbox,"preserved-original.txt")));
        } finally { Directory.Delete(sandbox,true); }
    }
    private static string NewSandbox() => Path.Combine(Path.GetTempPath(),
        "sigongnote-c15-" + Guid.NewGuid().ToString("N"));

    [TestMethod, TestCategory("C16")]
    public void InitialScopePreviewMatchesRecentFilesInReconciliation()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root,"recent.pdf"),"fixture");
            var old = Path.Combine(root,"old.xlsx");
            File.WriteAllText(old,"fixture");
            File.SetLastWriteTimeUtc(old,DateTime.UtcNow.AddDays(-40));
            File.WriteAllText(Path.Combine(root,"private.exe"),"fixture");
            var oldBackup = Path.Combine(root,"drawing.csv.bak");
            File.WriteAllText(oldBackup,"old backup bytes");
            File.SetLastWriteTimeUtc(oldBackup,DateTime.UtcNow.AddDays(-40));
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            state.SelectFolder(root,historyDays:30);
            var preview = WindowsFolderPreview.Scan(root,state,state.Folders().Single().Id);
            Assert.AreEqual(1,preview.FileCount);
            Assert.AreEqual(3,preview.ExcludedCount);
            Assert.AreEqual(1,preview.Formats[".pdf"]);
            var reconciler = new WindowsFolderReconciler(state);
            Assert.AreEqual(1,reconciler.Reconcile().Single().Candidates);
            Assert.IsTrue(state.ScopeBaseline(state.Folders().Single().Id).Completed);
            File.Move(oldBackup,Path.Combine(root,"drawing.csv"));
            Assert.AreEqual(1,reconciler.Reconcile().Single().Candidates);
            var imported = Path.Combine(root,"new-old-drawing.csv");
            File.WriteAllText(imported,"fixture");
            File.SetLastWriteTimeUtc(imported,DateTime.UtcNow.AddDays(-40));
            Assert.AreEqual(2,reconciler.Reconcile().Single().Candidates);
            var moved = Path.Combine(root,"archived.xlsx");
            File.Move(old,moved);
            Assert.AreEqual(2,reconciler.Reconcile().Single().Candidates);
            File.WriteAllText(moved,"revised fixture with more bytes");
            File.SetLastWriteTimeUtc(moved,DateTime.UtcNow.AddDays(-40));
            Assert.AreEqual(3,reconciler.Reconcile().Single().Candidates);
            var resumed = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            Assert.AreEqual(3,WindowsFolderPreview.Scan(root,resumed,
                resumed.Folders().Single().Id).FileCount);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void VersionFiveScopeMigrationReplaysWithoutLosingSelectedFolder()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var database = Path.Combine(sandbox,"state.db");
            var initial = new WindowsStateStore(database);
            var folder = initial.SelectFolder(root);
            var historical = Path.Combine(root,"historical.xlsx");
            File.WriteAllText(historical,"fixture");
            File.SetCreationTimeUtc(historical,DateTime.UtcNow.AddDays(-45));
            File.SetLastWriteTimeUtc(historical,DateTime.UtcNow.AddDays(-45));
            var connectionString = new SqliteConnectionStringBuilder {
                DataSource = database,Pooling = false,
            }.ToString();
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = """
                    DROP TABLE excluded_baseline_files;
                    DROP TABLE folder_scope_baseline;
                    ALTER TABLE upload_attempts DROP COLUMN revision_base_protected;
                    ALTER TABLE folder_sources DROP COLUMN connect_attempt_key;
                    ALTER TABLE folder_sources DROP COLUMN attempt_device_id;
                    UPDATE folder_sources SET added_at=$old WHERE source_id=$source;
                    PRAGMA user_version=5;
                    """;
                command.Parameters.AddWithValue("$old",DateTimeOffset.UtcNow.AddDays(-60)
                    .ToString("O"));
                command.Parameters.AddWithValue("$source",folder.Id);
                command.ExecuteNonQuery();
            }
            var migrated = new WindowsStateStore(database);
            Assert.AreEqual(folder.Id,migrated.Folders().Single().Id);
            Assert.IsFalse(migrated.ScopeBaseline(folder.Id).Completed);
            Assert.IsTrue(migrated.ScopeBaseline(folder.Id).StartedUtc >
                migrated.Folders().Single().AddedAt.UtcDateTime);
            Assert.AreEqual(0,new WindowsFolderReconciler(migrated).Reconcile().Single()
                .Candidates);
            Assert.IsTrue(new WindowsStateStore(database).ScopeBaseline(folder.Id).Completed);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void LargeInventoryResumesWithoutASelectionLimit()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            for (var index = 0; index <= WindowsFolderPolicy.MaximumCandidates; index++)
                File.WriteAllText(Path.Combine(root,$"fixture-{index:D4}.pdf"),"fixture");
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var folder = state.SelectFolder(root);
            var result = new WindowsFolderReconciler(state).Reconcile().Single();
            Assert.AreEqual("scan_gap",result.Health);
            Assert.AreEqual("backlog_pending",state.Health(folder.Id)?.ErrorCode);
            var preview=WindowsFolderPreview.Scan(root,state,folder.Id);
            Assert.IsTrue(preview.Partial);
            Assert.AreEqual(0L,preview.CutoffUtc.Ticks);
            state=new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            for(var step=0;step<50 && result.More;step++) {
                result=state.ScanFolderBatch(folder.Id,root,new WindowsFileStabilizer(state,TimeSpan.Zero));
            }
            Assert.AreEqual(2001,result.Candidates);
            Assert.IsFalse(result.More);
            Assert.AreEqual("current",result.Health);
            Assert.AreEqual(2001,Directory.GetFiles(root).Length);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void DisconnectDoesNotDeleteQueueOrLastSuccessfulCoverage()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder,"fixture.xlsx"),"synthetic");
            File.WriteAllText(Path.Combine(folder,"~$locked.xlsx"),"synthetic");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(folder);
            var reconciler = new WindowsFolderReconciler(state);
            var first = reconciler.Reconcile().Single();
            Assert.AreEqual("current",first.Health);
            Assert.AreEqual(1,first.Candidates);
            var lastScan = state.Health(source.Id)?.LastScanAt;
            Assert.IsNotNull(lastScan);
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
            var moved = Path.Combine(sandbox,"temporarily-disconnected");
            Directory.Move(folder,moved);
            var offline = reconciler.Reconcile().Single();
            Assert.AreEqual("source_offline",offline.Health);
            Assert.AreEqual(1,state.PendingCount());
            Assert.AreEqual(lastScan,state.Health(source.Id)?.LastScanAt);
            Assert.AreEqual(1,state.Health(source.Id)?.CandidateCount);
            Directory.Move(moved,folder);
            Assert.AreEqual("current",reconciler.Reconcile().Single().Health);
            Assert.AreEqual(1,state.PendingCount());
            Assert.AreEqual("synthetic",File.ReadAllText(Path.Combine(folder,"fixture.xlsx")));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void WatcherHintTriggersReconciliationWithoutReadingFileContents()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var folder = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(folder);
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var source = state.SelectFolder(folder);
            using (var monitor = new WindowsFolderMonitor(state)) {
                using var initial = new ManualResetEventSlim();
                monitor.StatusChanged += () => initial.Set();
                monitor.Start();
                Assert.IsTrue(initial.Wait(TimeSpan.FromSeconds(8)));
                Assert.AreEqual("current",state.Health(source.Id)?.State);
                File.WriteAllText(Path.Combine(folder,"new.pdf"),"synthetic");
                Assert.IsTrue(SpinWait.SpinUntil(() =>
                    state.Health(source.Id)?.CandidateCount == 1,TimeSpan.FromSeconds(8)));
            }
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C15")]
    public void VersionTwoDatabaseReplaysHealthMigration()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var database = Path.Combine(sandbox,"state.db");
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
                    PRAGMA user_version=2;
                    """;
                setup.ExecuteNonQuery();
            }
            var state = new WindowsStateStore(database);
            Assert.AreEqual(0,state.SourceIssueCount());
            Assert.AreEqual(0,new WindowsStateStore(database).SourceIssueCount());
            using (var verify = new SqliteConnection(connectionString)) {
                verify.Open();
                using var version = verify.CreateCommand();
                version.CommandText = "PRAGMA user_version;";
            Assert.AreEqual(11L,Convert.ToInt64(version.ExecuteScalar()));
            }
        } finally { Directory.Delete(sandbox,true); }
    }
}
