using System.Reflection;
using System.Windows.Forms;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Sigongnote.Windows;

namespace Sigongnote.Windows.Tests;

[TestClass]
public class GuidedFolderConsentTests
{
    private static IEnumerable<Control> All(Control parent) => parent.Controls.Cast<Control>().SelectMany(c=>new[]{c}.Concat(All(c)));
    // Exercise the form's handlers without showing or controlling a user's native window.
    private static void Click(Button button) {Assert.IsTrue(button.Enabled);typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(button,[EventArgs.Empty]);}
    [TestMethod]
    public void SingleScreenRequiresASiteAndKeepsCancelUnconfirmed()
    {
        Exception? failure=null;
        var thread=new Thread(()=>{try {
            var policy=new Sigongnote.Contracts.CapturePolicy("fixture-external","work_records","fixture-provider","test-region","test-storage","30 days",true);
            var destination=new WindowsUploadDestination("Fixture Company","https://api.example.test",new(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid()),policy,[]);
            using var form=new WindowsFolderConsentForm("synthetic-work",new(0,0,0,DateTime.MinValue,new Dictionary<string,int>()),destination);
            var controls=All(form).ToList();var start=(Button)form.AcceptButton!;
            var name=controls.OfType<TextBox>().Single(c=>c.AccessibleName=="현장 이름");
            Assert.IsNull(form.Selection);Assert.AreEqual(DialogResult.None,form.DialogResult);
            name.Text=" ";Assert.IsFalse(start.Enabled);Assert.IsNull(form.Selection);
            name.Text="  합성 새 현장  ";Assert.IsTrue(start.Enabled);Assert.IsNull(form.Selection);
            var text=string.Join(" ",controls.Select(c=>c.Text));StringAssert.Contains(text,"synthetic-work");StringAssert.Contains(text,"Fixture Company");StringAssert.Contains(text,"fixture-provider");StringAssert.Contains(text,"test-region");
            Click(start);Assert.AreEqual(DialogResult.OK,form.DialogResult);Assert.IsNotNull(form.Selection);
            Assert.AreEqual("합성 새 현장",form.Selection.NewProjectName);Assert.IsNull(form.Selection.ProjectId);Assert.IsTrue(form.Selection.NewOnly);
            Assert.IsFalse(form.Selection.Common);Assert.IsFalse(form.Selection.RecentOnly);
            using var cancelled=new WindowsFolderConsentForm("synthetic-work",new(0,0,0,DateTime.MinValue,new Dictionary<string,int>()),destination);
            Assert.IsNull(cancelled.Selection);Click((Button)cancelled.CancelButton!);Assert.AreEqual(DialogResult.Cancel,cancelled.DialogResult);Assert.IsNull(cancelled.Selection);
            using var commonForm=new WindowsFolderConsentForm("synthetic-work",new(0,0,0,DateTime.MinValue,new Dictionary<string,int>()),destination);
            var commonControls=All(commonForm).ToList();commonControls.OfType<TextBox>().Single(c=>c.AccessibleName=="현장 이름").Text="";
            Assert.IsFalse(((Button)commonForm.AcceptButton!).Enabled);
            Click(commonControls.OfType<Button>().Single(c=>c.Text=="저장 옵션"));
            commonControls.OfType<CheckBox>().Single(c=>c.Text=="회사 공통 자료").Checked=true;
            Click((Button)commonForm.AcceptButton!);Assert.IsNotNull(commonForm.Selection);Assert.IsTrue(commonForm.Selection.Common);
            Assert.IsNull(commonForm.Selection.ProjectId);Assert.IsNull(commonForm.Selection.NewProjectName);Assert.IsFalse(commonForm.Selection.DownloadCopies);Assert.IsFalse(commonForm.Selection.JournalCopies);
        }catch(Exception e){failure=e;}});
        thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();if(failure is not null)throw failure;
    }
}
