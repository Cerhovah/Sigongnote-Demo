using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Sigongnote.Windows;

public sealed record WindowsVolumeIdentity(string VolumeId, string Serial,
    string MountRoot, string RelativePath)
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetVolumeNameForVolumeMountPointW",
        SetLastError = true)]
    private static extern bool GetVolumeNameForVolumeMountPoint(string mountPoint,
        StringBuilder volumeName, uint bufferLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetVolumePathNameW",
        SetLastError = true)]
    private static extern bool GetVolumePathName(string path, StringBuilder mountPoint,
        uint bufferLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode,
        EntryPoint = "GetVolumePathNamesForVolumeNameW", SetLastError = true)]
    private static extern bool GetVolumePathNamesForVolumeName(string volumeName,
        [Out] char[] mountPaths, uint bufferLength, out uint requiredLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetVolumeInformationW",
        SetLastError = true)]
    private static extern bool GetVolumeInformation(string rootPath,
        StringBuilder? volumeName, uint volumeNameSize, out uint serial,
        out uint maximumComponentLength, out uint fileSystemFlags,
        StringBuilder? fileSystemName, uint fileSystemNameSize);

    public static WindowsVolumeIdentity Probe(string folderPath)
    {
        var fullPath = Path.GetFullPath(folderPath);
        if (!Directory.Exists(fullPath))
            throw new DirectoryNotFoundException();
        var mountPath = new StringBuilder(32768);
        if (!GetVolumePathName(fullPath,mountPath,(uint)mountPath.Capacity))
            throw new Win32Exception(Marshal.GetLastWin32Error(),"Volume mount unavailable");
        var mount = mountPath.ToString();
        var volumeName = new StringBuilder(64);
        if (!GetVolumeNameForVolumeMountPoint(mount,volumeName,(uint)volumeName.Capacity))
            throw new Win32Exception(Marshal.GetLastWin32Error(),"Volume ID unavailable");
        if (!GetVolumeInformation(mount,null,0,out var serial,out _,out _,null,0))
            throw new Win32Exception(Marshal.GetLastWin32Error(),"Volume serial unavailable");
        var relative = Path.GetRelativePath(mount,fullPath);
        if (Path.IsPathRooted(relative) || relative == ".." ||
            relative.StartsWith(".." + Path.DirectorySeparatorChar,StringComparison.Ordinal))
            throw new IOException("Folder outside volume");
        return new WindowsVolumeIdentity(volumeName.ToString(),
            serial.ToString("X8"),mount,relative);
    }

    public bool SameSource(WindowsVolumeIdentity other) =>
        string.Equals(VolumeId,other.VolumeId,StringComparison.OrdinalIgnoreCase) &&
        string.Equals(Serial,other.Serial,StringComparison.OrdinalIgnoreCase) &&
        string.Equals(RelativePath,other.RelativePath,StringComparison.OrdinalIgnoreCase);

    public string? FindCurrentPath()
    {
        // The Win32 API requires the literal "Volume" prefix casing. C15a stored
        // uppercase names, so normalize those without changing source identity.
        var volumeName = VolumeId.StartsWith(@"\\?\VOLUME{",StringComparison.OrdinalIgnoreCase)
            ? @"\\?\Volume{" + VolumeId[@"\\?\VOLUME{".Length..]
            : VolumeId;
        var buffer = new char[512];
        if (!GetVolumePathNamesForVolumeName(volumeName,buffer,(uint)buffer.Length,
                out var required)) {
            if (Marshal.GetLastWin32Error() != 234 || required == 0 || required > 32768)
                return null;
            buffer = new char[checked((int)required)];
            if (!GetVolumePathNamesForVolumeName(volumeName,buffer,(uint)buffer.Length,
                    out required)) return null;
        }
        foreach (var mount in new string(buffer).Split('\0',StringSplitOptions.RemoveEmptyEntries)) {
            try {
                var candidate = Path.GetFullPath(Path.Combine(mount,RelativePath));
                if (!Directory.Exists(candidate)) continue;
                var found = Probe(candidate);
                if (SameSource(found)) return candidate;
            } catch (Exception error) when (error is IOException or UnauthorizedAccessException or
                Win32Exception) { /* Disconnected and inaccessible volumes are not deletions. */ }
        }
        return null;
    }
}
