"""Replay Android Room migrations on a disposable SQLite fixture."""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "apps/android/app/schemas/com.sigongnote.app.CaptureQueueDatabase"
MIGRATIONS = ROOT / "apps/android/app/src/main/assets/migrations"


def entity(schema, name):
    return next(item for item in schema["database"]["entities"] if item["tableName"] == name)


def create_entity(db, item):
    db.execute(item["createSql"].replace("${TABLE_NAME}", item["tableName"]))
    for index in item.get("indices", []):
        db.execute(index["createSql"].replace("${TABLE_NAME}", item["tableName"]))


def assert_entity(db, item):
    actual = {row[1]: (row[2], bool(row[3])) for row in db.execute(
        f"PRAGMA table_info('{item['tableName']}')")}
    expected = {field["columnName"]: (field["affinity"], field.get("notNull", False))
                for field in item["fields"]}
    assert actual == expected, (item["tableName"], actual, expected)
    indices = {row[1] for row in db.execute(f"PRAGMA index_list('{item['tableName']}')")}
    assert {index["name"] for index in item.get("indices", [])} <= indices


old = json.loads((SCHEMAS / "1.json").read_text(encoding="utf-8"))
new = json.loads((SCHEMAS / "2.json").read_text(encoding="utf-8"))
latest = json.loads((SCHEMAS / "3.json").read_text(encoding="utf-8"))
notification_version = json.loads((SCHEMAS / "4.json").read_text(encoding="utf-8"))
retention_version = json.loads((SCHEMAS / "5.json").read_text(encoding="utf-8"))
binding_version = json.loads((SCHEMAS / "6.json").read_text(encoding="utf-8"))
notification_upload_version = json.loads((SCHEMAS / "7.json").read_text(encoding="utf-8"))
sql = (MIGRATIONS / "1-2.sql").read_text(encoding="utf-8")
folder_sql = (MIGRATIONS / "2-3.sql").read_text(encoding="utf-8")
notification_sql = (MIGRATIONS / "3-4.sql").read_text(encoding="utf-8")
retention_sql = (MIGRATIONS / "4-5.sql").read_text(encoding="utf-8")
binding_sql = (MIGRATIONS / "5-6.sql").read_text(encoding="utf-8")
notification_upload_sql = (MIGRATIONS / "6-7.sql").read_text(encoding="utf-8")
assert old["database"]["version"] == 1 and new["database"]["version"] == 2
assert latest["database"]["version"] == 3
assert notification_version["database"]["version"] == 4
assert retention_version["database"]["version"] == 5
assert binding_version["database"]["version"] == 6
assert notification_upload_version["database"]["version"] == 7
db = sqlite3.connect(":memory:")
create_entity(db, entity(old, "capture_queue"))
capture_id = "0f8fad5b-d9cb-469f-a165-70867728950e"
db.execute("""INSERT INTO capture_queue
    (captureId,tenantId,userId,deviceId,sourceId,sourceGeneration,state,
     createdAtEpochMs,updatedAtEpochMs) VALUES (?,?,?,?,?,1,'ready',1,1)""",
           (capture_id,) * 5)

for cycle in range(2):
    db.executescript(sql)
    for item in new["database"]["entities"]:
        assert_entity(db, item)
    assert db.execute("SELECT state FROM capture_queue WHERE captureId=?", (capture_id,)).fetchone() == ("ready",)
    db.execute("DROP TABLE share_inbox")
    assert_entity(db, entity(old, "capture_queue"))
    assert db.execute("SELECT count(*) FROM capture_queue").fetchone()[0] == 1

db.executescript(sql)
share_id = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
db.execute("""INSERT INTO share_inbox
    (shareId,batchId,state,declaredMime,createdAtEpochMs,uploadPath)
    VALUES (?,?,'staged_unbound','text/plain',1,'direct')""",(share_id,share_id))
for cycle in range(2):
    db.executescript(folder_sql)
    for item in latest["database"]["entities"]:
        assert_entity(db,item)
    assert db.execute("SELECT state FROM capture_queue WHERE captureId=?", (capture_id,)).fetchone() == ("ready",)
    assert db.execute("SELECT state FROM share_inbox WHERE shareId=?", (share_id,)).fetchone() == ("staged_unbound",)
    db.execute("DROP TABLE folder_observations")
    db.execute("DROP TABLE folder_pending")
    db.execute("DROP TABLE folder_sources")
    for item in new["database"]["entities"]:
        assert_entity(db,item)

db.executescript(folder_sql)
folder_id = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
db.execute("""INSERT INTO folder_sources
    (localSourceId,encryptedTreeUri,scopeVersion,state,scanGeneration,observedCount,
     eligibleCount,excludedCount,pendingCount,selectedAtEpochMs)
    VALUES (?,'sealed',1,'current',1,0,0,0,0,1)""",(folder_id,))
for cycle in range(2):
    db.executescript(notification_sql)
    for item in notification_version["database"]["entities"]:
        assert_entity(db,item)

    assert db.execute("SELECT state FROM folder_sources WHERE localSourceId=?",
                      (folder_id,)).fetchone() == ("current",)
    assert db.execute("SELECT state FROM share_inbox WHERE shareId=?",
                      (share_id,)).fetchone() == ("staged_unbound",)
    db.execute("DROP TABLE notification_snapshots")
    db.execute("DROP TABLE notification_scopes")
    db.execute("DROP TABLE notification_sources")
    for item in latest["database"]["entities"]:
        assert_entity(db,item)

db.executescript(notification_sql)
for cycle in range(2):
    db.executescript(retention_sql)
    for item in retention_version["database"]["entities"]:
        assert_entity(db,item)
    assert db.execute("SELECT retentionHold FROM share_inbox WHERE shareId=?",
                      (share_id,)).fetchone() == (0,)
    assert db.execute("SELECT state FROM capture_queue WHERE captureId=?",
                      (capture_id,)).fetchone() == ("ready",)
    # Rebuild the table to verify a reproducible reverse path on older SQLite releases.
    db.execute("CREATE TABLE share_inbox_v4 AS SELECT shareId,batchId,state,declaredMime,encryptedCopyName,sha256,byteLength,failureCode,createdAtEpochMs,duplicateOfShareId,uploadPath FROM share_inbox")
    db.execute("DROP TABLE share_inbox")
    create_sql = entity(notification_version,"share_inbox")["createSql"].replace("${TABLE_NAME}","share_inbox")
    db.execute(create_sql)
    db.execute("INSERT INTO share_inbox SELECT * FROM share_inbox_v4")
    db.execute("DROP TABLE share_inbox_v4")
    for index in entity(notification_version,"share_inbox").get("indices",[]):
        db.execute(index["createSql"].replace("${TABLE_NAME}","share_inbox"))
    for item in notification_version["database"]["entities"]:
        assert_entity(db,item)

db.executescript(retention_sql)
ack_id = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
db.execute("""INSERT INTO capture_queue
    (captureId,tenantId,userId,deviceId,sourceId,sourceGeneration,state,
     createdAtEpochMs,updatedAtEpochMs) VALUES (?,?,?,?,?,1,'acknowledged',1,42)""",
           (ack_id,) * 5)
db.execute("""INSERT INTO folder_observations
    (observationId,localSourceId,documentIdHash,sha256,byteLength,declaredMime,
     encryptedCopyName,lastSeenGeneration,state,observedAtEpochMs)
     VALUES (?,?,?,?,1,'text/plain','fixture.sealed',1,'staged_unbound',1)""",
           (ack_id,folder_id,"a" * 64,"b" * 64))

def reverse_entity(db, old_item):
    name = old_item["tableName"]
    fields = [field["columnName"] for field in old_item["fields"]]
    columns = ",".join(f'`{field}`' for field in fields)
    db.execute(old_item["createSql"].replace("${TABLE_NAME}",f"{name}_rollback"))
    db.execute(f"INSERT INTO `{name}_rollback` ({columns}) SELECT {columns} FROM `{name}`")
    db.execute(f"DROP TABLE `{name}`")
    db.execute(f"ALTER TABLE `{name}_rollback` RENAME TO `{name}`")
    for index in old_item.get("indices",[]):
        db.execute(index["createSql"].replace("${TABLE_NAME}",name))

for cycle in range(2):
    db.executescript(binding_sql)
    for item in binding_version["database"]["entities"]:
        assert_entity(db,item)
    assert db.execute("SELECT acknowledgedAtEpochMs FROM capture_queue WHERE captureId=?",
                      (ack_id,)).fetchone() == (42,)
    assert db.execute("SELECT boundTenantId FROM folder_sources WHERE localSourceId=?",
                      (folder_id,)).fetchone() == (None,)
    assert db.execute("SELECT serverDocumentId FROM folder_observations WHERE observationId=?",
                      (ack_id,)).fetchone() == (None,)
    for name in ("capture_queue","folder_sources","folder_observations"):
        reverse_entity(db,entity(retention_version,name))
    for item in retention_version["database"]["entities"]:
        assert_entity(db,item)
    assert db.execute("SELECT state FROM folder_observations WHERE observationId=?",
                      (ack_id,)).fetchone() == ("staged_unbound",)

db.executescript(binding_sql)
db.execute("""INSERT INTO notification_scopes
    (packageName,conversationHash,approvedAtEpochMs,encryptedLabel)
    VALUES ('fixture.app',?,1,'sealed-label')""",("c" * 64,))
db.execute("""INSERT INTO notification_snapshots
    (snapshotId,packageName,keyHash,conversationHash,contentFingerprint,updateIndex,
     encryptedPayload,observedAtEpochMs,state,fromActiveAtReconnect)
    VALUES (?,'fixture.app',?,?,?,1,'sealed-body',1,'approved_local',0)""",
    (ack_id,"a" * 64,"c" * 64,"b" * 64))
for cycle in range(2):
    db.executescript(notification_upload_sql)
    for item in notification_upload_version["database"]["entities"]:
        assert_entity(db,item)
    assert db.execute("SELECT tenantId FROM notification_snapshots WHERE snapshotId=?",
                      (ack_id,)).fetchone() == (None,)
    assert (db.execute("SELECT tenantId FROM notification_scopes WHERE packageName='fixture.app'")
            .fetchone() == (None,))
    for name in ("notification_snapshots","notification_scopes"):
        reverse_entity(db,entity(binding_version,name))
    for item in binding_version["database"]["entities"]:
        assert_entity(db,item)

db.close()
print("PASS")
