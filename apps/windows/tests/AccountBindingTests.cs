using Microsoft.Data.Sqlite;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class AccountBindingTests
{
    private static string NewSandbox() => Path.Combine(Path.GetTempPath(),
        "sigongnote-c16-bind-" + Guid.NewGuid().ToString("N"));

    [TestMethod, TestCategory("C16")]
    public void BackfillApprovalOnlyReleasesRowsShownAtConfirmation()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(root);
            var principal = new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            state.BindSource(source.Id,principal,Guid.NewGuid(),1);
            void InsertHeld()
            {
                using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                    DataSource = database,Pooling = false,
                }.ToString());
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = """
                    INSERT INTO capture_queue(capture_key,source_id,state,created_at,updated_at)
                    VALUES($key,$source,'backfill_approval_needed',$now,$now);
                    """;
                command.Parameters.AddWithValue("$key",Guid.NewGuid().ToString("D"));
                command.Parameters.AddWithValue("$source",source.Id);
                command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
                command.ExecuteNonQuery();
            }
            InsertHeld();
            var shown = state.BackfillSnapshot(source.Id);
            Assert.AreEqual(1,shown.Count);
            InsertHeld();
            Assert.AreEqual(1,state.ApproveExistingBackfill(source.Id,principal,shown));
            Assert.AreEqual(1,state.BackfillSnapshot(source.Id).Count);
            Assert.ThrowsExactly<BackfillSetChangedException>(() =>
                state.ApproveExistingBackfill(source.Id,principal,shown));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void ConnectionAttemptSurvivesUnknownResultButRotatesForNewDeviceOrConflict()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(root);
            var firstDevice = Guid.NewGuid();
            var first = state.ConnectionAttempt(source.Id,firstDevice);
            Assert.AreEqual(first,new WindowsStateStore(database)
                .ConnectionAttempt(source.Id,firstDevice));
            state.RotateConnectionAttempt(source.Id,firstDevice);
            var afterConflict = state.ConnectionAttempt(source.Id,firstDevice);
            Assert.AreNotEqual(first,afterConflict);
            var afterDeviceChange = state.ConnectionAttempt(source.Id,Guid.NewGuid());
            Assert.AreNotEqual(afterConflict,afterDeviceChange);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void VersionSixAttemptMigrationReplaysWithExistingFolder()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var folder = state.SelectFolder(root);
            using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database,Pooling = false,
            }.ToString())) {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = """
                    -- A genuine v6 database has no v8 upload table or v9/v10 auxiliary tables.
                    -- Leaving the v11 upload table while only lowering user_version is not an upgrade fixture.
                    DROP TABLE upload_attempts;
                    DROP TABLE copy_retention;
                    DROP TABLE copy_reclaim_checks;
                    DROP TABLE scan_runs;
                    DROP TABLE scan_directories;
                    DROP TABLE scan_entries;
                    DROP TABLE folder_setups;
                    ALTER TABLE folder_sources DROP COLUMN connect_attempt_key;
                    ALTER TABLE folder_sources DROP COLUMN attempt_device_id;
                    PRAGMA user_version=6;
                    """;
                command.ExecuteNonQuery();
            }
            var migrated = new WindowsStateStore(database);
            Assert.AreEqual(folder.Id,migrated.Folders().Single().Id);
            Assert.AreEqual(Path.GetFullPath(root),migrated.Folders().Single().RootPath);
            var device = Guid.NewGuid();
            var attempt = migrated.ConnectionAttempt(folder.Id,device);
            Assert.AreEqual(attempt,new WindowsStateStore(database)
                .ConnectionAttempt(folder.Id,device));
            using var verify = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource=database,Pooling=false }.ToString());
            verify.Open();using var version=verify.CreateCommand();version.CommandText="PRAGMA user_version;";
            Assert.AreEqual(11L,Convert.ToInt64(version.ExecuteScalar()));
            version.CommandText="SELECT COUNT(*) FROM pragma_table_info('upload_attempts') WHERE name='revision_base_protected';";
            Assert.AreEqual(1L,Convert.ToInt64(version.ExecuteScalar()));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void FolderAndDiscoveredQueueNeverSwitchAccounts()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var path = Path.Combine(root,"synthetic.pdf");
            File.WriteAllText(path,"synthetic");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var sourceA = state.SelectFolder(root);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(sourceA.Id,root,path));
            Assert.AreEqual(FileReadiness.Ready,stabilizer.Observe(sourceA.Id,root,path));
            var accountA = new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var accountB = new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var serverA = Guid.NewGuid();
            state.BindSource(sourceA.Id,accountA,serverA,1);
            Assert.AreEqual(accountA.TenantId,state.Folders().Single().TenantId);
            Assert.AreEqual(1,state.BackfillApprovalCount());
            var snapshot = state.BackfillSnapshot(sourceA.Id);
            Assert.ThrowsExactly<BackfillSetChangedException>(() =>
                state.ApproveExistingBackfill(sourceA.Id,accountB,snapshot));
            Assert.AreEqual(1,state.ApproveExistingBackfill(sourceA.Id,accountA,snapshot));
            Assert.ThrowsExactly<InvalidOperationException>(() =>
                state.BindSource(sourceA.Id,accountB,Guid.NewGuid(),1));
            Assert.ThrowsExactly<InvalidOperationException>(() =>
                state.BindSource(sourceA.Id,accountA,Guid.NewGuid(),1));
            state.Logout();
            var sourceB = state.SelectFolder(root,accountB);
            Assert.AreNotEqual(sourceA.Id,sourceB.Id);
            state.BindSource(sourceB.Id,accountB,Guid.NewGuid(),1);
            var folders = state.Folders();
            Assert.AreEqual("paused",folders.Single(item => item.Id == sourceA.Id).State);
            Assert.AreEqual(accountB.TenantId,folders.Single(item => item.Id == sourceB.Id).TenantId);
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT tenant_id,user_id,device_id FROM capture_queue WHERE source_id=$source;";
            command.Parameters.AddWithValue("$source",sourceA.Id);
            using var reader = command.ExecuteReader();
            Assert.IsTrue(reader.Read());
            Assert.AreEqual(accountA.TenantId.ToString("D"),reader.GetString(0));
            Assert.AreEqual(accountA.UserId.ToString("D"),reader.GetString(1));
            Assert.AreEqual(accountA.DeviceId.ToString("D"),reader.GetString(2));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void UnreadableSessionIsArchivedAndRequiresLogin()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var path = Path.Combine(sandbox,"session.protected");
            var vault = new WindowsTokenVault(path);
            vault.Save("synthetic-session");
            File.WriteAllBytes(path,[1,2,3,4]);
            Assert.IsNull(vault.Read());
            Assert.IsFalse(File.Exists(path));
            Assert.AreEqual(1,Directory.GetFiles(sandbox,
                "session.protected.unrecoverable-*").Length);
            vault.Save("replacement-session");
            Assert.AreEqual("replacement-session",vault.Read());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void VersionFourQueueSchemaMigratesOnceWithoutChangingRows()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var database = Path.Combine(sandbox,"state.db");
            var root=Path.Combine(sandbox,"work");Directory.CreateDirectory(root);
            var source=Guid.NewGuid().ToString("D");var capture=Guid.NewGuid().ToString("D");
            var created=DateTimeOffset.UtcNow.ToString("O");var protectedRoot=new WindowsSecretStore().Protect(root);
            var connectionString = new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString();
            using (var connection = new SqliteConnection(connectionString)) {
                connection.Open();
                using var setup = connection.CreateCommand();
                setup.CommandText = """
                    CREATE TABLE folder_sources(source_id TEXT PRIMARY KEY,
                        root_protected BLOB NOT NULL,state TEXT NOT NULL,added_at TEXT NOT NULL,
                        volume_id TEXT,volume_serial TEXT,relative_path_protected BLOB);
                    CREATE TABLE capture_queue(capture_key TEXT PRIMARY KEY,
                        source_id TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,path_token TEXT,content_sha256 TEXT,byte_size INTEGER);
                    CREATE TABLE local_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT NOT NULL);
                    CREATE TABLE source_health(source_id TEXT PRIMARY KEY,state TEXT NOT NULL,
                        last_scan_at TEXT,candidate_count INTEGER,error_code TEXT);
                    CREATE TABLE file_observations(source_id TEXT NOT NULL,path_token TEXT NOT NULL,
                        relative_path_protected BLOB NOT NULL,observed_size INTEGER NOT NULL,
                        observed_write_ticks INTEGER NOT NULL,seen_at TEXT NOT NULL,state TEXT NOT NULL,
                        content_sha256 TEXT,PRIMARY KEY(source_id,path_token));
                    PRAGMA user_version=4;
                    """;
                setup.ExecuteNonQuery();
                setup.CommandText="INSERT INTO folder_sources(source_id,root_protected,state,added_at) VALUES($source,$root,'selected',$now); INSERT INTO capture_queue(capture_key,source_id,state,created_at,updated_at,path_token,content_sha256,byte_size) VALUES($capture,$source,'discovered',$now,$now,'synthetic-path-token',$hash,42);";
                setup.Parameters.AddWithValue("$source",source);setup.Parameters.AddWithValue("$capture",capture);
                setup.Parameters.AddWithValue("$root",protectedRoot);setup.Parameters.AddWithValue("$now",created);setup.Parameters.AddWithValue("$hash",new string('a',64));setup.ExecuteNonQuery();
            }
            _ = new WindowsStateStore(database);
            _ = new WindowsStateStore(database);
            using var verify = new SqliteConnection(connectionString);
            verify.Open();
            using var version = verify.CreateCommand();
            version.CommandText = "PRAGMA user_version;";
            Assert.AreEqual(11L,Convert.ToInt64(version.ExecuteScalar()));
            version.CommandText = "SELECT COUNT(*) FROM pragma_table_info('capture_queue');";
            Assert.AreEqual(11L,Convert.ToInt64(version.ExecuteScalar()));
            version.CommandText="SELECT source_id,state,created_at,updated_at,path_token,content_sha256,byte_size FROM capture_queue WHERE capture_key=$capture;";
            version.Parameters.AddWithValue("$capture",capture);
            using(var row=version.ExecuteReader()){
                Assert.IsTrue(row.Read());Assert.AreEqual(source,row.GetString(0));Assert.AreEqual("discovered",row.GetString(1));
                Assert.AreEqual(created,row.GetString(2));Assert.AreEqual(created,row.GetString(3));Assert.AreEqual("synthetic-path-token",row.GetString(4));
                Assert.AreEqual(new string('a',64),row.GetString(5));Assert.AreEqual(42L,row.GetInt64(6));Assert.IsFalse(row.Read());
            }
            version.Parameters.Clear();version.CommandText="SELECT root_protected FROM folder_sources WHERE source_id=$source;";version.Parameters.AddWithValue("$source",source);
            CollectionAssert.AreEqual(protectedRoot,(byte[])version.ExecuteScalar()!);
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void UploadClaimAndProtectedTicketSurviveCrashWithSameKeys()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var sourceFile = Path.Combine(root,"synthetic.pdf");
            File.WriteAllText(sourceFile,"synthetic upload source");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(root);
            var owner = new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            state.BindSource(source.Id,owner,Guid.NewGuid(),1);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(source.Id,root,sourceFile);
            stabilizer.Observe(source.Id,root,sourceFile);
            using var copies = new WindowsEncryptedCopyStore(state,
                System.Security.Cryptography.RandomNumberGenerator.GetBytes(32),
                Path.Combine(sandbox,"copies"));
            Assert.AreEqual(1,copies.StagePending());
            Assert.IsNull(state.BeginUpload(new WindowsPrincipal(Guid.NewGuid(),
                owner.UserId,owner.DeviceId)));
            var first = state.BeginUpload(owner);
            Assert.IsNotNull(first);
            Assert.AreEqual(source.Id,first.Copy.SourceId);
            Assert.IsTrue(copies.VerifyCopy(Path.Combine(sandbox,"copies",
                first.Copy.CaptureKey + ".sgn"),first.Copy));
            Assert.IsNull(state.BeginUpload(owner));
            var intent = Guid.NewGuid();
            var expiry = DateTimeOffset.UtcNow.AddMinutes(10);
            state.SavePreparedUpload(first.Copy.CaptureKey,intent,"synthetic-secret-ticket",expiry);
            state.SaveTusUrl(first.Copy.CaptureKey,intent,
                "https://storage.example.test/upload/opaque");
            state.FinishUpload(first.Copy.CaptureKey,"retry_wait",retryAfter:
                DateTimeOffset.UtcNow.AddHours(1).ToOffset(TimeSpan.FromHours(9)));
            Assert.IsNull(state.BeginUpload(owner));
            using (var raw = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database,Pooling = false,
            }.ToString())) {
                raw.Open();
                using var command = raw.CreateCommand();
                command.CommandText = "SELECT ticket_protected FROM upload_attempts;";
                var protectedTicket = (byte[])command.ExecuteScalar()!;
                Assert.IsFalse(System.Text.Encoding.UTF8.GetString(protectedTicket)
                    .Contains("synthetic-secret-ticket",StringComparison.Ordinal));
                command.CommandText = "UPDATE upload_attempts SET retry_after=$past;";
                command.Parameters.AddWithValue("$past",DateTimeOffset.UtcNow.AddMinutes(-1)
                    .ToString("O"));
                command.ExecuteNonQuery();
            }
            var resumed = new WindowsStateStore(database);
            var again = resumed.BeginUpload(owner);
            Assert.IsNotNull(again);
            Assert.AreEqual(first.PrepareKey,again.PrepareKey);
            Assert.AreEqual(first.CompleteKey,again.CompleteKey);
            Assert.AreEqual(intent,again.IngestionId);
            Assert.AreEqual("synthetic-secret-ticket",again.Ticket);
            Assert.AreEqual("https://storage.example.test/upload/opaque",again.TusUrl);
            resumed.RecoverInterruptedUploads();
            again = resumed.BeginUpload(owner);
            Assert.IsNotNull(again);
            Assert.AreEqual(first.PrepareKey,again.PrepareKey);
            resumed.ResetAfterServerRejection(again.Copy.CaptureKey,intent,
                DateTimeOffset.UtcNow.AddMinutes(-1));
            var restarted = resumed.BeginUpload(owner);
            Assert.IsNotNull(restarted);
            Assert.AreNotEqual(first.PrepareKey,restarted.PrepareKey);
            Assert.AreNotEqual(first.CompleteKey,restarted.CompleteKey);
            Assert.IsNull(restarted.IngestionId);
            Assert.IsNull(restarted.Ticket);
            Assert.IsNull(restarted.TusUrl);
            resumed.SavePreparedUpload(restarted.Copy.CaptureKey,Guid.NewGuid(),
                "replacement-ticket",DateTimeOffset.UtcNow.AddMinutes(10));
            resumed.FinishUpload(restarted.Copy.CaptureKey,"acknowledged",
                "synthetic-receipt");
            Assert.IsNull(new WindowsStateStore(database).BeginUpload(owner));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void VersionSevenUploadMigrationReplaysWithoutLosingFolder()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var source = state.SelectFolder(root);
            var device=Guid.NewGuid();var attempt=state.ConnectionAttempt(source.Id,device);
            using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database,Pooling = false,
            }.ToString())) {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = """
                    DROP TABLE upload_attempts;
                    DROP TABLE copy_retention;
                    DROP TABLE copy_reclaim_checks;
                    DROP TABLE scan_runs;
                    DROP TABLE scan_directories;
                    DROP TABLE scan_entries;
                    DROP TABLE folder_setups;
                    PRAGMA user_version=7;
                    """;
                command.ExecuteNonQuery();
            }
            var migrated = new WindowsStateStore(database);
            Assert.AreEqual(source.Id,migrated.Folders().Single().Id);
            Assert.AreEqual(Path.GetFullPath(root),migrated.Folders().Single().RootPath);
            Assert.AreEqual(attempt,migrated.ConnectionAttempt(source.Id,device));
            _ = new WindowsStateStore(database);
            using var verify = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database,Pooling = false,
            }.ToString());
            verify.Open();
            using var command2 = verify.CreateCommand();
            command2.CommandText = "PRAGMA user_version;";
            Assert.AreEqual(11L,Convert.ToInt64(command2.ExecuteScalar()));
            command2.CommandText = "SELECT COUNT(*) FROM pragma_table_info('upload_attempts');";
            Assert.AreEqual(11L,Convert.ToInt64(command2.ExecuteScalar()));
            command2.CommandText="SELECT COUNT(*) FROM pragma_table_info('upload_attempts') WHERE name='revision_base_protected';";
            Assert.AreEqual(1L,Convert.ToInt64(command2.ExecuteScalar()));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void NewConsentGenerationFencesOldUploadAttempt()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var file = Path.Combine(root,"synthetic.pdf");
            File.WriteAllText(file,"synthetic");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var source = state.SelectFolder(root);
            var owner = new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var serverSource = Guid.NewGuid();
            state.BindSource(source.Id,owner,serverSource,1);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(source.Id,root,file);
            stabilizer.Observe(source.Id,root,file);
            using var copies = new WindowsEncryptedCopyStore(state,
                System.Security.Cryptography.RandomNumberGenerator.GetBytes(32),
                Path.Combine(sandbox,"copies"));
            Assert.AreEqual(1,copies.StagePending());
            var attempt = state.BeginUpload(owner);
            Assert.IsNotNull(attempt);
            Assert.IsTrue(state.UploadStillCurrent(attempt));
            state.BindSource(source.Id,owner,serverSource,2);
            Assert.IsFalse(state.UploadStillCurrent(attempt));
            Assert.IsNull(state.BeginUpload(owner));
            Assert.ThrowsExactly<InvalidOperationException>(() =>
                state.FinishUpload(attempt.Copy.CaptureKey,"acknowledged","fake-receipt"));
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database,Pooling = false,
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT state FROM capture_queue WHERE capture_key=$key;";
            command.Parameters.AddWithValue("$key",attempt.Copy.CaptureKey);
            Assert.AreEqual("permission_lost",command.ExecuteScalar());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public void ExplicitReconsentCreatesNewLineageAndFencesOldQueue()
    {
        var sandbox = NewSandbox();
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var path = Path.Combine(root,"synthetic.xlsx");
            File.WriteAllText(path,"synthetic");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var accountA = new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var accountB = new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid());
            var original = state.SelectFolder(root,accountA);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(original.Id,root,path));
            Assert.AreEqual(FileReadiness.Ready,stabilizer.Observe(original.Id,root,path));
            var serverOne = Guid.NewGuid();
            var serverTwo = Guid.NewGuid();
            state.BindSource(original.Id,accountA,serverOne,1,
                includeExistingBackfill:true);
            Assert.ThrowsExactly<InvalidOperationException>(() =>
                state.RebindAfterRevocation(original.Id,accountB,serverOne,1,
                    Guid.NewGuid(),1));
            var replacement = state.RebindAfterRevocation(original.Id,accountA,
                serverOne,1,serverTwo,1);
            Assert.AreNotEqual(original.Id,replacement.Id);
            Assert.AreEqual(replacement.Id,state.SelectFolder(root,accountA).Id);
            Assert.AreEqual("paused",state.Folders().Single(item => item.Id == original.Id).State);
            Assert.AreEqual(serverTwo,state.Folders().Single(item => item.Id == replacement.Id).ServerSourceId);
            Assert.AreEqual(FileReadiness.Delayed,stabilizer.Observe(replacement.Id,root,path));
            Assert.AreEqual(FileReadiness.Ready,stabilizer.Observe(replacement.Id,root,path));
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource = database, Pooling = false
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT state FROM capture_queue WHERE source_id=$source;";
            command.Parameters.AddWithValue("$source",original.Id);
            Assert.AreEqual("revoked_pending_purge",command.ExecuteScalar());
            command.Parameters["$source"].Value = replacement.Id;
            Assert.AreEqual("discovered",command.ExecuteScalar());
        } finally { Directory.Delete(sandbox,true); }
    }
}
