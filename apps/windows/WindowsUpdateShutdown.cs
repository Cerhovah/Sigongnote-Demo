using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Sigongnote.Windows;

internal static class WindowsUpdateShutdown
{
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess { public int ProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME StartTime; }
    [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] private static extern int RmStartSession(out uint handle,int flags,StringBuilder key);
    [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] private static extern int RmRegisterResources(uint handle,uint files,string[]? names,uint applications,UniqueProcess[] processes,uint services,string[]? serviceNames);
    [DllImport("rstrtmgr.dll")] private static extern int RmShutdown(uint handle,uint flags,IntPtr callback);
    [DllImport("rstrtmgr.dll")] private static extern int RmEndSession(uint handle);

    internal static bool IsApplication(Process process,int currentId,int sessionId)
    {
        try { return process.Id!=currentId&&process.SessionId==sessionId&&process.ProcessName=="Sigongnote.Windows"&&Path.GetFileName(process.MainModule?.FileName)=="Sigongnote.Windows.exe"; }
        catch(Exception error) when(error is System.ComponentModel.Win32Exception or InvalidOperationException) {return false;}
    }

    internal static void StopRunningCopies()
    {
        using var current=Process.GetCurrentProcess();
        var candidates=Process.GetProcessesByName("Sigongnote.Windows");
        try {
            var applications=candidates.Where(p=>IsApplication(p,current.Id,current.SessionId)).ToArray();
            if(applications.Length==0){StopPreviousCollector();return;}
            var signaled=false;
            try { using var signal=EventWaitHandle.OpenExisting(@"Local\Sigongnote.Windows.ShutdownForUpdate");signal.Set();signaled=true; }
            catch(WaitHandleCannotBeOpenedException) { /* Older releases use Restart Manager below. */ }
            var wait=Stopwatch.StartNew();
            while(signaled&&wait.Elapsed<TimeSpan.FromSeconds(8)&&applications.Any(p=>!p.HasExited))Thread.Sleep(100);
            StopApplications(applications.Where(p=>!p.HasExited).ToArray());
            StopPreviousCollector();
        } finally {foreach(var process in candidates)process.Dispose();}
    }

    internal static void StopApplications(Process[] applications)
    {
        if(applications.Length==0)return;
        var unique=applications.Select(p=>{var started=p.StartTime.ToUniversalTime().ToFileTimeUtc();return new UniqueProcess {ProcessId=p.Id,StartTime=new(){dwLowDateTime=unchecked((int)started),dwHighDateTime=unchecked((int)(started>>32))}};}).ToArray();
        var status=RmStartSession(out var handle,0,new StringBuilder(33));
        if(status!=0)throw new IOException("Could not start application update shutdown");
        try {
            if(RmRegisterResources(handle,0,null,(uint)unique.Length,unique,0,null)!=0)throw new IOException("Could not register old application");
            // The exact process identities (including start times) prevent touching unrelated applications.
            status=RmShutdown(handle,0,IntPtr.Zero);
            if(status!=0)status=RmShutdown(handle,1,IntPtr.Zero);
            if(status!=0)throw new IOException("Old application did not stop");
            foreach(var application in applications)if(!application.WaitForExit(5000))throw new IOException("Old application is still running");
        } finally {RmEndSession(handle);}
    }

    private static void StopPreviousCollector()
    {
        var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Sigongnote","local-agent");
        try {
            using var launch=System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(root,"launch.json")));
            if(!WindowsLocalAgentHost.TryLaunchUri(launch.RootElement.GetProperty("url").GetString(),out _))return;
            var id=launch.RootElement.GetProperty("pid").GetInt32();
            using var process=Process.GetProcessById(id);
            var filename=process.MainModule?.FileName;
            if(process.ProcessName!="node"||filename is null||!filename.EndsWith(Path.Combine("local-agent","node.exe"),StringComparison.OrdinalIgnoreCase))return;
            File.WriteAllText(Path.Combine(root,"stop-request"),id.ToString(System.Globalization.CultureInfo.InvariantCulture));
            process.WaitForExit(5000);
        }catch(Exception error) when(error is IOException or ArgumentException or InvalidOperationException or System.Text.Json.JsonException or System.ComponentModel.Win32Exception or KeyNotFoundException) { /* An exited collector has no work left to stop. */ }
    }
}
