using System.Runtime.ExceptionServices;
using System.Windows.Forms;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Sigongnote.Windows.Tests;

[TestClass]
public sealed class LoginDialogHostTests
{
    private static void InSta(Action action)
    {
        Exception? failure=null;
        var thread=new Thread(()=> {try {action();}catch(Exception error){failure=error;}});
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(15)),"Login dialog did not close");
        if(failure is not null)ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [TestMethod]
    public void QueuedSecondNavigationCannotLeaveAnotherLoginAfterSuccess()
    {
        InSta(()=> {
            using var owner=new Form();
            owner.ShowInTaskbar=false;
            _=owner.Handle;
            var host=new WindowsLoginDialogHost();
            var created=0;var completions=0;var reentered=false;
            var first=host.Show(owner,()=> {
                created++;
                var dialog=new Form {ShowInTaskbar=false};
                dialog.Shown+=(_,_)=>dialog.BeginInvoke(new Action(()=> {
                    try {
                        // This message runs inside the first ShowDialog loop,
                        // just like a queued WebView login navigation.
                        var second=host.Show(owner,()=>{created++;return new Form();});
                        reentered=true;
                        if(second is not null)completions++;
                        dialog.DialogResult=DialogResult.OK;
                    }finally{dialog.Close();}
                }));
                return dialog;
            });
            if(first is not null)completions++;
            Assert.IsTrue(reentered);
            Assert.AreEqual(DialogResult.OK,first);
            Assert.AreEqual(1,created);
            Assert.AreEqual(1,completions);
            Assert.IsFalse(host.ActivateExisting());
        });
    }

    [TestMethod]
    public void CancelAndConstructionFailureAllowTheNextLogin()
    {
        InSta(()=> {
            using var owner=new Form {ShowInTaskbar=false};
            _=owner.Handle;
            var host=new WindowsLoginDialogHost();
            Assert.ThrowsExactly<InvalidOperationException>(()=>host.Show(owner,()=>throw new InvalidOperationException("fixture")));
            Assert.IsFalse(host.ActivateExisting());
            foreach(var result in new[]{DialogResult.Cancel,DialogResult.OK}) {
                Assert.AreEqual(result,host.Show(owner,()=> {
                    var dialog=new Form {ShowInTaskbar=false};
                    dialog.Shown+=(_,_)=>dialog.BeginInvoke(new Action(()=>{dialog.DialogResult=result;dialog.Close();}));
                    return dialog;
                }));
                Assert.IsFalse(host.ActivateExisting());
            }
        });
    }
}
