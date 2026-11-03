using System.Text.Json;

namespace Sigongnote.Windows;

/// <summary>Public service endpoints and publishable key; tokens stay in DPAPI vaults.</summary>
public static class WindowsConnectionSettings
{
    public static string DefaultPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Sigongnote","connection.json");

    public static WindowsConnectionOptions? Read(string? path = null, string? bundledPath = null)
    {
        path ??= DefaultPath;
        try {
            // Pin bundled endpoints before any state/session is created. A missing
            // user file on an existing installation is not permission to switch hosts.
            if (!File.Exists(path)) {
                var root=Path.GetDirectoryName(Path.GetFullPath(path))!;
                if (Directory.Exists(root) && Directory.EnumerateFiles(root).Any(file =>
                    Path.GetFileName(file).StartsWith("capture-state.db",StringComparison.OrdinalIgnoreCase) ||
                    Path.GetFileName(file).StartsWith("session.protected",StringComparison.OrdinalIgnoreCase) ||
                    Path.GetFileName(file).StartsWith("pending-session.protected",StringComparison.OrdinalIgnoreCase)))
                    return null;
                bundledPath ??= Path.Combine(AppContext.BaseDirectory,"connection.json");
                if (!File.Exists(bundledPath)) return null;
                var raw=File.ReadAllText(bundledPath);
                var bundled=JsonSerializer.Deserialize<WindowsConnectionOptions>(raw,
                    new JsonSerializerOptions(JsonSerializerDefaults.Web));
                if (bundled?.Validate() is null) return null;
                Directory.CreateDirectory(root);
                var temporary=Path.Combine(root,Guid.NewGuid().ToString("N")+".connection.tmp");
                try {
                    File.WriteAllText(temporary,raw);
                    try {File.Move(temporary,path,false);}
                    catch(IOException) when(File.Exists(path)) { /* Another startup pinned first. */ }
                } finally {if(File.Exists(temporary))File.Delete(temporary);}
            }
            var options = JsonSerializer.Deserialize<WindowsConnectionOptions>(
                File.ReadAllText(path),new JsonSerializerOptions(JsonSerializerDefaults.Web));
            options=options?.Validate();
            bundledPath ??= Path.Combine(AppContext.BaseDirectory,"connection.json");
            if(options is not null && File.Exists(bundledPath)) {
                WindowsConnectionOptions? next=null;
                try { next=JsonSerializer.Deserialize<WindowsConnectionOptions>(File.ReadAllText(bundledPath),new JsonSerializerOptions(JsonSerializerDefaults.Web))?.Validate(); }
                catch(Exception e) when(e is JsonException or InvalidOperationException or ArgumentException or IOException or UnauthorizedAccessException) { /* Keep the pinned configuration. */ }
                if(next is not null && next.ApiBaseUrl==options.ApiBaseUrl && next.SupabaseOrigin==options.SupabaseOrigin && next.PublishableKey==options.PublishableKey && next!=options) {
                    var temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
                    try { File.WriteAllText(temporary,JsonSerializer.Serialize(next,new JsonSerializerOptions(JsonSerializerDefaults.Web)));File.Move(temporary,path,true);options=next; }
                    catch(Exception e) when(e is IOException or UnauthorizedAccessException) { /* Optional provider refresh must not discard a usable account connection. */ }
                    finally {if(File.Exists(temporary))File.Delete(temporary);}
                }
            }
            return options;
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or
            InvalidOperationException or ArgumentException) {
            return null;
        }
    }
}
