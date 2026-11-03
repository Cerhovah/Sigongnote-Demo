using System.Security.Cryptography;
using System.Text;

namespace Sigongnote.Windows;

/// <summary>Secrets and folder roots are scoped to the interactive Windows user.</summary>
public sealed class WindowsSecretStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("sigongnote.windows.v1");

    public byte[] Protect(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        return ProtectBytes(Encoding.UTF8.GetBytes(value));
    }

    public string Unprotect(byte[] protectedValue) => Encoding.UTF8.GetString(UnprotectBytes(protectedValue));

    public byte[] ProtectBytes(byte[] value) => ProtectedData.Protect(value,Entropy,
        DataProtectionScope.CurrentUser);

    public byte[] UnprotectBytes(byte[] protectedValue) => ProtectedData.Unprotect(
        protectedValue,Entropy,DataProtectionScope.CurrentUser);
}
