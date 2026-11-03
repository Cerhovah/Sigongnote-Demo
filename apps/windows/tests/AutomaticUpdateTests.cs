using System.Diagnostics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class AutomaticUpdateTests
{
    [TestMethod]
    public void RestartManagerStopsOnlyExplicitFixtureProcess()
    {
        using var unrelated=Process.Start(new ProcessStartInfo("ping.exe","-t 127.0.0.1"){CreateNoWindow=true,UseShellExecute=false,RedirectStandardOutput=true})!;
        using var target=Process.Start(new ProcessStartInfo("ping.exe","-t 127.0.0.1"){CreateNoWindow=true,UseShellExecute=false,RedirectStandardOutput=true})!;
        try {
            WindowsUpdateShutdown.StopApplications([target]);
            Assert.IsTrue(target.HasExited);
            Assert.IsFalse(unrelated.HasExited);
            using var current=Process.GetCurrentProcess();
            Assert.IsFalse(WindowsUpdateShutdown.IsApplication(current,current.Id,current.SessionId));
            Assert.IsFalse(WindowsUpdateShutdown.IsApplication(unrelated,current.Id,current.SessionId));
        }finally{if(!target.HasExited)target.Kill();if(!unrelated.HasExited)unrelated.Kill();}
    }
}
