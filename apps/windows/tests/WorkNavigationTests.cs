using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class WorkNavigationTests
{
    [TestMethod]
    public void BundledRoutesAndNativeActionsRemainDistinct()
    {
        Assert.AreEqual(WindowsWorkDestination.Page,WindowsWorkNavigation.Classify(WindowsWorkForm.Origin+"/index.html#/more/privacy"));
        Assert.AreEqual(WindowsWorkDestination.Login,WindowsWorkNavigation.Classify(WindowsWorkForm.Origin+"/login"));
        Assert.AreEqual(WindowsWorkDestination.LinkAccount,WindowsWorkNavigation.Classify(WindowsWorkForm.Origin+"/link-account"));
        Assert.AreEqual(WindowsWorkDestination.Settings,WindowsWorkNavigation.Classify(WindowsWorkForm.Origin+"/settings"));
        Assert.AreEqual(WindowsWorkDestination.SetupFolder,WindowsWorkNavigation.Classify(WindowsWorkForm.Origin+"/setup-folder"));
        Assert.AreEqual(WindowsWorkDestination.SetupRecording,WindowsWorkNavigation.Classify(WindowsWorkForm.Origin+"/setup-recording"));
        Assert.AreEqual(WindowsWorkDestination.Logout,WindowsWorkNavigation.Classify(WindowsWorkForm.Origin+"/logout"));
        Assert.AreEqual(WindowsWorkDestination.PublicSetup,WindowsWorkNavigation.Classify("https://sigongnote-api.onrender.com/install"));
        Assert.AreEqual(WindowsWorkDestination.PublicSetup,WindowsWorkNavigation.Classify("https://sigongnote-api.onrender.com/#/setup"));
    }
    [TestMethod]
    [DataRow("https://sigongnote.work.evil.test/login")]
    [DataRow("https://sigongnote.work@evil.test/login")]
    [DataRow("http://sigongnote.work/login")]
    [DataRow("https://sigongnote.work/login?return=https://evil.test")]
    [DataRow("https://sigongnote.work/settings#logout")]
    [DataRow("https://sigongnote.work/setup-folder?project=other")]
    [DataRow("https://sigongnote.work/setup-recording?root=other")]
    [DataRow("https://sigongnote.work/index.html?script=bad")]
    [DataRow("file:///index.html")]
    [DataRow("https://sigongnote-api.onrender.com/install?token=secret")]
    [DataRow("https://sigongnote-api.onrender.com.evil.test/install")]
    [DataRow("http://sigongnote-api.onrender.com/install")]
    [DataRow(null)]
    public void ArbitraryOriginsAndParametersCannotTriggerNativeActions(string? address)
        =>Assert.AreEqual(WindowsWorkDestination.Blocked,WindowsWorkNavigation.Classify(address));
}
