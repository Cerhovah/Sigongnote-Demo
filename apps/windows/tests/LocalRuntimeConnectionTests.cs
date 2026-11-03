using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class LocalRuntimeConnectionTests
{
    [TestMethod]
    public void LocalLaunchRequiresFixedLoopbackAndPairToken()
    {
        var token=new string('a',64);
        Assert.IsTrue(WindowsLocalAgentHost.TryLaunchUri("http://127.0.0.1:5174/#pair="+token,out _));
        Assert.IsTrue(WindowsLocalAgentHost.TryLaunchUri("http://127.0.0.1:5186/?work=local#pair="+token,out _));
        foreach(var address in new[]{"http://example.com:5174/#pair="+token,"http://127.0.0.1:80/#pair="+token,"http://127.0.0.1:5174/#pair=short","http://127.0.0.1:5174/other#pair="+token})Assert.IsFalse(WindowsLocalAgentHost.TryLaunchUri(address,out _));
    }
    [TestMethod]
    public void SignedStorageUploadsAreAllowedOnlyForConfiguredOriginalBucket()
    {
        const string origin="https://project.supabase.co";
        Assert.IsTrue(WindowsWorkNetwork.SignedUpload(origin+"/storage/v1/object/upload/sign/sigongnote-originals/company/document?token=signed",origin));
        Assert.IsFalse(WindowsWorkNetwork.SignedUpload("https://other.supabase.co/storage/v1/object/upload/sign/sigongnote-originals/file",origin));
        Assert.IsFalse(WindowsWorkNetwork.SignedUpload(origin+"/storage/v1/object/upload/sign/other/file",origin));
        Assert.IsFalse(WindowsWorkNetwork.SignedUpload(origin+"/rest/v1/private",origin));
        Assert.IsFalse(WindowsWorkNetwork.SignedUpload(origin+"/storage/v1/object/upload/sign/sigongnote-originals/file",null));
    }
}
