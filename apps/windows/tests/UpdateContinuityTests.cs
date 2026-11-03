using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;
[TestClass] public sealed class UpdateContinuityTests {
 [TestMethod] public void SameServiceUpdateRefreshesProvidersWithoutTouchingAccountOrQueue(){
  var root=Path.Combine(Path.GetTempPath(),"sigongnote-update-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try {
   var state=Path.Combine(root,"state");Directory.CreateDirectory(state);var user=Path.Combine(state,"connection.json");var bundle=Path.Combine(root,"connection.json");
   var old=new WindowsConnectionOptions("https://api.example.invalid/","https://auth.example.invalid/","sb_publishable_fixture",true);
   var json=new JsonSerializerOptions(JsonSerializerDefaults.Web);File.WriteAllText(user,JsonSerializer.Serialize(old,json));
   foreach(var name in new[]{"capture-state.db","session.protected","queue-key.protected"})File.WriteAllText(Path.Combine(state,name),"preserved-fixture");
   var next=old with {NaverEnabled=true,KakaoEnabled=true};File.WriteAllText(bundle,JsonSerializer.Serialize(next,json));
   Assert.AreEqual(next,WindowsConnectionSettings.Read(user,bundle));
   foreach(var name in new[]{"capture-state.db","session.protected","queue-key.protected"})Assert.AreEqual("preserved-fixture",File.ReadAllText(Path.Combine(state,name)));
   File.WriteAllText(bundle,JsonSerializer.Serialize(old,json));File.SetAttributes(user,FileAttributes.ReadOnly);
   try {Assert.AreEqual(next,WindowsConnectionSettings.Read(user,bundle));}finally{File.SetAttributes(user,FileAttributes.Normal);}
   File.WriteAllText(bundle,JsonSerializer.Serialize(next with {SupabaseOrigin="https://other.example.invalid/"},json));Assert.AreEqual(next,WindowsConnectionSettings.Read(user,bundle));
  }finally{Directory.Delete(root,true);}
 }
}
