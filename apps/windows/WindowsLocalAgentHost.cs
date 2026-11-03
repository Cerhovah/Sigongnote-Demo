using System.Diagnostics;
using System.Text.Json;
using System.Net;
using System.Net.Sockets;

namespace Sigongnote.Windows;

/// <summary>Runs the packaged local collector without requiring Node, Python, or an account setup.</summary>
public sealed class WindowsLocalAgentHost : IDisposable
{
    private readonly string packageRoot;
    private readonly string dataRoot;
    private Process? process;
    private Task<Uri?>? startup;
    private readonly Func<IEnumerable<string>>? extraDiscoveryRoots;
    public WindowsLocalAgentHost(string? packageRoot=null,string? dataRoot=null,Func<IEnumerable<string>>? extraDiscoveryRoots=null)
    {
        this.extraDiscoveryRoots=extraDiscoveryRoots;
        this.packageRoot=packageRoot??AppContext.BaseDirectory;
        this.dataRoot=dataRoot??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Sigongnote","local-agent");
    }
    public Task<Uri?> StartAsync()
    {
        if(startup is {IsCompletedSuccessfully:true}&&startup.Result is null){process?.Dispose();process=null;startup=null;}
        return startup??=StartCoreAsync();
    }
    private async Task<Uri?> StartCoreAsync()
    {
        var node=Path.Combine(packageRoot,"local-agent","node.exe");
        var entry=Path.Combine(packageRoot,"local-agent","main.mjs");
        if(!File.Exists(node)||!File.Exists(entry))return null;
        try {
            Directory.CreateDirectory(dataRoot);
            if(await ExistingAsync() is { } existing)return existing;
            await StopPreviousAsync();
            var start=new ProcessStartInfo(node){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=packageRoot,RedirectStandardOutput=true,RedirectStandardError=true};
            start.ArgumentList.Add(entry);
            start.Environment["SIGONGNOTE_REPO"]=packageRoot;
            start.Environment["SIGONGNOTE_LOCAL_DATA"]=dataRoot;
            start.Environment["SIGONGNOTE_LOCAL_PORT"]=AvailablePort().ToString(System.Globalization.CultureInfo.InvariantCulture);
            start.Environment["SIGONGNOTE_WEB_DIR"]=Path.Combine(packageRoot,"work-ui");
            start.Environment["SIGONGNOTE_PYTHON"]=Path.Combine(packageRoot,"local-agent","python","python.exe");
            start.Environment["SIGONGNOTE_WINDOWS_HELPER"]=Path.Combine(packageRoot,"Sigongnote.Windows.exe");
            if(extraDiscoveryRoots is not null)start.Environment["SIGONGNOTE_EXTRA_DISCOVERY_ROOTS"]=string.Join(Path.PathSeparator,extraDiscoveryRoots());
            start.Environment["SIGONGNOTE_POWERSHELL"]=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
            // Readiness is taken from the protected launch file. Never persist parser output or local paths in logs.
            process=Process.Start(start);
            if(process is null)return null;
            process.OutputDataReceived+=(_,_)=>{};process.ErrorDataReceived+=(_,_)=>{};
            process.BeginOutputReadLine();process.BeginErrorReadLine();
            for(var attempt=0;attempt<100;attempt++) {
                if(await ExistingAsync() is { } ready)return ready;
                if(process.HasExited)return null;
                await Task.Delay(150);
            }
        } catch(Exception error) when(error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or InvalidOperationException or JsonException) { }
        return null;
    }
    private async Task<Uri?> ExistingAsync()
    {
        try {
            using var launch=JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(dataRoot,"launch.json")));
            var address=launch.RootElement.GetProperty("url").GetString();
            if(!TryLaunchUri(address,out var uri))return null;
            using var running=Process.GetProcessById(launch.RootElement.GetProperty("pid").GetInt32());
            if(running.HasExited||!string.Equals(running.ProcessName,"node",StringComparison.OrdinalIgnoreCase))return null;
            using var client=new HttpClient{Timeout=TimeSpan.FromSeconds(1)};
            using var response=await client.GetAsync(new Uri(uri!,"/health/local"));
            if(!response.IsSuccessStatusCode)return null;
            using var health=JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            return health.RootElement.TryGetProperty("contract",out var contract)&&contract.GetInt32()==2 ? new UriBuilder(uri!){Query="work=local"}.Uri : null;
        }catch(Exception error) when(error is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException or ArgumentException or InvalidOperationException or HttpRequestException or TaskCanceledException){return null;}
    }
    private async Task StopPreviousAsync()
    {
        try{
            using var launch=JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(dataRoot,"launch.json")));
            if(!TryLaunchUri(launch.RootElement.GetProperty("url").GetString(),out _))return;
            var previousId=launch.RootElement.GetProperty("pid").GetInt32();
            using var previous=Process.GetProcessById(previousId);
            if(previous.HasExited||!string.Equals(previous.ProcessName,"node",StringComparison.OrdinalIgnoreCase))return;
            // The previous collector reads this marker itself; unrelated processes are never terminated.
            await File.WriteAllTextAsync(Path.Combine(dataRoot,"stop-request"),previousId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            for(var attempt=0;attempt<40&&!previous.HasExited;attempt++)await Task.Delay(100);
        }catch(Exception error) when(error is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException or ArgumentException or InvalidOperationException){ }
    }
    private static int AvailablePort()
    {
        TcpListener listener=new(IPAddress.Loopback,5174);
        try{listener.Start();return ((IPEndPoint)listener.LocalEndpoint).Port;}
        catch(SocketException){listener.Stop();listener=new TcpListener(IPAddress.Loopback,0);listener.Start();return ((IPEndPoint)listener.LocalEndpoint).Port;}
        finally{listener.Stop();}
    }
    internal static bool TryLaunchUri(string? address,out Uri? uri)
    {
        uri=null;
        if(!Uri.TryCreate(address,UriKind.Absolute,out var value)||value.Scheme!="http"||value.Host!="127.0.0.1"||value.Port<1024||value.Port>65535||value.AbsolutePath!="/"||value.UserInfo.Length!=0)return false;
        var token=value.Fragment.StartsWith("#pair=",StringComparison.Ordinal)?value.Fragment[6..]:"";
        if(token.Length!=64||!token.All(char.IsAsciiHexDigit))return false;
        uri=value;return true;
    }
    public void Dispose()
    {
        if(process is null)return;
        try{if(!process.HasExited)File.WriteAllText(Path.Combine(dataRoot,"stop-request"),process.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));}catch(IOException){}catch(InvalidOperationException){}
        process.Dispose();
    }
}
