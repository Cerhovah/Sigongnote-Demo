using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class UploadTransportTests
{
    private sealed class StubHandler(Func<HttpRequestMessage,HttpResponseMessage> reply)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(reply(request));
    }

    private static HttpResponseMessage JsonResponse(object body,HttpStatusCode status) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body),
            Encoding.UTF8,"application/json") };

    [TestMethod, TestCategory("C16")]
    [DataRow(false)]
    [DataRow(true)]
    public async Task LocalPauseDuringRemoteSourceCheckStopsBeforeUpload(bool brokenSetup)
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-pause-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var file = Path.Combine(root,"synthetic.pdf");
            File.WriteAllText(file,"synthetic");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var folder = state.SelectFolder(root);
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var device = Guid.NewGuid();
            var source = Guid.NewGuid();
            state.BindSource(folder.Id,new WindowsPrincipal(tenant,user,device),source,1);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(folder.Id,root,file);
            stabilizer.Observe(folder.Id,root,file);
            using var copies = new WindowsEncryptedCopyStore(state,
                RandomNumberGenerator.GetBytes(32),Path.Combine(sandbox,"copies"));
            Assert.AreEqual(1,copies.StagePending());
            var session = new WindowsSession("https://api.example.test/",
                "https://storage.example.test/","fixture-publishable","fixture-token",
                "fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                tenant,user,device);
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            string? pendingId=null;
            if(brokenSetup) {
                var pendingRoot=Path.Combine(sandbox,"pending");Directory.CreateDirectory(pendingRoot);pendingId=state.SelectFolder(pendingRoot).Id;
                state.SaveFolderSetup(new WindowsSourceSetup(pendingId,Guid.NewGuid(),session.Principal,
                    new("fixture","work_records","local_fixture","development_computer","development_computer","until_user_deletes",false),
                    new("folder",null,"현장",false),"fixture",null));
            }
            var handler = new StubHandler(request => {
                if(request.RequestUri!.AbsolutePath=="/v1/capture-policy")return new(HttpStatusCode.OK){Content=new StringContent("not json",Encoding.UTF8,"application/json")};
                if (request.RequestUri!.AbsolutePath == "/v1/me")
                    return JsonResponse(new {user_id=user,memberships=new[] {
                        new {tenant_id=tenant,tenant_name="Fixture",role="owner"}}},
                        HttpStatusCode.OK);
                if (request.RequestUri.AbsolutePath == "/v1/capture-sources") {
                    state.PauseSource(folder.Id);
                    return JsonResponse(new {sources=new[] {
                        new {id=source,tenant_id=tenant,device_id=device,kind="folder",
                            upload_ready=true,server_upload_consent=true,active=true,
                            device_active=true,generation=1}}},HttpStatusCode.OK);
                }
                throw new AssertFailedException("Paused folder attempted network upload");
            });
            using var sessions = new WindowsSessionManager(vault,handler);
            using var transport = new WindowsUploadTransport(state,copies,sessions,handler);
            Assert.IsTrue(await transport.UploadOneAsync());
            if(pendingId is not null)Assert.AreEqual("pending",state.FolderSetupState(pendingId));
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource=database,Pooling=false,
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT state FROM capture_queue;";
            Assert.AreEqual("permission_lost",command.ExecuteScalar());
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task ExpiredTusSessionIsAbandonedBeforeLocalKeysRotate()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-expired-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var file = Path.Combine(root,"synthetic.pdf");
            File.WriteAllText(file,"synthetic");
            var database = Path.Combine(sandbox,"state.db");
            var state = new WindowsStateStore(database);
            var folder = state.SelectFolder(root);
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var device = Guid.NewGuid();
            var source = Guid.NewGuid();
            var principal = new WindowsPrincipal(tenant,user,device);
            state.BindSource(folder.Id,principal,source,1);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(folder.Id,root,file);
            stabilizer.Observe(folder.Id,root,file);
            using var copies = new WindowsEncryptedCopyStore(state,
                RandomNumberGenerator.GetBytes(32),Path.Combine(sandbox,"copies"));
            Assert.AreEqual(1,copies.StagePending());
            var original = state.BeginUpload(principal);
            Assert.IsNotNull(original);
            var intent = Guid.NewGuid();
            var signature = new string('x',64);
            var ticket = JsonSerializer.Serialize(new {
                ingestion_id=intent,state="prepared",
                upload_url=$"https://storage.example.test/storage/v1/object/upload/sign/sigongnote-originals/{tenant:D}/{intent:D}?token={signature}",
                expires_at=DateTimeOffset.UtcNow.AddHours(1).ToString("O"),
                upload=new {protocol="tus",endpoint="https://storage.example.test/storage/v1/upload/resumable",
                    signature,bucket="sigongnote-originals",
                    object_name=$"{tenant:D}/{intent:D}",chunk_bytes=6291456,upsert=false},
            });
            state.SavePreparedUpload(original.Copy.CaptureKey,intent,ticket,
                DateTimeOffset.UtcNow.AddHours(1));
            state.SaveTusUrl(original.Copy.CaptureKey,intent,
                "https://storage.example.test/storage/v1/upload/resumable/expired");
            state.FinishUpload(original.Copy.CaptureKey,"retry_wait",retryAfter:
                DateTimeOffset.UtcNow.AddMinutes(-1));
            var session = new WindowsSession("https://api.example.test/",
                "https://storage.example.test/","fixture-publishable","fixture-token",
                "fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                tenant,user,device);
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var abandonCalls = 0;
            var completeCalls = 0;
            var handler = new StubHandler(request => request.RequestUri!.AbsolutePath switch {
                "/v1/me" => JsonResponse(new {user_id=user,memberships=new[] {
                    new {tenant_id=tenant,tenant_name="Fixture",role="owner"}}},
                    HttpStatusCode.OK),
                "/v1/capture-sources" => JsonResponse(new {sources=new[] {
                    new {id=source,tenant_id=tenant,device_id=device,kind="folder",
                        upload_ready=true,server_upload_consent=true,active=true,
                        device_active=true,generation=1}}},HttpStatusCode.OK),
                "/storage/v1/upload/resumable/expired" =>
                    new HttpResponseMessage(HttpStatusCode.Gone),
                var path when path == $"/v1/ingestions/{intent:D}/complete" =>
                    Complete(),
                var path when path == $"/v1/ingestions/{intent:D}/abandon" =>
                    Abandon(),
                _ => throw new AssertFailedException("Unexpected retry request"),
            });
            HttpResponseMessage Complete() => new(++completeCalls == 1
                ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.Gone);
            HttpResponseMessage Abandon()
            {
                abandonCalls++;
                return JsonResponse(new {ingestion_id=intent,state="rejected",
                    reason="client_abandoned"},HttpStatusCode.OK);
            }
            using var sessions = new WindowsSessionManager(vault,handler);
            using var transport = new WindowsUploadTransport(state,copies,sessions,handler);
            Assert.IsTrue(await transport.UploadOneAsync());
            Assert.AreEqual(0,abandonCalls);
            using (var retryConnection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource=database,Pooling=false,
            }.ToString())) {
                retryConnection.Open();
                using var retry = retryConnection.CreateCommand();
                retry.CommandText = "UPDATE upload_attempts SET retry_after=$past;";
                retry.Parameters.AddWithValue("$past",DateTimeOffset.UtcNow.AddMinutes(-1)
                    .ToString("O"));
                retry.ExecuteNonQuery();
            }
            Assert.IsTrue(await transport.UploadOneAsync());
            Assert.AreEqual(1,abandonCalls);
            Assert.IsNull(state.BeginUpload(principal));
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource=database,Pooling=false,
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT q.state,a.prepare_key,a.ingestion_id,a.ticket_protected,a.tus_url_protected
                FROM capture_queue q JOIN upload_attempts a ON a.capture_key=q.capture_key;
                """;
            using var reader = command.ExecuteReader();
            Assert.IsTrue(reader.Read());
            Assert.AreEqual("retry_wait",reader.GetString(0));
            Assert.AreNotEqual(original.PrepareKey,Guid.Parse(reader.GetString(1)));
            Assert.IsTrue(reader.IsDBNull(2));
            Assert.IsTrue(reader.IsDBNull(3));
            Assert.IsTrue(reader.IsDBNull(4));
        } finally { Directory.Delete(sandbox,true); }
    }

    [TestMethod, TestCategory("C16")]
    public async Task EncryptedCopyUploadsInTusChunksThenAcknowledgesReceipt()
    {
        var sandbox = Path.Combine(Path.GetTempPath(),"sigongnote-c16-tus-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sandbox);
        try {
            var root = Path.Combine(sandbox,"work");
            Directory.CreateDirectory(root);
            var original = RandomNumberGenerator.GetBytes(6 * 1024 * 1024 + 13);
            var file = Path.Combine(root,"synthetic.pdf");
            File.WriteAllBytes(file,original);
            var originalHash = Convert.ToHexString(SHA256.HashData(original));
            var state = new WindowsStateStore(Path.Combine(sandbox,"state.db"));
            var folder = state.SelectFolder(root);
            var tenant = Guid.NewGuid();
            var user = Guid.NewGuid();
            var device = Guid.NewGuid();
            var source = Guid.NewGuid();
            var principal = new WindowsPrincipal(tenant,user,device);
            state.BindSource(folder.Id,principal,source,1);
            var stabilizer = new WindowsFileStabilizer(state,TimeSpan.Zero);
            stabilizer.Observe(folder.Id,root,file);
            stabilizer.Observe(folder.Id,root,file);
            using var copies = new WindowsEncryptedCopyStore(state,
                RandomNumberGenerator.GetBytes(32),Path.Combine(sandbox,"copies"));
            Assert.AreEqual(1,copies.StagePending());
            var session = new WindowsSession("https://api.example.test/",
                "https://storage.example.test/","fixture-publishable","fixture-token",
                "fixture-refresh",DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
                tenant,user,device);
            var vault = new WindowsTokenVault(Path.Combine(sandbox,"session.protected"));
            vault.Save(JsonSerializer.Serialize(session));
            var ingestion = Guid.NewGuid();
            var blob = Guid.NewGuid();
            var document = Guid.NewGuid();
            var revision = Guid.NewGuid();
            var job = Guid.NewGuid();
            var signature = new string('x',64);
            var prepared = 0;
            var patched = 0;
            long offset = 0;
            var handler = new StubHandler(request => {
                Assert.AreEqual("fixture-token",request.Headers.Authorization?.Parameter);
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/v1/me") return JsonResponse(new {
                    user_id=user,memberships=new[] {new {tenant_id=tenant,
                        tenant_name="Fixture",role="owner"}},
                },HttpStatusCode.OK);
                if (path == "/v1/capture-sources") return JsonResponse(new {
                    sources=new[] {new {id=source,tenant_id=tenant,device_id=device,
                        kind="folder",upload_ready=true,server_upload_consent=true,
                        active=true,device_active=true,generation=1}},
                },HttpStatusCode.OK);
                if (path == "/v1/ingestions") {
                    prepared++;
                    using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync()
                        .GetAwaiter().GetResult());
                    Assert.AreEqual(source,body.RootElement.GetProperty("source_id").GetGuid());
                    Assert.AreEqual(1,body.RootElement.GetProperty("source_generation")
                        .GetInt32());
                    Assert.AreEqual(originalHash.ToLowerInvariant(),body.RootElement
                        .GetProperty("sha256").GetString());
                    Assert.AreEqual(6 * 1024 * 1024 + 13,body.RootElement
                        .GetProperty("byte_length").GetInt32());
                    return JsonResponse(new {ingestion_id=ingestion,state="prepared",
                        upload_url=$"https://storage.example.test/storage/v1/object/upload/sign/sigongnote-originals/{tenant:D}/{ingestion:D}?token={signature}",
                        expires_at=DateTimeOffset.UtcNow.AddHours(1).ToString("O"),
                        upload=new {protocol="tus",endpoint="https://storage.example.test/storage/v1/upload/resumable",
                            signature,bucket="sigongnote-originals",
                            object_name=$"{tenant:D}/{ingestion:D}",chunk_bytes=6291456,
                            authorization="user_bearer+signature",
                            metadata_keys="bucketName,objectName,contentType",upsert=false}},
                        HttpStatusCode.Created);
                }
                if (path.StartsWith("/storage/",StringComparison.Ordinal))
                    Assert.AreEqual(signature,request.Headers.GetValues("x-signature").Single());
                if (path == "/storage/v1/upload/resumable" && request.Method == HttpMethod.Post) {
                    Assert.AreEqual(original.Length.ToString(),request.Headers
                        .GetValues("Upload-Length").Single());
                    var response = new HttpResponseMessage(HttpStatusCode.Created);
                    response.Headers.Location = new Uri("https://storage.example.test/storage/v1/upload/resumable/fixture-session");
                    return response;
                }
                if (path == "/storage/v1/upload/resumable/fixture-session" &&
                    request.Method == HttpMethod.Head) {
                    var response = new HttpResponseMessage(HttpStatusCode.NoContent);
                    response.Headers.TryAddWithoutValidation("Upload-Offset",offset.ToString());
                    return response;
                }
                if (path == "/storage/v1/upload/resumable/fixture-session" &&
                    request.Method == HttpMethod.Patch) {
                    Assert.AreEqual(offset.ToString(),request.Headers
                        .GetValues("Upload-Offset").Single());
                    var bytes = request.Content!.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                    CollectionAssert.AreEqual(original.AsSpan((int)offset,bytes.Length).ToArray(),
                        bytes);
                    patched++;
                    offset += bytes.Length;
                    var response = new HttpResponseMessage(HttpStatusCode.NoContent);
                    response.Headers.TryAddWithoutValidation("Upload-Offset",offset.ToString());
                    return response;
                }
                if (path == $"/v1/ingestions/{ingestion:D}/complete") {
                    Assert.AreEqual(original.Length,offset);
                    return JsonResponse(new {ingestion_id=ingestion,state="queued",
                        blob_id=blob,document_id=document,revision_id=revision,
                        job_id=job,deduplicated=false},HttpStatusCode.OK);
                }
                throw new AssertFailedException("Unexpected upload request: " + path);
            });
            using var sessions = new WindowsSessionManager(vault,handler);
            using var transport = new WindowsUploadTransport(state,copies,sessions,handler);
            Assert.IsTrue(await transport.UploadOneAsync());
            Assert.IsFalse(await transport.UploadOneAsync());
            Assert.AreEqual(1,prepared);
            Assert.AreEqual(2,patched);
            Assert.AreEqual(original.Length,offset);
            Assert.AreEqual(originalHash,Convert.ToHexString(SHA256.HashData(
                File.ReadAllBytes(file))));
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder {
                DataSource=Path.Combine(sandbox,"state.db"),Pooling=false,
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT state FROM capture_queue;";
            Assert.AreEqual("acknowledged",command.ExecuteScalar());
        } finally { Directory.Delete(sandbox,true); }
    }
}
