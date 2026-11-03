using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;
[TestClass]
public sealed class EvidenceWorkApiTests
{
    [TestMethod]
    public void EvidencePagesUseFixedReadPathAndBoundedOpaqueCursor(){
        var id=Guid.NewGuid().ToString();
        using var valid=JsonDocument.Parse(JsonSerializer.Serialize(new{route="evidence.chunks",id,cursor="abc_123-"}));
        var request=WindowsWorkRoutes.Decode(valid.RootElement);
        Assert.AreEqual($"v1/evidence/{id}/chunks?cursor=abc_123-",WindowsWorkRoutes.Path(request));
        Assert.IsNull(WindowsWorkRoutes.Body(request));
        foreach(var cursor in new[]{new string('x',241),"../../secret",""}){
            using var invalid=JsonDocument.Parse(JsonSerializer.Serialize(new{route="evidence.chunks",id,cursor}));
            Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(invalid.RootElement));
        }
        using var forged=JsonDocument.Parse(JsonSerializer.Serialize(new{route="evidence.chunks",id,tenant_id="other"}));
        Assert.ThrowsExactly<JsonException>(()=>WindowsWorkRoutes.Decode(forged.RootElement));
    }
}
