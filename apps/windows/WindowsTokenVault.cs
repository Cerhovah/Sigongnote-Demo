using System.Security.Cryptography;

namespace Sigongnote.Windows;

/// <summary>Only encrypted bytes are persisted; logout removes the local session.</summary>
public sealed class WindowsTokenVault
{
    private static readonly object Gate=new();
    private readonly string path;
    private readonly WindowsSecretStore secrets;

    public WindowsTokenVault(string path, WindowsSecretStore? secrets = null)
    {
        this.path = Path.GetFullPath(path);
        this.secrets = secrets ?? new WindowsSecretStore();
        Directory.CreateDirectory(Path.GetDirectoryName(this.path)!);
    }

    public void Save(string session)
    {
        lock(Gate) {
        var temporary = path + ".new";
        try {
            File.WriteAllBytes(temporary,secrets.Protect(session));
            File.Move(temporary,path,true);
        } finally {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
        }
    }

    public string? Read()
    {
        lock(Gate) {
        if (!File.Exists(path)) return null;
        try { return secrets.Unprotect(File.ReadAllBytes(path)); }
        catch (CryptographicException) {
            var backup = path + ".unrecoverable-" + DateTimeOffset.UtcNow.ToString(
                "yyyyMMddTHHmmssfff") + "-" + Guid.NewGuid().ToString("N");
            File.Move(path,backup);
            return null;
        }
        }
    }

    public bool ReplaceIfUnchanged(string expected,string replacement) {lock(Gate) {if(Read()!=expected)return false;Save(replacement);return true;}}

    public void Clear()
    {
        lock(Gate) {if (File.Exists(path)) File.Delete(path); }
    }
}
