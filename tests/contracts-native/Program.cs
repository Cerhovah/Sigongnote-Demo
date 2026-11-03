using System.Text.Json;
using Sigongnote.Contracts;
var fixtures = JsonDocument.Parse(File.ReadAllText(args.Single())).RootElement;
foreach (var fixture in fixtures.EnumerateArray()) {
 var name = fixture.GetProperty("name").GetString()!;
 var input = fixture.GetProperty("value").GetRawText();
 object value = name switch {
  "WorkRequest" => JsonSerializer.Deserialize<WorkRequest>(input)!,
  "CaptureStorageUsage" => JsonSerializer.Deserialize<CaptureStorageUsage>(input)!,
  "WorkspaceCreateRequest" => JsonSerializer.Deserialize<WorkspaceCreateRequest>(input)!,
  "WorkspaceResponse" => JsonSerializer.Deserialize<WorkspaceResponse>(input)!,
  "CaptureScope" => JsonSerializer.Deserialize<CaptureScope>(input)!,
  "Money" => JsonSerializer.Deserialize<Money>(input)!,
  "Quantity" => JsonSerializer.Deserialize<Quantity>(input)!,
  "SourceDate" => JsonSerializer.Deserialize<SourceDate>(input)!,
  "ApiError" => JsonSerializer.Deserialize<ApiError>(input)!,
  "BridgeRequest" => JsonSerializer.Deserialize<BridgeRequest>(input)!,
  "ProjectCreateRequest" => JsonSerializer.Deserialize<ProjectCreateRequest>(input)!,
  "SiteFolderBindingRequest" => JsonSerializer.Deserialize<SiteFolderBindingRequest>(input)!,
  "SiteFolderBindingResponse" => JsonSerializer.Deserialize<SiteFolderBindingResponse>(input)!,
  _ => throw new InvalidOperationException("Unknown fixture type")
 };
 Console.WriteLine(JsonSerializer.Serialize(new {name,value}));
}
