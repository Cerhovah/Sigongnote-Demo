using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace Sigongnote.Windows;

/// <summary>Detects an embedded origin mark even when a generated workbook is copied or edited.</summary>
public static class WindowsGeneratedWorkbook
{
    public static bool IsGenerated(string path)
    {
        if (!File.Exists(path)) return false;
        try {
            using var file = new FileStream(path,FileMode.Open,FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var archive = new ZipArchive(file,ZipArchiveMode.Read,leaveOpen:false);
            var entry = archive.GetEntry("docProps/custom.xml");
            if (entry == null || entry.Length > 65536) return false;
            using var content = entry.Open();
            using var reader = XmlReader.Create(content,new XmlReaderSettings {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                MaxCharactersInDocument = 65536
            });
            var document = XDocument.Load(reader);
            var properties = document.Descendants().Where(element =>
                element.Name.LocalName == "property").ToDictionary(
                    element => (string?)element.Attribute("name") ?? "", element => element.Value,
                    StringComparer.Ordinal);
            return properties.GetValueOrDefault("sigongnote_generated") == "true" &&
                Guid.TryParse(properties.GetValueOrDefault("sigongnote_batch_id"),out _) &&
                properties.GetValueOrDefault("sigongnote_adapter_version") ==
                    "labor-ledger-v1/1.0.0";
        } catch (Exception error) when (error is IOException or InvalidDataException or
            XmlException or ArgumentException) {
            return false;
        }
    }
}

public static class WindowsGeneratedPacket
{
    public static bool IsGenerated(string path)
    {
        if (!File.Exists(path)) return false;
        try {
            // ReportLab writes Info keywords as plain ASCII. The mark survives a file move.
            // A derived edit retaining the mark is kept out of automatic cost capture.
            using (var file = File.OpenRead(path)) {
                var length = (int)Math.Min(file.Length,65536);
                file.Seek(-length,SeekOrigin.End);
                var bytes = new byte[length];
                file.ReadExactly(bytes);
                var ascii = Encoding.ASCII.GetString(bytes);
                if (System.Text.RegularExpressions.Regex.IsMatch(ascii,
                        @"sigongnote_generated=true;batch_id=[0-9a-f-]{36};audience=internal"))
                    return true;
            }
            if (!Path.GetFileName(path).Equals("internal-packet.pdf",
                    StringComparison.OrdinalIgnoreCase)) return false;
            var folder = Path.GetDirectoryName(path)!;
            var batch = Path.GetFileName(folder);
            if (!Guid.TryParse(batch,out _)) return false;
            var manifestPath = Path.Combine(folder,"manifest.json");
            using var manifest = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
            var root = manifest.RootElement;
            if (root.GetProperty("generated_by").GetString() != "sigongnote_export" ||
                root.GetProperty("batch_id").GetString() != batch) return false;
            var expected = root.GetProperty("pdf_sha256").GetString();
            using var stream = File.OpenRead(path);
            return expected == Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        } catch (Exception error) when (error is IOException or JsonException or
            KeyNotFoundException or InvalidOperationException) {
            return false;
        }
    }
}
