using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace Sigongnote.Windows;

public sealed record FolderConnection(string Id, string? RootPath, string State,
    DateTimeOffset AddedAt, string? VolumeId = null, string? VolumeSerial = null,
    string? RelativePath = null, Guid? TenantId = null, Guid? UserId = null,
    Guid? DeviceId = null, Guid? ServerSourceId = null, int? SourceGeneration = null);
public sealed record WindowsPrincipal(Guid TenantId, Guid UserId, Guid DeviceId);
public sealed record SourceHealth(string State, DateTimeOffset? LastScanAt,
    int CandidateCount, string? ErrorCode);
public sealed record FileObservation(long Size, long WriteTicks, DateTimeOffset SeenAt,
    string State, string? ContentSha256);
public sealed record CopyCandidate(string CaptureKey, string SourceId,
    string RelativePath, string ContentSha256, long ByteSize, long WriteTicks);
public sealed record UploadCandidate(CopyCandidate Copy, WindowsPrincipal Principal,
    Guid ServerSourceId, int SourceGeneration, Guid PrepareKey, Guid CompleteKey,
    Guid? IngestionId, string? Ticket, string? TusUrl, DateTimeOffset? ExpiresAt, WindowsRevisionBase? RevisionBase = null);
public sealed record WindowsRevisionBase(Guid DocumentId, Guid RevisionId, int Version);
public sealed record FolderScopeBaseline(DateTime CutoffUtc, DateTime StartedUtc, bool Completed,
    IReadOnlySet<string> ExcludedFingerprints);
public sealed record BackfillApprovalSnapshot(int Count, long MaxRowId);
public sealed class BackfillSetChangedException : Exception;

/// <summary>Stores local scope and queue metadata only; source files are never edited.</summary>
public sealed partial class WindowsStateStore
{
    private readonly string databasePath;
    private readonly WindowsSecretStore secrets;

    public WindowsStateStore(string databasePath, WindowsSecretStore? secrets = null)
    {
        this.databasePath = Path.GetFullPath(databasePath);
        this.secrets = secrets ?? new WindowsSecretStore();
        Directory.CreateDirectory(Path.GetDirectoryName(this.databasePath)!);
        Initialize();
    }

    public static string DefaultPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Sigongnote", "capture-state.db");

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
            DataSource = databasePath, Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false
        }.ToString());
        connection.Open();
        using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA foreign_keys=ON;";
        pragma.ExecuteNonQuery();
        return connection;
    }

    private void Initialize()
    {
        using var connection = Open();
        using var version = connection.CreateCommand();
        version.CommandText = "PRAGMA user_version;";
        var currentVersion = Convert.ToInt32(version.ExecuteScalar());
        if (currentVersion > 11) throw new InvalidOperationException("Unsupported queue schema");
        using var transaction = connection.BeginTransaction();
        using var create = connection.CreateCommand();
        create.Transaction = transaction;
        if (currentVersion == 0) {
            create.CommandText = """
            CREATE TABLE IF NOT EXISTS folder_sources (
                source_id TEXT PRIMARY KEY,
                root_protected BLOB NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('selected','paused','needs_reauthorization')),
                added_at TEXT NOT NULL,
                volume_id TEXT,
                volume_serial TEXT,
                relative_path_protected BLOB
            );
            CREATE TABLE IF NOT EXISTS capture_queue (
                capture_key TEXT PRIMARY KEY,
                source_id TEXT NOT NULL REFERENCES folder_sources(source_id),
                state TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT NOT NULL
            );
            PRAGMA user_version=2;
            """;
            create.ExecuteNonQuery();
        } else if (currentVersion == 1) {
            create.CommandText = """
                ALTER TABLE folder_sources ADD COLUMN volume_id TEXT;
                ALTER TABLE folder_sources ADD COLUMN volume_serial TEXT;
                ALTER TABLE folder_sources ADD COLUMN relative_path_protected BLOB;
                UPDATE folder_sources SET state='needs_reauthorization' WHERE state='selected';
                PRAGMA user_version=2;
                """;
            create.ExecuteNonQuery();
        }
        if (currentVersion <= 2) {
            create.CommandText = """
                CREATE TABLE IF NOT EXISTS source_health (
                    source_id TEXT PRIMARY KEY REFERENCES folder_sources(source_id),
                    state TEXT NOT NULL CHECK(state IN ('current','source_offline','scan_gap','paused')),
                    last_scan_at TEXT,
                    candidate_count INTEGER NOT NULL DEFAULT 0,
                    error_code TEXT
                );
                PRAGMA user_version=3;
                """;
            create.ExecuteNonQuery();
        }
        if (currentVersion <= 3) {
            create.CommandText = """
                CREATE TABLE IF NOT EXISTS file_observations (
                    source_id TEXT NOT NULL REFERENCES folder_sources(source_id),
                    path_token TEXT NOT NULL,
                    relative_path_protected BLOB NOT NULL,
                    observed_size INTEGER NOT NULL,
                    observed_write_ticks INTEGER NOT NULL,
                    seen_at TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('unstable','locked','ready')),
                    content_sha256 TEXT,
                    PRIMARY KEY(source_id,path_token)
                );
                ALTER TABLE capture_queue ADD COLUMN path_token TEXT;
                ALTER TABLE capture_queue ADD COLUMN content_sha256 TEXT;
                ALTER TABLE capture_queue ADD COLUMN byte_size INTEGER;
                PRAGMA user_version=4;
                """;
            create.ExecuteNonQuery();
        }
        if (currentVersion <= 4) {
            create.CommandText = """
                ALTER TABLE folder_sources ADD COLUMN tenant_id TEXT;
                ALTER TABLE folder_sources ADD COLUMN user_id TEXT;
                ALTER TABLE folder_sources ADD COLUMN device_id TEXT;
                ALTER TABLE folder_sources ADD COLUMN server_source_id TEXT;
                ALTER TABLE folder_sources ADD COLUMN source_generation INTEGER;
                ALTER TABLE capture_queue ADD COLUMN tenant_id TEXT;
                ALTER TABLE capture_queue ADD COLUMN user_id TEXT;
                ALTER TABLE capture_queue ADD COLUMN device_id TEXT;
                CREATE UNIQUE INDEX IF NOT EXISTS unique_windows_server_source
                    ON folder_sources(tenant_id,server_source_id)
                    WHERE server_source_id IS NOT NULL;
                PRAGMA user_version=5;
                """;
            create.ExecuteNonQuery();
        }
        if (currentVersion <= 5) {
            create.CommandText = """
                CREATE TABLE folder_scope_baseline (
                    source_id TEXT PRIMARY KEY REFERENCES folder_sources(source_id),
                    cutoff_ticks INTEGER NOT NULL, started_ticks INTEGER NOT NULL,
                    completed_at TEXT
                );
                CREATE TABLE excluded_baseline_files (
                    source_id TEXT NOT NULL REFERENCES folder_sources(source_id),
                    metadata_fingerprint TEXT NOT NULL,
                    PRIMARY KEY(source_id,metadata_fingerprint)
                );
                PRAGMA user_version=6;
                """;
            create.ExecuteNonQuery();
            create.CommandText = """
                INSERT INTO folder_scope_baseline(source_id,cutoff_ticks,started_ticks)
                SELECT source_id,$cutoff,$started FROM folder_sources;
                """;
            var started = DateTime.UtcNow;
            create.Parameters.AddWithValue("$cutoff",started.AddDays(-30).Ticks);
            create.Parameters.AddWithValue("$started",started.Ticks);
            create.ExecuteNonQuery();
        }
        if (currentVersion <= 6) {
            create.Parameters.Clear();
            create.CommandText = """
                ALTER TABLE folder_sources ADD COLUMN connect_attempt_key TEXT;
                ALTER TABLE folder_sources ADD COLUMN attempt_device_id TEXT;
                PRAGMA user_version=7;
                """;
            create.ExecuteNonQuery();
        }
        if (currentVersion <= 7) {
            create.Parameters.Clear();
            create.CommandText = """
                CREATE TABLE IF NOT EXISTS upload_attempts (
                    capture_key TEXT PRIMARY KEY REFERENCES capture_queue(capture_key),
                    source_generation INTEGER NOT NULL,
                    prepare_key TEXT NOT NULL,
                    complete_key TEXT NOT NULL,
                    ingestion_id TEXT,
                    ticket_protected BLOB,
                    tus_url_protected BLOB,
                    expires_at TEXT,
                    receipt_protected BLOB,
                    retry_after TEXT
                );
                PRAGMA user_version=8;
                """;
            create.ExecuteNonQuery();
        }
        create.Parameters.Clear();
        create.CommandText = """
            CREATE TABLE IF NOT EXISTS copy_retention(capture_key TEXT PRIMARY KEY REFERENCES capture_queue(capture_key),hold INTEGER NOT NULL DEFAULT 0,reclaimed_at TEXT);
            CREATE TABLE IF NOT EXISTS copy_reclaim_checks(capture_key TEXT PRIMARY KEY REFERENCES capture_queue(capture_key),next_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS scan_runs(source_id TEXT PRIMARY KEY REFERENCES folder_sources(source_id),generation INTEGER NOT NULL,state TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS scan_directories(source_id TEXT NOT NULL,path_token TEXT NOT NULL,path_protected BLOB NOT NULL,depth INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(source_id,path_token));
            CREATE TABLE IF NOT EXISTS scan_entries(source_id TEXT NOT NULL,path_token TEXT NOT NULL,path_protected BLOB NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,modified_ticks INTEGER NOT NULL,observed_size INTEGER NOT NULL,PRIMARY KEY(source_id,path_token));
            CREATE INDEX IF NOT EXISTS scan_entry_pending ON scan_entries(source_id,generation,state,modified_ticks);
            CREATE TABLE IF NOT EXISTS folder_setups(source_id TEXT PRIMARY KEY REFERENCES folder_sources(source_id),
                setup_key TEXT NOT NULL,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,device_id TEXT NOT NULL,
                payload_protected BLOB NOT NULL,state TEXT NOT NULL,error TEXT);
            PRAGMA user_version=10;
            """;
        create.ExecuteNonQuery();
        if(currentVersion<=10){
            create.CommandText="ALTER TABLE upload_attempts ADD COLUMN revision_base_protected BLOB;";
            create.ExecuteNonQuery();
        }
        create.CommandText="PRAGMA user_version=11;";create.ExecuteNonQuery();
        transaction.Commit();
    }

    public Guid ConnectionAttempt(string sourceId, Guid deviceId)
    {
        if (deviceId == Guid.Empty) throw new ArgumentException("Device is required");
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred:false);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT connect_attempt_key,attempt_device_id FROM folder_sources WHERE source_id=$id AND state='selected';";
        command.Parameters.AddWithValue("$id",sourceId);
        string? previousKey;
        string? previousDevice;
        using (var reader = command.ExecuteReader()) {
            if (!reader.Read()) throw new InvalidOperationException("Folder requires reauthorization");
            previousKey = reader.IsDBNull(0) ? null : reader.GetString(0);
            previousDevice = reader.IsDBNull(1) ? null : reader.GetString(1);
        }
        if (previousDevice == deviceId.ToString("D") &&
            Guid.TryParse(previousKey,out var stable) && stable != Guid.Empty) {
            transaction.Commit();
            return stable;
        }
        var next = Guid.NewGuid();
        command.CommandText = "UPDATE folder_sources SET connect_attempt_key=$key,attempt_device_id=$device WHERE source_id=$id AND state='selected';";
        command.Parameters.AddWithValue("$key",next.ToString("D"));
        command.Parameters.AddWithValue("$device",deviceId.ToString("D"));
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Folder requires reauthorization");
        transaction.Commit();
        return next;
    }

    public void RotateConnectionAttempt(string sourceId, Guid deviceId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE folder_sources SET connect_attempt_key=$key,attempt_device_id=$device WHERE source_id=$id AND state='selected';";
        command.Parameters.AddWithValue("$id",sourceId);
        command.Parameters.AddWithValue("$key",Guid.NewGuid().ToString("D"));
        command.Parameters.AddWithValue("$device",deviceId.ToString("D"));
        command.ExecuteNonQuery();
    }

    public FolderScopeBaseline ScopeBaseline(string sourceId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT cutoff_ticks,started_ticks,completed_at FROM folder_scope_baseline WHERE source_id=$id;";
        command.Parameters.AddWithValue("$id",sourceId);
        long ticks;
        long startedTicks;
        bool completed;
        using (var reader = command.ExecuteReader()) {
            if (!reader.Read()) throw new InvalidOperationException("Folder scope is missing");
            ticks = reader.GetInt64(0);
            startedTicks = reader.GetInt64(1);
            completed = !reader.IsDBNull(2);
        }
        var excluded = new HashSet<string>(StringComparer.Ordinal);
        if (completed) {
            command.CommandText = "SELECT metadata_fingerprint FROM excluded_baseline_files WHERE source_id=$id;";
            using var reader = command.ExecuteReader();
            while (reader.Read()) excluded.Add(reader.GetString(0));
        }
        return new FolderScopeBaseline(new DateTime(ticks,DateTimeKind.Utc),
            new DateTime(startedTicks,DateTimeKind.Utc),completed,excluded);
    }

    public void CompleteScopeBaseline(string sourceId, IEnumerable<string> excludedFingerprints)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT completed_at FROM folder_scope_baseline WHERE source_id=$id;";
        command.Parameters.AddWithValue("$id",sourceId);
        var previous = command.ExecuteScalar();
        if (previous is null) throw new InvalidOperationException("Folder scope is missing");
        if (previous is not DBNull) { transaction.Commit(); return; }
        command.CommandText = "INSERT OR IGNORE INTO excluded_baseline_files(source_id,metadata_fingerprint) VALUES($id,$fingerprint);";
        command.Parameters.Add("$fingerprint",SqliteType.Text);
        foreach (var fingerprint in excludedFingerprints.Distinct(StringComparer.Ordinal)) {
            command.Parameters["$fingerprint"].Value = fingerprint;
            command.ExecuteNonQuery();
        }
        command.CommandText = "UPDATE folder_scope_baseline SET completed_at=$now WHERE source_id=$id AND completed_at IS NULL;";
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    public FileObservation? Observation(string sourceId, string pathToken)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT observed_size,observed_write_ticks,seen_at,state,content_sha256 FROM file_observations WHERE source_id=$source AND path_token=$path;";
        command.Parameters.AddWithValue("$source",sourceId);
        command.Parameters.AddWithValue("$path",pathToken);
        using var reader = command.ExecuteReader();
        return reader.Read() ? new FileObservation(reader.GetInt64(0),reader.GetInt64(1),
            DateTimeOffset.Parse(reader.GetString(2)),reader.GetString(3),
            reader.IsDBNull(4) ? null : reader.GetString(4)) : null;
    }

    public void RecordObservation(string sourceId, string pathToken, string relativePath,
        long size, long writeTicks, string status, string? contentSha256 = null)
    {
        if (status is not ("unstable" or "locked" or "ready"))
            throw new ArgumentOutOfRangeException(nameof(status));
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO file_observations(source_id,path_token,relative_path_protected,
                observed_size,observed_write_ticks,seen_at,state,content_sha256)
            VALUES($source,$path,$relative,$size,$ticks,$seen,$state,$hash)
            ON CONFLICT(source_id,path_token) DO UPDATE SET
                relative_path_protected=excluded.relative_path_protected,
                observed_size=excluded.observed_size,
                observed_write_ticks=excluded.observed_write_ticks,
                seen_at=excluded.seen_at,state=excluded.state,
                content_sha256=CASE WHEN excluded.state='ready' THEN excluded.content_sha256
                    ELSE file_observations.content_sha256 END;
            """;
        command.Parameters.AddWithValue("$source",sourceId);
        command.Parameters.AddWithValue("$path",pathToken);
        command.Parameters.Add("$relative",SqliteType.Blob).Value = secrets.Protect(relativePath);
        command.Parameters.AddWithValue("$size",size);
        command.Parameters.AddWithValue("$ticks",writeTicks);
        command.Parameters.AddWithValue("$seen",DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$state",status);
        command.Parameters.AddWithValue("$hash",(object?)contentSha256 ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    public int PendingFileCount()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM file_observations WHERE state IN ('unstable','locked');";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    public bool SourceSelected(string sourceId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT EXISTS(SELECT 1 FROM folder_sources WHERE source_id=$source AND state='selected');";
        command.Parameters.AddWithValue("$source",sourceId);
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    public void QueueStableFile(string sourceId, string pathToken, string contentSha256,
        long byteSize, string captureKey)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO capture_queue(capture_key,source_id,state,created_at,
                updated_at,path_token,content_sha256,byte_size,tenant_id,user_id,device_id)
            SELECT $key,source_id,'discovered',$now,$now,$path,$hash,$size,
                tenant_id,user_id,device_id
            FROM folder_sources WHERE source_id=$source AND state='selected';
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$source",sourceId);
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$path",pathToken);
        command.Parameters.AddWithValue("$hash",contentSha256);
        command.Parameters.AddWithValue("$size",byteSize);
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<CopyCandidate> CopyCandidates(int limit = 16,bool oldest = false)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT q.capture_key,q.source_id,o.relative_path_protected,
                q.content_sha256,q.byte_size,o.observed_write_ticks
            FROM capture_queue q
            JOIN folder_sources s ON s.source_id=q.source_id
            JOIN file_observations o ON o.source_id=q.source_id AND o.path_token=q.path_token
            LEFT JOIN source_health h ON h.source_id=q.source_id
            WHERE q.state IN ('discovered','source_changed','source_unavailable','storage_full')
                AND s.state='selected' AND o.state='ready'
                AND o.content_sha256=q.content_sha256
                AND (h.state IS NULL OR h.state!='source_offline')
            ORDER BY CASE WHEN $oldest=1 THEN o.observed_write_ticks ELSE NULL END ASC,
                CASE q.state WHEN 'discovered' THEN 0 WHEN 'storage_full' THEN 2 ELSE 1 END,o.observed_write_ticks DESC,q.updated_at,q.capture_key LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$limit",Math.Clamp(limit,1,100));
        command.Parameters.AddWithValue("$oldest",oldest?1:0);
        using var reader = command.ExecuteReader();
        var candidates = new List<CopyCandidate>();
        while (reader.Read()) {
            string relative;
            try { relative = secrets.Unprotect((byte[])reader[2]); }
            catch (CryptographicException) { continue; }
            candidates.Add(new CopyCandidate(reader.GetString(0),reader.GetString(1),relative,
                reader.GetString(3),reader.GetInt64(4),reader.GetInt64(5)));
        }
        return candidates;
    }

    public bool BeginCopy(string captureKey)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE capture_queue SET state='staging',updated_at=$now
            WHERE capture_key=$key AND state IN
                ('discovered','source_changed','source_unavailable','storage_full')
                AND EXISTS(SELECT 1 FROM folder_sources s WHERE s.source_id=capture_queue.source_id
                    AND s.state='selected');
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        return command.ExecuteNonQuery() == 1;
    }

    public void CompleteCopy(string captureKey, string state)
    {
        if (state is not ("ready" or "source_changed" or "source_unavailable" or
            "storage_full" or "copy_error" or "too_large" or "scope_excluded"))
            throw new ArgumentOutOfRangeException(nameof(state));
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE capture_queue SET state=$state,updated_at=$now
            WHERE capture_key=$key AND state='staging';
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$state",state);
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
    }

    public void RecoverInterruptedCopies()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE capture_queue SET state='discovered' WHERE state='staging';";
        command.ExecuteNonQuery();
    }

    public (long Bytes, long Count) LocalCopyUsage()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT COALESCE(SUM(byte_size),0),COUNT(*) FROM capture_queue
            WHERE state IN ('ready','uploading','retry_wait');
            """;
        using var reader = command.ExecuteReader();
        reader.Read();
        return (reader.GetInt64(0),reader.GetInt64(1));
    }

    /// <summary>Claims one approved, account-bound copy before any network request.</summary>
    public UploadCandidate? BeginUpload(WindowsPrincipal principal)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred:false);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT q.capture_key,q.source_id,o.relative_path_protected,
                q.content_sha256,q.byte_size,o.observed_write_ticks,
                s.server_source_id,s.source_generation,
                a.prepare_key,a.complete_key,a.ingestion_id,a.ticket_protected,
                a.tus_url_protected,a.expires_at,a.revision_base_protected,a.capture_key
            FROM capture_queue q
            JOIN folder_sources s ON s.source_id=q.source_id
            JOIN file_observations o ON o.source_id=q.source_id AND o.path_token=q.path_token
            LEFT JOIN upload_attempts a ON a.capture_key=q.capture_key
            WHERE q.state IN ('ready','retry_wait') AND s.state='selected'
              AND (q.state='ready' OR a.retry_after IS NULL OR a.retry_after<=$now)
              AND (a.capture_key IS NULL OR a.source_generation=s.source_generation)
              AND q.tenant_id=$tenant AND q.user_id=$user AND q.device_id=$device
              AND s.tenant_id=$tenant AND s.user_id=$user AND s.device_id=$device
              AND s.server_source_id IS NOT NULL AND s.source_generation IS NOT NULL
              AND NOT EXISTS(SELECT 1 FROM folder_setups f WHERE f.source_id=s.source_id AND f.state!='ready')
              AND NOT EXISTS(SELECT 1 FROM capture_queue earlier WHERE earlier.source_id=q.source_id
                AND earlier.path_token=q.path_token AND earlier.tenant_id=q.tenant_id AND earlier.user_id=q.user_id AND earlier.device_id=q.device_id
                AND (earlier.state='revision_conflict' OR (earlier.rowid<q.rowid AND earlier.state IN ('ready','retry_wait','uploading','staging','discovered','storage_full'))))
            ORDER BY o.observed_write_ticks DESC,q.updated_at,q.capture_key LIMIT 1;
            """;
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));
        command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));
        command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        string captureKey, sourceId, path, hash;
        long size, ticks;
        Guid serverSourceId, prepareKey, completeKey;
        int generation;
        Guid? ingestionId;
        string? ticket, tusUrl;
        DateTimeOffset? expiresAt;
        WindowsRevisionBase? revisionBase;bool existingAttempt;
        using (var reader = command.ExecuteReader()) {
            if (!reader.Read()) return null;
            captureKey = reader.GetString(0);
            sourceId = reader.GetString(1);
            path = secrets.Unprotect((byte[])reader[2]);
            hash = reader.GetString(3);
            size = reader.GetInt64(4);
            ticks = reader.GetInt64(5);
            serverSourceId = Guid.Parse(reader.GetString(6));
            generation = reader.GetInt32(7);
            prepareKey = reader.IsDBNull(8) ? Guid.NewGuid() : Guid.Parse(reader.GetString(8));
            completeKey = reader.IsDBNull(9) ? Guid.NewGuid() : Guid.Parse(reader.GetString(9));
            ingestionId = reader.IsDBNull(10) ? null : Guid.Parse(reader.GetString(10));
            ticket = reader.IsDBNull(11) ? null : secrets.Unprotect((byte[])reader[11]);
            tusUrl = reader.IsDBNull(12) ? null : secrets.Unprotect((byte[])reader[12]);
            expiresAt = reader.IsDBNull(13) ? null : DateTimeOffset.Parse(reader.GetString(13));
            revisionBase=reader.IsDBNull(14)?null:System.Text.Json.JsonSerializer.Deserialize<WindowsRevisionBase>(secrets.Unprotect((byte[])reader[14]));
            existingAttempt=!reader.IsDBNull(15);
        }
        // Fix the predecessor once, before any network call. A lost prepare response
        // must retry the identical body even when other files or devices advance.
        if(!existingAttempt){
            command.CommandText="""
                SELECT a.receipt_protected FROM capture_queue previous JOIN upload_attempts a ON a.capture_key=previous.capture_key
                JOIN capture_queue current ON current.capture_key=$capture
                WHERE previous.source_id=current.source_id AND previous.path_token=current.path_token
                  AND previous.tenant_id=$tenant AND previous.user_id=$user AND previous.device_id=$device
                  AND previous.state='acknowledged'
                ORDER BY previous.rowid DESC LIMIT 1;
                """;
            command.Parameters.AddWithValue("$capture",captureKey);command.Parameters.AddWithValue("$generation",generation);
            if(command.ExecuteScalar() is byte[] prior){
                using var receipt=System.Text.Json.JsonDocument.Parse(secrets.Unprotect(prior));var r=receipt.RootElement;
                revisionBase=new(r.GetProperty("document_id").GetGuid(),r.GetProperty("revision_id").GetGuid(),r.TryGetProperty("revision_number",out var version)?version.GetInt32():1);
            }
        }
        command.Parameters.Clear();
        command.CommandText = """
            UPDATE capture_queue SET state='uploading',updated_at=$now
            WHERE capture_key=$key AND state IN ('ready','retry_wait');
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Upload claim changed");
        command.CommandText = """
            INSERT OR IGNORE INTO upload_attempts(capture_key,source_generation,
                prepare_key,complete_key,revision_base_protected)
            VALUES($key,$generation,$prepare,$complete,$base);
            """;
        command.Parameters.AddWithValue("$generation",generation);
        command.Parameters.AddWithValue("$prepare",prepareKey.ToString("D"));
        command.Parameters.AddWithValue("$complete",completeKey.ToString("D"));
        command.Parameters.AddWithValue("$base",revisionBase is null?DBNull.Value:secrets.Protect(System.Text.Json.JsonSerializer.Serialize(revisionBase)));
        command.ExecuteNonQuery();
        transaction.Commit();
        return new UploadCandidate(new CopyCandidate(captureKey,sourceId,path,hash,size,ticks),
            principal,serverSourceId,generation,prepareKey,completeKey,
            ingestionId,ticket,tusUrl,expiresAt,revisionBase);
    }

    public bool UploadStillCurrent(UploadCandidate candidate)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT EXISTS(SELECT 1 FROM capture_queue q
              JOIN folder_sources s ON s.source_id=q.source_id
              JOIN upload_attempts a ON a.capture_key=q.capture_key
              WHERE q.capture_key=$key AND q.state='uploading' AND s.state='selected'
                AND q.tenant_id=$tenant AND q.user_id=$user AND q.device_id=$device
                AND s.tenant_id=$tenant AND s.user_id=$user AND s.device_id=$device
                AND s.server_source_id=$server AND s.source_generation=$generation
                AND a.source_generation=$generation);
            """;
        command.Parameters.AddWithValue("$key",candidate.Copy.CaptureKey);
        command.Parameters.AddWithValue("$tenant",candidate.Principal.TenantId.ToString("D"));
        command.Parameters.AddWithValue("$user",candidate.Principal.UserId.ToString("D"));
        command.Parameters.AddWithValue("$device",candidate.Principal.DeviceId.ToString("D"));
        command.Parameters.AddWithValue("$server",candidate.ServerSourceId.ToString("D"));
        command.Parameters.AddWithValue("$generation",candidate.SourceGeneration);
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    public void SavePreparedUpload(string captureKey, Guid ingestionId,
        string ticket, DateTimeOffset expiresAt)
    {
        if (ingestionId == Guid.Empty || string.IsNullOrWhiteSpace(ticket))
            throw new ArgumentException("Prepared upload is incomplete");
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE upload_attempts SET ingestion_id=$ingestion,
                ticket_protected=$ticket,expires_at=$expires
            WHERE capture_key=$key AND (ingestion_id IS NULL OR ingestion_id=$ingestion)
              AND EXISTS(SELECT 1 FROM capture_queue q WHERE q.capture_key=$key
                AND q.state='uploading');
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$ingestion",ingestionId.ToString("D"));
        command.Parameters.AddWithValue("$ticket",secrets.Protect(ticket));
        command.Parameters.AddWithValue("$expires",expiresAt.ToString("O"));
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Upload attempt is no longer active");
    }

    public void SaveTusUrl(string captureKey, Guid ingestionId, string tusUrl)
    {
        if (!Uri.TryCreate(tusUrl,UriKind.Absolute,out var uri) ||
            uri.Scheme is not ("https" or "http"))
            throw new ArgumentException("Invalid TUS URL",nameof(tusUrl));
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE upload_attempts SET tus_url_protected=$url
            WHERE capture_key=$key AND ingestion_id=$ingestion
              AND EXISTS(SELECT 1 FROM capture_queue q WHERE q.capture_key=$key
                AND q.state='uploading');
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$ingestion",ingestionId.ToString("D"));
        command.Parameters.AddWithValue("$url",secrets.Protect(tusUrl));
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Upload attempt is no longer active");
    }

    /// <summary>Rotates keys only after the server has rejected the old intent.</summary>
    public void ResetAfterServerRejection(string captureKey, Guid rejectedIngestionId,
        DateTimeOffset retryAfter)
    {
        if (rejectedIngestionId == Guid.Empty)
            throw new ArgumentException("Rejected intent is required",nameof(rejectedIngestionId));
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred:false);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE upload_attempts SET prepare_key=$prepare,complete_key=$complete,
                ingestion_id=NULL,ticket_protected=NULL,tus_url_protected=NULL,
                expires_at=NULL,retry_after=$retry
            WHERE capture_key=$key AND ingestion_id=$rejected
              AND EXISTS(SELECT 1 FROM capture_queue q WHERE q.capture_key=$key
                AND q.state='uploading');
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$rejected",rejectedIngestionId.ToString("D"));
        command.Parameters.AddWithValue("$prepare",Guid.NewGuid().ToString("D"));
        command.Parameters.AddWithValue("$complete",Guid.NewGuid().ToString("D"));
        command.Parameters.AddWithValue("$retry",retryAfter.ToUniversalTime().ToString("O"));
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Rejected upload attempt changed");
        command.CommandText = """
            UPDATE capture_queue SET state='retry_wait',updated_at=$now
            WHERE capture_key=$key AND state='uploading';
            """;
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Rejected upload claim changed");
        transaction.Commit();
    }

    public void FinishUpload(string captureKey, string state, string? receipt = null,
        DateTimeOffset? retryAfter = null)
    {
        if (state is not ("retry_wait" or "permission_lost" or "quarantined" or "storage_quota_paused" or "revision_conflict" or
            "acknowledged") || (state == "acknowledged") != (receipt is not null) ||
            (state == "retry_wait") != retryAfter.HasValue)
            throw new ArgumentException("Invalid upload result",nameof(state));
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred:false);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE capture_queue SET state=$state,updated_at=$now
            WHERE capture_key=$key AND state='uploading';
            """;
        command.Parameters.AddWithValue("$key",captureKey);
        command.Parameters.AddWithValue("$state",state);
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Upload attempt is no longer active");
        if (retryAfter.HasValue) {
            command.CommandText = """
                UPDATE upload_attempts SET retry_after=$retry WHERE capture_key=$key;
                """;
            command.Parameters.AddWithValue("$retry",retryAfter.Value.ToUniversalTime()
                .ToString("O"));
            if (command.ExecuteNonQuery() != 1)
                throw new InvalidOperationException("Upload retry has no attempt");
        }
        if (receipt is not null) {
            command.CommandText = """
                UPDATE upload_attempts SET receipt_protected=$receipt,
                    ticket_protected=NULL,tus_url_protected=NULL
                WHERE capture_key=$key AND ingestion_id IS NOT NULL;
                """;
            command.Parameters.AddWithValue("$receipt",secrets.Protect(receipt));
            if (command.ExecuteNonQuery() != 1)
                throw new InvalidOperationException("Upload receipt has no intent");
        }
        transaction.Commit();
    }

    public int RevisionConflictCount(){using var db=Open();using var c=db.CreateCommand();c.CommandText="SELECT COUNT(*) FROM capture_queue WHERE state='revision_conflict'";return Convert.ToInt32(c.ExecuteScalar());}

    public void RecoverInterruptedUploads()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE capture_queue SET state='retry_wait',updated_at=$now
            WHERE state='uploading';
            """;
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
    }

    public int CopyIssueCount()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT COUNT(*) FROM capture_queue WHERE state IN
                ('source_changed','source_unavailable','storage_full','copy_error','too_large','storage_quota_paused');
            """;
        return Convert.ToInt32(command.ExecuteScalar());
    }

    public FolderConnection SelectFolder(string rootPath, WindowsPrincipal? principal = null, int? historyDays = null)
    {
        if(historyDays is < 0)throw new ArgumentOutOfRangeException(nameof(historyDays));
        var root = Path.GetFullPath(rootPath);
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException();
        var volume = WindowsVolumeIdentity.Probe(root);
        var existing = Folders().Where(folder =>
            (principal is null ? folder.TenantId is null :
                folder.TenantId is null || (folder.TenantId == principal.TenantId &&
                    folder.UserId == principal.UserId && folder.DeviceId == principal.DeviceId)) &&
            ((folder.VolumeId != null && folder.VolumeSerial != null && folder.RelativePath != null &&
                volume.SameSource(new WindowsVolumeIdentity(folder.VolumeId,folder.VolumeSerial,
                    volume.MountRoot,folder.RelativePath))) ||
            (folder.VolumeId == null && folder.State == "needs_reauthorization" &&
                string.Equals(folder.RootPath,root,StringComparison.OrdinalIgnoreCase))))
            .OrderByDescending(folder => principal is not null &&
                folder.TenantId == principal.TenantId && folder.UserId == principal.UserId &&
                folder.DeviceId == principal.DeviceId)
            .ThenByDescending(folder => folder.AddedAt).FirstOrDefault();
        if (existing is not null) {
            using var reopen = Open();
            using var resume = reopen.CreateCommand();
            resume.CommandText = "UPDATE folder_sources SET state='selected',root_protected=$root, volume_id=$volume,volume_serial=$serial,relative_path_protected=$relative WHERE source_id=$id;";
            resume.Parameters.AddWithValue("$id",existing.Id);
            resume.Parameters.Add("$root",SqliteType.Blob).Value = secrets.Protect(root);
            resume.Parameters.AddWithValue("$volume",volume.VolumeId);
            resume.Parameters.AddWithValue("$serial",volume.Serial);
            resume.Parameters.Add("$relative",SqliteType.Blob).Value =
                secrets.Protect(volume.RelativePath);
            resume.ExecuteNonQuery();
            return existing with { State = "selected", RootPath = root };
        }
        var id = Guid.NewGuid().ToString("D");
        var now = DateTimeOffset.UtcNow;
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO folder_sources(source_id,root_protected,state,added_at,
                volume_id,volume_serial,relative_path_protected)
            VALUES($id,$root,'selected',$added,$volume,$serial,$relative);
            INSERT INTO folder_scope_baseline(source_id,cutoff_ticks,started_ticks)
            VALUES($id,$cutoff,$started);
            """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.Add("$root", SqliteType.Blob).Value = secrets.Protect(root);
        command.Parameters.AddWithValue("$added", now.ToString("O"));
        command.Parameters.AddWithValue("$cutoff",historyDays is int days ? now.UtcDateTime.AddDays(-days).Ticks : DateTime.MinValue.Ticks);
        command.Parameters.AddWithValue("$started",now.UtcDateTime.Ticks);
        command.Parameters.AddWithValue("$volume",volume.VolumeId);
        command.Parameters.AddWithValue("$serial",volume.Serial);
        command.Parameters.Add("$relative",SqliteType.Blob).Value = secrets.Protect(volume.RelativePath);
        command.ExecuteNonQuery();
        return new FolderConnection(id, root, "selected", now,volume.VolumeId,
            volume.Serial,volume.RelativePath);
    }

    public void BindSource(string sourceId, WindowsPrincipal principal,
        Guid serverSourceId, int generation, bool includeExistingBackfill = false)
    {
        if (generation < 1 || serverSourceId == Guid.Empty ||
            principal.TenantId == Guid.Empty || principal.UserId == Guid.Empty ||
            principal.DeviceId == Guid.Empty) throw new ArgumentOutOfRangeException(nameof(generation));
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE folder_sources SET tenant_id=$tenant,user_id=$user,
                device_id=$device,server_source_id=$server,source_generation=$generation,
                connect_attempt_key=NULL,attempt_device_id=NULL
            WHERE source_id=$id AND state='selected' AND
                (tenant_id IS NULL OR (tenant_id=$tenant AND user_id=$user AND device_id=$device))
                AND (server_source_id IS NULL OR server_source_id=$server)
                AND (source_generation IS NULL OR source_generation <= $generation);
            """;
        command.Parameters.AddWithValue("$id",sourceId);
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));
        command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));
        command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        command.Parameters.AddWithValue("$server",serverSourceId.ToString("D"));
        command.Parameters.AddWithValue("$generation",generation);
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Source is paused or owned by another account");
        command.CommandText = includeExistingBackfill ? """
            UPDATE capture_queue SET tenant_id=$tenant,user_id=$user,device_id=$device,
                state='discovered',updated_at=$now
            WHERE source_id=$id AND tenant_id IS NULL AND state NOT IN
                ('acknowledged','revoked_purged','local_key_lost','too_large');
            """ : """
            UPDATE capture_queue SET state='backfill_approval_needed',updated_at=$now
            WHERE source_id=$id AND tenant_id IS NULL AND state NOT IN
                ('acknowledged','revoked_purged','local_key_lost','too_large');
            """;
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
        command.CommandText = """
            UPDATE capture_queue SET state='permission_lost',updated_at=$now
            WHERE source_id=$id AND state IN ('ready','retry_wait','uploading')
              AND capture_key IN (SELECT capture_key FROM upload_attempts
                WHERE source_generation!=$generation);
            """;
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    public int BackfillApprovalCount()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM capture_queue WHERE state='backfill_approval_needed';";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    public BackfillApprovalSnapshot BackfillSnapshot(string sourceId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*),COALESCE(MAX(rowid),0) FROM capture_queue WHERE source_id=$source AND state='backfill_approval_needed';";
        command.Parameters.AddWithValue("$source",sourceId);
        using var reader = command.ExecuteReader();
        reader.Read();
        return new BackfillApprovalSnapshot(reader.GetInt32(0),reader.GetInt64(1));
    }

    public int ApproveExistingBackfill(string sourceId, WindowsPrincipal principal,
        BackfillApprovalSnapshot snapshot)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred:false);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT COUNT(*) FROM capture_queue WHERE source_id=$source AND state='backfill_approval_needed' AND rowid<=$max;";
        command.Parameters.AddWithValue("$source",sourceId);
        command.Parameters.AddWithValue("$max",snapshot.MaxRowId);
        if (snapshot.Count < 1 || Convert.ToInt32(command.ExecuteScalar()) != snapshot.Count)
            throw new BackfillSetChangedException();
        command.CommandText = """
            UPDATE capture_queue SET state='discovered',tenant_id=$tenant,
                user_id=$user,device_id=$device,updated_at=$now
            WHERE source_id=$source AND state='backfill_approval_needed'
                AND rowid<=$max
                AND EXISTS(SELECT 1 FROM folder_sources s WHERE s.source_id=$source
                    AND s.state='selected' AND s.server_source_id IS NOT NULL
                    AND s.tenant_id=$tenant AND s.user_id=$user AND s.device_id=$device);
            """;
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));
        command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));
        command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        var approved = command.ExecuteNonQuery();
        if (approved != snapshot.Count) throw new BackfillSetChangedException();
        transaction.Commit();
        return approved;
    }

    /// <summary>Explicit revocation recovery creates a new local lineage and fences the old queue.</summary>
    public FolderConnection RebindAfterRevocation(string oldSourceId,
        WindowsPrincipal principal, Guid oldServerSourceId, int oldGeneration,
        Guid newServerSourceId, int newGeneration)
    {
        if (oldGeneration < 1 || newGeneration < 1 ||
            oldServerSourceId == Guid.Empty || newServerSourceId == Guid.Empty ||
            oldServerSourceId == newServerSourceId)
            throw new ArgumentOutOfRangeException(nameof(newServerSourceId));
        var old = Folders().SingleOrDefault(folder => folder.Id == oldSourceId);
        if (old is null || old.RootPath is null || old.RelativePath is null)
            throw new InvalidOperationException("Source requires reauthorization");
        var nextId = Guid.NewGuid().ToString("D");
        var now = DateTimeOffset.UtcNow;
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE folder_sources SET state='paused' WHERE source_id=$old
                AND state='selected' AND tenant_id=$tenant AND user_id=$user
                AND device_id=$device AND server_source_id=$oldServer
                AND source_generation=$oldGeneration;
            """;
        command.Parameters.AddWithValue("$old",oldSourceId);
        command.Parameters.AddWithValue("$tenant",principal.TenantId.ToString("D"));
        command.Parameters.AddWithValue("$user",principal.UserId.ToString("D"));
        command.Parameters.AddWithValue("$device",principal.DeviceId.ToString("D"));
        command.Parameters.AddWithValue("$oldServer",oldServerSourceId.ToString("D"));
        command.Parameters.AddWithValue("$oldGeneration",oldGeneration);
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("Revoked source binding does not match");
        command.CommandText = """
            UPDATE capture_queue SET state='revoked_pending_purge',updated_at=$now
            WHERE source_id=$old AND tenant_id=$tenant AND user_id=$user
                AND device_id=$device AND state NOT IN
                ('acknowledged','revoked_purged','local_key_lost');
            """;
        command.Parameters.AddWithValue("$now",now.ToString("O"));
        command.ExecuteNonQuery();
        command.CommandText = """
            INSERT INTO folder_sources(source_id,root_protected,state,added_at,
                volume_id,volume_serial,relative_path_protected,tenant_id,user_id,
                device_id,server_source_id,source_generation)
            SELECT $next,root_protected,'selected',$now,volume_id,volume_serial,
                relative_path_protected,$tenant,$user,$device,$newServer,$newGeneration
            FROM folder_sources WHERE source_id=$old;
            """;
        command.Parameters.AddWithValue("$next",nextId);
        command.Parameters.AddWithValue("$newServer",newServerSourceId.ToString("D"));
        command.Parameters.AddWithValue("$newGeneration",newGeneration);
        if (command.ExecuteNonQuery() != 1)
            throw new InvalidOperationException("New source was not created");
        transaction.Commit();
        return old with { Id = nextId, State = "selected", AddedAt = now,
            ServerSourceId = newServerSourceId, SourceGeneration = newGeneration };
    }

    public IReadOnlyList<FolderConnection> Folders()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT source_id,root_protected,state,added_at,volume_id,volume_serial,relative_path_protected,tenant_id,user_id,device_id,server_source_id,source_generation FROM folder_sources ORDER BY added_at;";
        using var reader = command.ExecuteReader();
        var folders = new List<FolderConnection>();
        while (reader.Read()) {
            string? root;
            string? relative;
            var state = reader.GetString(2);
            try {
                root = secrets.Unprotect((byte[])reader[1]);
                relative = reader.IsDBNull(6) ? null : secrets.Unprotect((byte[])reader[6]);
            }
            catch (CryptographicException) {
                root = null;
                relative = null;
                state = "needs_reauthorization";
            }
            if (reader.IsDBNull(4) || reader.IsDBNull(5) || relative == null)
                state = "needs_reauthorization";
            folders.Add(new FolderConnection(reader.GetString(0),root,state,
                DateTimeOffset.Parse(reader.GetString(3)),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetString(5),relative,
                reader.IsDBNull(7) ? null : Guid.Parse(reader.GetString(7)),
                reader.IsDBNull(8) ? null : Guid.Parse(reader.GetString(8)),
                reader.IsDBNull(9) ? null : Guid.Parse(reader.GetString(9)),
                reader.IsDBNull(10) ? null : Guid.Parse(reader.GetString(10)),
                reader.IsDBNull(11) ? null : reader.GetInt32(11)));
        }
        return folders;
    }

    public int PendingCount()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM capture_queue WHERE state NOT IN ('acknowledged','revoked_purged');";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    public SourceHealth? Health(string sourceId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT state,last_scan_at,candidate_count,error_code FROM source_health WHERE source_id=$id;";
        command.Parameters.AddWithValue("$id",sourceId);
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return null;
        return new SourceHealth(reader.GetString(0),reader.IsDBNull(1) ? null :
            DateTimeOffset.Parse(reader.GetString(1)),reader.GetInt32(2),
            reader.IsDBNull(3) ? null : reader.GetString(3));
    }

    public int SourceIssueCount()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM source_health WHERE state IN ('source_offline','scan_gap') AND COALESCE(error_code,'') NOT IN ('backlog_pending');";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    public void RecordHealth(string sourceId, string health, int candidates = 0,
        string? errorCode = null)
    {
        if (health is not ("current" or "source_offline" or "scan_gap" or "paused"))
            throw new ArgumentOutOfRangeException(nameof(health));
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO source_health(source_id,state,last_scan_at,candidate_count,error_code)
            VALUES($id,$state,$at,$count,$error)
            ON CONFLICT(source_id) DO UPDATE SET state=excluded.state,
                last_scan_at=CASE WHEN excluded.state='current' THEN excluded.last_scan_at
                    ELSE source_health.last_scan_at END,
                candidate_count=CASE WHEN excluded.state='current' OR excluded.error_code IN ('backlog_pending','partial_inventory') THEN excluded.candidate_count
                    ELSE source_health.candidate_count END,error_code=excluded.error_code;
            """;
        command.Parameters.AddWithValue("$id",sourceId);
        command.Parameters.AddWithValue("$state",health);
        command.Parameters.AddWithValue("$at",health == "current" ?
            DateTimeOffset.UtcNow.ToString("O") : DBNull.Value);
        command.Parameters.AddWithValue("$count",candidates);
        command.Parameters.AddWithValue("$error",(object?)errorCode ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    public void RememberMountedPath(FolderConnection folder, string currentPath)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE folder_sources SET root_protected=$root WHERE source_id=$id AND state='selected' AND volume_id=$volume AND volume_serial=$serial;";
        command.Parameters.AddWithValue("$id",folder.Id);
        command.Parameters.AddWithValue("$volume",folder.VolumeId);
        command.Parameters.AddWithValue("$serial",folder.VolumeSerial);
        command.Parameters.Add("$root",SqliteType.Blob).Value = secrets.Protect(currentPath);
        command.ExecuteNonQuery();
    }

    public void MarkKeyUnrecoverable()
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE folder_sources SET state='paused' WHERE state='selected';";
        command.ExecuteNonQuery();
        command.CommandText = "UPDATE capture_queue SET state='local_key_lost', updated_at=$now WHERE state NOT IN ('acknowledged','revoked_purged');";
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
        command.CommandText = "INSERT INTO local_settings(setting_key,setting_value) VALUES('local_key_reset_at',$now) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value;";
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    public bool HadKeyReset()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT EXISTS(SELECT 1 FROM local_settings WHERE setting_key='local_key_reset_at');";
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    public void PauseSource(string sourceId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE folder_sources SET state='paused' WHERE source_id=$id;";
        command.Parameters.AddWithValue("$id",sourceId);
        command.ExecuteNonQuery();
    }

    public void Logout()
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE folder_sources SET state='paused';";
        command.ExecuteNonQuery();
        command.CommandText = "UPDATE capture_queue SET state='paused_logout', updated_at=$now WHERE state NOT IN ('acknowledged','revoked_purged','local_key_lost');";
        command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.ToString("O"));
        command.ExecuteNonQuery();
        transaction.Commit();
    }
}
