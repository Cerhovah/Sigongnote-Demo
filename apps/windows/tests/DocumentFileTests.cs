using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;
[TestClass] public sealed class DocumentFileTests {
 [TestMethod] public void RejectsTraversalTamperAndExecutable(){
  var bytes=Encoding.UTF8.GetBytes("%PDF synthetic");var hash=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
  string Payload(string name,string sha)=>JsonSerializer.Serialize(new{name,sha256=sha,base64=Convert.ToBase64String(bytes)});
  Assert.AreEqual("합성.pdf",WindowsDocumentFile.Decode(Payload("합성.pdf",hash),"pdf").Name);
  Assert.ThrowsExactly<InvalidDataException>(()=>WindowsDocumentFile.Decode(Payload("../outside.pdf",hash),"pdf"));
  Assert.ThrowsExactly<InvalidDataException>(()=>WindowsDocumentFile.Decode(Payload("합성.pdf",new string('0',64)),"pdf"));
  Assert.ThrowsExactly<InvalidDataException>(()=>WindowsDocumentFile.Decode(Payload("합성.exe",hash),"pdf"));
 }
 [TestMethod] public void ShareRoutesRejectUnverifiedDeliveryAndUrl(){
  var id=Guid.NewGuid().ToString();
  using var doc=JsonDocument.Parse(JsonSerializer.Serialize(new{route="documents.shareOutcome",id,intent_id=id,client_command_id=id,outcome="provider_confirmed"}));
  Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(doc.RootElement));
  using var valid=JsonDocument.Parse(JsonSerializer.Serialize(new{route="documents.file",id,format="pdf",action="share"}));
  Assert.AreEqual($"v1/documents/{id}/files/pdf",WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(valid.RootElement)));
 }
}
