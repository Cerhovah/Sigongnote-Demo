using System.Windows.Forms;

namespace Sigongnote.Windows;

/// <summary>ShowDialog pumps queued navigation messages; they must share one login.</summary>
internal sealed class WindowsLoginDialogHost
{
    private Form? current;
    private bool opening;

    internal bool ActivateExisting()
    {
        if (!opening) return false;
        if (current is { IsDisposed: false }) {
            if (current.WindowState == FormWindowState.Minimized)
                current.WindowState = FormWindowState.Normal;
            current.Activate();
        }
        return true;
    }

    internal DialogResult? Show(IWin32Window owner, Func<Form> create)
    {
        if (ActivateExisting()) return null;
        opening = true;
        try {
            using var dialog = create();
            current = dialog;
            return dialog.ShowDialog(owner);
        } finally {
            current = null;
            opening = false;
        }
    }
}
