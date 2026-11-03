using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Sigongnote.Windows;

public sealed class WindowsInventoryLimitException : IOException;

public static class WindowsFolderPolicy
{
    public const int MaximumCandidates = 2_000;
    public const int MaximumEnumeratedFiles = 20_000;
    private static readonly HashSet<string> Extensions = new(
        [".hwp",".hwpx",".xls",".xlsx",".pdf",".jpg",".jpeg",".png",
         ".heic",".heif",".webp",".bmp",".tif",".tiff",".gif",".txt",".csv",".tsv",".md",".rtf",
         ".doc",".docx",".ppt",".pptx",".odt",".ods",".odp",".json",".xml",
         ".mp3",".m4a",".wav",".aac",".ogg",".flac",".amr",".mp4",".mov",".avi",".mkv",".webm",".3gp"],
        StringComparer.OrdinalIgnoreCase);

    public static bool Supported(string path)
    {
        var name = Path.GetFileName(path);
        var extension = Path.GetExtension(path);
        return !name.StartsWith("~$",StringComparison.Ordinal) &&
            Extensions.Contains(extension) &&
            !(extension.Equals(".xlsx",StringComparison.OrdinalIgnoreCase) &&
                WindowsGeneratedWorkbook.IsGenerated(path)) &&
            !(extension.Equals(".pdf",StringComparison.OrdinalIgnoreCase) &&
                WindowsGeneratedPacket.IsGenerated(path));
    }

    public static string MetadataFingerprint(FileInfo file)
    {
        Span<byte> fields = stackalloc byte[16];
        BinaryPrimitives.WriteInt64LittleEndian(fields[..8],file.Length);
        BinaryPrimitives.WriteInt64LittleEndian(fields[8..],file.LastWriteTimeUtc.Ticks);
        return Convert.ToHexString(SHA256.HashData(fields));
    }

    public static EnumerationOptions Enumeration => new() {
        RecurseSubdirectories = true, IgnoreInaccessible = false,
        AttributesToSkip = FileAttributes.Hidden | FileAttributes.System |
            FileAttributes.ReparsePoint,
    };
}

public sealed record WindowsFolderScopePreview(int FileCount, long ByteCount,
    int ExcludedCount, DateTime CutoffUtc, IReadOnlyDictionary<string,int> Formats, bool Partial = false);

public static class WindowsFolderPreview
{
    public static WindowsFolderScopePreview Scan(string root, WindowsStateStore state,
        string sourceId, CancellationToken cancellation = default)
    {
        return Scan(root,state.ScopeBaseline(sourceId),cancellation);
    }
    public static WindowsFolderScopePreview Scan(string root,FolderScopeBaseline baseline,CancellationToken cancellation=default,Func<string,bool>? excludedPath=null)
    {
        var count = 0;
        var bytes = 0L;
        var excluded = 0;
        var visited = 0;
        var partial=false;
        var formats = new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);
        var pending=new Stack<(string Path,int Depth)>();pending.Push((root,0));
        while(pending.TryPop(out var directory)) {
            try {
                if(excludedPath?.Invoke(directory.Path)==true)continue;
                if(directory.Depth>32){partial=true;continue;}
                if(File.Exists(Path.Combine(directory.Path,"sigongnote-generated.json")))continue;
                foreach(var item in Directory.EnumerateFileSystemEntries(directory.Path,"*",new EnumerationOptions {
                    RecurseSubdirectories=false,IgnoreInaccessible=false,AttributesToSkip=FileAttributes.Hidden|FileAttributes.System|FileAttributes.ReparsePoint })) {
                    cancellation.ThrowIfCancellationRequested();
                    if(++visited>WindowsFolderPolicy.MaximumEnumeratedFiles || count>=WindowsFolderPolicy.MaximumCandidates) {
                        partial=true;pending.Clear();break;
                    }
                    if(Directory.Exists(item)){pending.Push((item,directory.Depth+1));continue;}
                    if(excludedPath?.Invoke(item)==true){excluded++;continue;}
                    var file=new FileInfo(item);
                    if((file.LastWriteTimeUtc<baseline.CutoffUtc && (baseline.Completed ?
                        (file.CreationTimeUtc<baseline.StartedUtc && baseline.ExcludedFingerprints.Contains(WindowsFolderPolicy.MetadataFingerprint(file))) : file.CreationTimeUtc<baseline.StartedUtc)) ||
                        !WindowsFolderPolicy.Supported(item)) { excluded++;continue; }
                    count++;bytes=checked(bytes+file.Length);
                    var extension=file.Extension.ToLowerInvariant();formats[extension]=formats.GetValueOrDefault(extension)+1;
                }
            } catch(Exception error) when(error is IOException or UnauthorizedAccessException) { partial=true; }
        }
        return new WindowsFolderScopePreview(count,bytes,excluded,baseline.CutoffUtc,formats,partial);
    }
}
