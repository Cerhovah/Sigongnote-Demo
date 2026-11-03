namespace Sigongnote.Windows;

public enum WindowsWorkDestination { Blocked, Page, Settings, SetupFolder, SetupRecording, Login, Logout, LinkAccount, PublicSetup }

/// <summary>Only the bundled page can request a fixed native destination; never accept arbitrary URLs.</summary>
public static class WindowsWorkNavigation
{
    public static WindowsWorkDestination Classify(string? address)
    {
        if(address is null)return WindowsWorkDestination.Blocked;
        if(address.Split('#',2)[0]==WindowsWorkForm.Origin+"/index.html")return WindowsWorkDestination.Page;
        return address switch {
            "https://sigongnote-api.onrender.com/" or "https://sigongnote-api.onrender.com/#/setup" or
            "https://sigongnote-api.onrender.com/install" or "https://sigongnote-api.onrender.com/download/android" or
            "https://sigongnote-api.onrender.com/download/windows"=>WindowsWorkDestination.PublicSetup,
            WindowsWorkForm.Origin+"/setup-folder"=>WindowsWorkDestination.SetupFolder,
            WindowsWorkForm.Origin+"/setup-recording"=>WindowsWorkDestination.SetupRecording,
            WindowsWorkForm.Origin+"/settings"=>WindowsWorkDestination.Settings,
            WindowsWorkForm.Origin+"/login"=>WindowsWorkDestination.Login,
            WindowsWorkForm.Origin+"/logout"=>WindowsWorkDestination.Logout,
            WindowsWorkForm.Origin+"/link-account"=>WindowsWorkDestination.LinkAccount,
            _=>WindowsWorkDestination.Blocked
        };
    }
}
