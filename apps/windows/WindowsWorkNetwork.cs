namespace Sigongnote.Windows;

internal static class WindowsWorkNetwork
{
    internal static bool SignedUpload(string address,string? configuredOrigin)
    {
        if(!Uri.TryCreate(configuredOrigin,UriKind.Absolute,out var expected)||!Uri.TryCreate(address,UriKind.Absolute,out var uri))return false;
        return uri.Scheme=="https"&&uri.Scheme==expected.Scheme&&uri.Host==expected.Host&&uri.Port==expected.Port&&uri.UserInfo.Length==0&&uri.AbsolutePath.StartsWith("/storage/v1/object/upload/sign/sigongnote-originals/",StringComparison.Ordinal);
    }
}
