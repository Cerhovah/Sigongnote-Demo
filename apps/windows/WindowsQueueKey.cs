using System.Security.Cryptography;

namespace Sigongnote.Windows;

/// <summary>A stable local encryption key; only its DPAPI-wrapped form touches disk.</summary>
public sealed class WindowsQueueKey
{
    private readonly string path;
    private readonly WindowsSecretStore secrets;

    public WindowsQueueKey(string path, WindowsSecretStore? secrets = null)
    {
        this.path = Path.GetFullPath(path);
        this.secrets = secrets ?? new WindowsSecretStore();
        Directory.CreateDirectory(Path.GetDirectoryName(this.path)!);
    }

    public byte[] GetOrCreate(Action? onUnrecoverable = null)
    {
        if (File.Exists(path)) {
            try { return Read(); }
            catch (CryptographicException) {
                onUnrecoverable?.Invoke();
                var backup = path + ".unrecoverable-" + DateTimeOffset.UtcNow.ToString(
                    "yyyyMMddTHHmmssfff") + "-" + Guid.NewGuid().ToString("N");
                File.Move(path,backup);
            }
        }
        var key = RandomNumberGenerator.GetBytes(32);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".new";
        try {
            File.WriteAllBytes(temporary,secrets.ProtectBytes(key));
            try { File.Move(temporary,path); }
            catch (IOException) when (File.Exists(path)) {
                CryptographicOperations.ZeroMemory(key);
                return Read();
            }
            return key;
        } finally {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private byte[] Read()
    {
        var key = secrets.UnprotectBytes(File.ReadAllBytes(path));
        if (key.Length != 32) throw new CryptographicException("Invalid queue key");
        return key;
    }
}
