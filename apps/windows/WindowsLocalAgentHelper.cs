using System.Security.Cryptography;
using System.Text;

namespace Sigongnote.Windows;

internal static class WindowsLocalAgentHelper
{
    internal static void Run(string[] args)
    {
        if(args.Length==1&&args[0]=="--shutdown-for-update"){
            WindowsUpdateShutdown.StopRunningCopies();
        }else if(args.Length==1&&args[0]=="--local-cloud-session"){
            object? result=null;
            try {
                var vault=new WindowsTokenVault(Path.Combine(Path.GetDirectoryName(WindowsStateStore.DefaultPath)!,"session.protected"));
                using var sessions=new WindowsSessionManager(vault);
                using var cancellation=new CancellationTokenSource(TimeSpan.FromSeconds(12));
                var session=sessions.CurrentAsync(cancellation.Token).GetAwaiter().GetResult();
                var state=new WindowsStateStore(WindowsStateStore.DefaultPath);
                result=new {apiUrl=session.ApiBaseUrl,accessToken=session.AccessToken,tenantId=session.TenantId,userId=session.UserId,deviceId=session.DeviceId,nativeSources=state.LocalNativeScopes()};
            }catch(Exception error) when(error is WindowsLoginRequiredException or WindowsSessionUnavailableException or OperationCanceledException or IOException or CryptographicException) { }
            using var output=Console.OpenStandardOutput();output.Write(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(result));output.Flush();
        }else if(args.Length==2&&args[0]=="--local-key"){
            var file=Path.GetFullPath(args[1]);
            if(Path.GetFileName(file)!="copy-key.protected")throw new ArgumentException("Invalid key file");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            byte[] key;
            if(File.Exists(file))key=ProtectedData.Unprotect(File.ReadAllBytes(file),null,DataProtectionScope.CurrentUser);
            else{
                key=RandomNumberGenerator.GetBytes(32);
                var temporary=file+"."+Guid.NewGuid().ToString("N")+".new";
                try{
                    File.WriteAllBytes(temporary,ProtectedData.Protect(key,null,DataProtectionScope.CurrentUser));
                    try{File.Move(temporary,file,false);}
                    catch(IOException) when(File.Exists(file)){CryptographicOperations.ZeroMemory(key);key=ProtectedData.Unprotect(File.ReadAllBytes(file),null,DataProtectionScope.CurrentUser);}
                }finally{if(File.Exists(temporary))File.Delete(temporary);}
            }
            try{
                if(key.Length!=32)throw new CryptographicException("Invalid key length");
                var bytes=Encoding.ASCII.GetBytes(Convert.ToBase64String(key));
                using var output=Console.OpenStandardOutput();output.Write(bytes);output.Flush();
            }finally{CryptographicOperations.ZeroMemory(key);}
        }else if(args.Length==1&&args[0]=="--select-local-folder"){
            using var picker=new FolderBrowserDialog{Description="추가로 정리할 자료 폴더",UseDescriptionForTitle=true,ShowNewFolderButton=true};
            if(picker.ShowDialog()!=DialogResult.OK)return;
            using var output=Console.OpenStandardOutput();output.Write(Encoding.UTF8.GetBytes(picker.SelectedPath));output.Flush();
        }else throw new ArgumentException("Unknown local helper");
    }
}
