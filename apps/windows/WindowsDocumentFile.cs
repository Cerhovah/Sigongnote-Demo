using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace Sigongnote.Windows;

public static class WindowsDocumentFile
{
    public static (string Name,byte[] Bytes,string Hash) Decode(string json,string format)
    {
        using var data=JsonDocument.Parse(json);var root=data.RootElement;
        var name=root.GetProperty("name").GetString()!;var hash=root.GetProperty("sha256").GetString()!;
        if(name.Length>160||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0||Path.GetFileName(name)!=name||!name.EndsWith("."+format,StringComparison.Ordinal)||format is not ("pdf" or "xlsx"))throw new InvalidDataException();
        var bytes=Convert.FromBase64String(root.GetProperty("base64").GetString()!);
        if(bytes.Length is <4 or >5242880||Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()!=hash||!(format=="pdf"?bytes.AsSpan().StartsWith("%PDF"u8):bytes.AsSpan().StartsWith("PK"u8)))throw new InvalidDataException();
        return(name,bytes,hash);
    }
    public static async Task<string> Prepare(string json,string format,string scope,CancellationToken token=default)
    {
        var file=Decode(json,format);var key=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scope)));
        var folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Sigongnote","outgoing",key,file.Hash);
        Directory.CreateDirectory(folder);
        for(var cursor=new DirectoryInfo(folder);cursor is not null;cursor=cursor.Parent)if(cursor.Attributes.HasFlag(FileAttributes.ReparsePoint))throw new IOException();
        var target=Path.Combine(folder,file.Name);
        if(File.Exists(target)){if(File.GetAttributes(target).HasFlag(FileAttributes.ReparsePoint)||Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(target,token))).ToLowerInvariant()!=file.Hash)throw new IOException();return target;}
        var temp=Path.Combine(folder,Guid.NewGuid()+".tmp");
        try{await File.WriteAllBytesAsync(temp,file.Bytes,token);File.Move(temp,target,false);}finally{if(File.Exists(temp))File.Delete(temp);}
        return target;
    }
}
