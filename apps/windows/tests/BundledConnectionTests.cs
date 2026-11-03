using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class BundledConnectionTests
{
    [TestMethod]
    public void FreshInstallUsesBundleButUserSettingOrInvalidSettingNeverChangesHost()
    {
        var root=Path.Combine(Path.GetTempPath(),"sigongnote-bundle-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var user=Path.Combine(root,"user.json");var bundle=Path.Combine(root,"connection.json");
        var config=new WindowsConnectionOptions("https://api.example.invalid",
            "https://auth.example.invalid","sb_publishable_fixture_public_key_only",true);
        try {
            File.WriteAllText(bundle,JsonSerializer.Serialize(config,new JsonSerializerOptions(JsonSerializerDefaults.Web)));
            Assert.AreEqual(config,WindowsConnectionSettings.Read(user,bundle));
            Assert.IsTrue(File.Exists(user));
            File.WriteAllText(bundle,JsonSerializer.Serialize(config with {ApiBaseUrl="https://other.example.invalid"},
                new JsonSerializerOptions(JsonSerializerDefaults.Web)));
            Assert.AreEqual(config,WindowsConnectionSettings.Read(user,bundle));
            var chosen=config with {ApiBaseUrl="https://chosen.example.invalid"};
            File.WriteAllText(user,JsonSerializer.Serialize(chosen,new JsonSerializerOptions(JsonSerializerDefaults.Web)));
            Assert.AreEqual(chosen,WindowsConnectionSettings.Read(user,bundle));
            File.WriteAllText(user,"invalid");
            Assert.IsNull(WindowsConnectionSettings.Read(user,bundle));
            File.Delete(user);
            File.WriteAllText(Path.Combine(root,"session.protected"),"fixture");
            Assert.IsNull(WindowsConnectionSettings.Read(user,bundle));
            Assert.IsFalse(File.Exists(user));
        } finally {Directory.Delete(root,true);}
    }
}
