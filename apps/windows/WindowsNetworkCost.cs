using System.Runtime.InteropServices;

namespace Sigongnote.Windows;

internal static class WindowsNetworkCost
{
    // https://learn.microsoft.com/windows/win32/api/netlistmgr/nf-netlistmgr-inetworkcostmanager-getcost
    // NLM GetCost (netlistmgr.h): only explicitly unrestricted connectivity
    // permits background recovery downloads. Unknown and metered retain copies.
    internal static bool AllowsRecovery(uint cost)=>cost==1;
    internal static bool Unmetered()
    {
        object? manager=null;
        try {
            var type=Type.GetTypeFromCLSID(new Guid("DCB00C01-570F-4A9B-8D69-199FDBA5723B"),true)!;
            manager=Activator.CreateInstance(type);
            ((INetworkCostManager)manager!).GetCost(out var cost,IntPtr.Zero);
            return AllowsRecovery(cost);
        }catch(Exception error) when(error is COMException or InvalidCastException or TypeLoadException) {return false;}
        finally {if(manager is not null&&Marshal.IsComObject(manager))Marshal.ReleaseComObject(manager);}
    }

    [ComImport,Guid("DCB00008-570F-4A9B-8D69-199FDBA5723B"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface INetworkCostManager
    {
        void GetCost(out uint cost,IntPtr destination);
    }
}
