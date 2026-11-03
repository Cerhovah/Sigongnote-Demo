using System.Runtime.ExceptionServices;
using System.Windows.Forms;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Sigongnote.Contracts;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class SimpleConnectionFormsTests
{
    private static readonly Guid Project=Guid.Parse("00000000-0000-4000-8000-000000000101");
    private static WindowsUploadDestination Destination()=>new("Fixture Company","https://fixture.invalid",
        new WindowsPrincipal(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid()),
        new CapturePolicy("fixture","work","fixture provider","fixture location","fixture storage","fixture retention",true),
        [new WindowsProjectChoice(Project.ToString("D"),"Fixture Project")],FirstProject:Project.ToString("D"));
    private static WindowsFolderScopePreview Preview()=>new(0,0,0,DateTime.UtcNow,new Dictionary<string,int>());
    private static void InSta(Action action)
    {
        Exception? failure=null;
        var thread=new Thread(()=>{try{action();}catch(Exception error){failure=error;}}){IsBackground=true};
        thread.SetApartmentState(ApartmentState.STA);thread.Start();
        Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(10)),"Connection dialog did not close");
        if(failure is not null)ExceptionDispatchInfo.Capture(failure).Throw();
    }
    private static DialogResult ClickPrimary(Form form)
    {
        form.ShowInTaskbar=false;
        form.Shown+=(_,_)=>form.BeginInvoke(new Action(()=>((Button)form.AcceptButton!).PerformClick()));
        using var timeout=new System.Windows.Forms.Timer {Interval=2000};
        timeout.Tick+=(_,_)=>form.Close();timeout.Start();
        return form.ShowDialog();
    }

    [TestMethod]
    public void OneActionConnectsTheSelectedProjectWithoutASecondConsentPage()
    {
        InSta(()=>{
            using var form=new WindowsFolderConsentForm(@"C:\Fixture\Project",Preview(),Destination());
            Assert.AreEqual(DialogResult.OK,ClickPrimary(form));
            Assert.IsNotNull(form.Selection);
            Assert.AreEqual(Project,form.Selection.ProjectId);
            Assert.IsNull(form.Selection.NewProjectName);
            Assert.IsTrue(form.Selection.NewOnly);
            Assert.IsTrue(form.Selection.DownloadCopies);
            Assert.IsFalse(form.Selection.JournalCopies);
        });
    }

    [TestMethod]
    public void OneActionConnectsManagedRootAndRetainsScopeOptions()
    {
        InSta(()=>{
            var previous=new WindowsFolderSelection("folder",null,null,false,DownloadCopies:false,ManagedRoot:true,NewOnly:false);
            using var form=new WindowsUpperFolderConsentForm(@"C:\Fixture",Preview(),Destination(),2,previous);
            Assert.AreEqual(DialogResult.OK,ClickPrimary(form));
            Assert.IsNotNull(form.Selection);
            Assert.IsTrue(form.Selection.ManagedRoot);
            Assert.IsTrue(form.Selection.Unassigned);
            Assert.IsFalse(form.Selection.DownloadCopies);
            Assert.IsFalse(form.Selection.NewOnly);
        });
    }

    [TestMethod]
    public void CancelDoesNotApproveOrCreateScope()
    {
        InSta(()=>{
            using var form=new WindowsUpperFolderConsentForm(@"C:\Fixture",Preview(),Destination(),0);
            form.ShowInTaskbar=false;
            form.Shown+=(_,_)=>form.BeginInvoke(new Action(()=>((Button)form.CancelButton!).PerformClick()));
            Assert.AreEqual(DialogResult.Cancel,form.ShowDialog());
            Assert.IsNull(form.Selection);
        });
    }
}
