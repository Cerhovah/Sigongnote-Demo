using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class FolderBatchTests
{
    private sealed class Fixture:IDisposable {
        public readonly string Root=Path.Combine(Path.GetTempPath(),"sigongnote-folder-batch-"+Guid.NewGuid().ToString("N"));
        public Fixture(){Directory.CreateDirectory(Root);}
        public string Child(string name){var path=Path.Combine(Root,name);Directory.CreateDirectory(path);return path;}
        public WindowsVolumeIdentity Identity(string path)=>new("test-volume","test-serial",Root,Path.GetRelativePath(Root,path));
        public void Dispose(){Assert.IsTrue(Path.GetFullPath(Root).StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase));Directory.Delete(Root,true);}
    }
    [TestMethod]
    public void ImmediateChildrenUseStableLocationAndNewFoldersAreFoundOnRescan(){
        using var fixture=new Fixture();var first=fixture.Child("가람 현장");fixture.Child("공통자료");
        Directory.CreateDirectory(Path.Combine(first,"같은 하위 이름"));
        var project=Guid.NewGuid();var projects=new[]{new WindowsProjectChoice(project.ToString(),"가람 현장")};
        var initial=WindowsFolderBatchDiscovery.Discover(fixture.Root,projects,[],fixture.Identity);
        Assert.HasCount(2,initial.Folders);Assert.IsFalse(initial.Folders.Any(folder=>folder.Path==fixture.Root));
        Assert.AreEqual("project",initial.Folders.Single(folder=>folder.Name=="가람 현장").Scope);
        Assert.AreEqual("company_common",initial.Folders.Single(folder=>folder.Name=="공통자료").Scope);
        fixture.Child("새로운 자료");var next=WindowsFolderBatchDiscovery.Discover(fixture.Root,projects,[],fixture.Identity);
        Assert.HasCount(3,next.Folders);Assert.AreEqual(initial.Folders[0].Key,next.Folders.Single(folder=>folder.Path==initial.Folders[0].Path).Key);
        Assert.AreEqual("unassigned",next.Folders.Single(folder=>folder.Name=="새로운 자료").Scope);
    }
    [TestMethod]
    public void DeniedChildrenDoNotBlockOthersAndAncestorCapturePreventsDuplicates(){
        using var fixture=new Fixture();fixture.Child("열림");var denied=fixture.Child("닫힘");
        var partial=WindowsFolderBatchDiscovery.Discover(fixture.Root,[],[],fixture.Identity,path=>{if(path==denied)throw new UnauthorizedAccessException();});
        Assert.IsTrue(partial.Partial);Assert.IsNull(partial.Folders.Single(folder=>folder.Name=="열림").Issue);
        Assert.AreEqual("permission_denied",partial.Folders.Single(folder=>folder.Name=="닫힘").Issue);
        var connected=new[]{new FolderConnection("existing",fixture.Root,"selected",DateTimeOffset.UtcNow)};
        var blocked=WindowsFolderBatchDiscovery.Discover(fixture.Root,[],connected,fixture.Identity);
        Assert.IsTrue(blocked.Folders.All(folder=>folder.Issue=="already_covered"));
    }
    [TestMethod]
    public void SameNamesAtDifferentLocationsStayDistinctAndAmbiguousProjectsStayUnassigned(){
        using var first=new Fixture();using var second=new Fixture();first.Child("같은 이름");second.Child("같은 이름");
        WindowsVolumeIdentity Identity(string path)=>new("volume","serial",Path.GetTempPath(),Path.GetRelativePath(Path.GetTempPath(),path));
        var projects=new[]{new WindowsProjectChoice(Guid.NewGuid().ToString(),"같은 이름"),new WindowsProjectChoice(Guid.NewGuid().ToString(),"같은 이름")};
        var a=WindowsFolderBatchDiscovery.Discover(first.Root,projects,[],Identity).Folders.Single();
        var b=WindowsFolderBatchDiscovery.Discover(second.Root,projects,[],Identity).Folders.Single();
        Assert.AreNotEqual(a.Key,b.Key);Assert.AreEqual("unassigned",a.Scope);
        Assert.IsFalse(WindowsFolderBatchDiscovery.Overlaps(Path.Combine(first.Root,"현장"),Path.Combine(first.Root,"현장2")));
    }
    [TestMethod]
    public void BatchWorkRouteKeepsOneOpaqueCommandAndLegacySetupDefaults(){
        var command=JsonSerializer.Serialize(new{client_command_id=Guid.NewGuid(),changes=new[]{new{id=Guid.NewGuid(),expected_version=2,source_generation=3,scope_mode="unassigned",project_id=(string?)null}}});
        using var payload=JsonDocument.Parse(JsonSerializer.Serialize(new{route="folders.correct",command}));
        var request=WindowsWorkRoutes.Decode(payload.RootElement);
        Assert.AreEqual("v1/site-folder-bindings/batch",WindowsWorkRoutes.Path(request));Assert.AreEqual(command,WindowsWorkRoutes.Body(request));
        using var read=JsonDocument.Parse("{\"route\":\"folders.read\"}");
        Assert.AreEqual("v1/site-folder-bindings",WindowsWorkRoutes.Path(WindowsWorkRoutes.Decode(read.RootElement)));
        var previous=JsonSerializer.Deserialize<WindowsFolderSelection>("{\"Kind\":\"folder\",\"ProjectId\":null,\"NewProjectName\":null,\"Common\":true}");
        Assert.IsFalse(previous!.Unassigned);Assert.IsTrue(previous.Common);
    }
}
