using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class GeneratedArtifactTests
{
    [TestMethod, TestCategory("C37")]
    public void GeneratedWorkbookCopyAndBatchPdfAreExcluded()
    {
        var root = Path.Combine(Path.GetTempPath(),"sigongnote-c37-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var batch = Guid.NewGuid().ToString("D");
            var workbook = Path.Combine(root,"copied.xlsx");
            using (var archive = ZipFile.Open(workbook,ZipArchiveMode.Create)) {
                var entry = archive.CreateEntry("docProps/custom.xml");
                using var writer = new StreamWriter(entry.Open());
                writer.Write($"""
                    <Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
                      <property name="sigongnote_generated"><vt:lpwstr>true</vt:lpwstr></property>
                      <property name="sigongnote_batch_id"><vt:lpwstr>{batch}</vt:lpwstr></property>
                      <property name="sigongnote_adapter_version"><vt:lpwstr>labor-ledger-v1/1.0.0</vt:lpwstr></property>
                    </Properties>
                    """);
            }
            Assert.IsFalse(WindowsFolderPolicy.Supported(workbook));
            var folder = Path.Combine(root,batch);
            Directory.CreateDirectory(folder);
            var packet = Path.Combine(folder,"internal-packet.pdf");
            var bytes = Encoding.UTF8.GetBytes("synthetic packet");
            File.WriteAllBytes(packet,bytes);
            File.WriteAllText(Path.Combine(folder,"manifest.json"),JsonSerializer.Serialize(new {
                generated_by = "sigongnote_export", batch_id = batch,
                pdf_sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()
            }));
            Assert.IsFalse(WindowsFolderPolicy.Supported(packet));
            var copied = Path.Combine(root,"shared-copy.pdf");
            File.WriteAllText(copied,$"%PDF-1.4\n/Keywords (sigongnote_generated=true;batch_id={batch};audience=internal)\n");
            Assert.IsFalse(WindowsFolderPolicy.Supported(copied));
            File.WriteAllText(packet,"edited packet");
            Assert.IsTrue(WindowsFolderPolicy.Supported(packet));
        } finally { Directory.Delete(root,true); }
    }
}
