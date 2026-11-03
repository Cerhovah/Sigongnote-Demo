using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Sigongnote.Contracts;

namespace Sigongnote.Windows;

public sealed class WindowsWorkspaceInvitationException:Exception;
public sealed record WindowsWorkspaceDraft(Guid UserId,string ApiOrigin,Guid Key,string Name);

/// <summary>First-company setup survives a lost response; it cannot claim an existing tenant.</summary>
public sealed class WindowsWorkspaceBootstrap(WindowsConnectionOptions options,WindowsTokenVault pendingVault,
    WindowsTokenVault draftVault,HttpMessageHandler? handler=null):IDisposable
{
    private static readonly JsonSerializerOptions Json=new(JsonSerializerDefaults.Web);
    private readonly HttpClient http=new(handler ?? new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}){Timeout=TimeSpan.FromSeconds(20)};
    public void Dispose()=>http.Dispose();
    private WindowsPendingAuth Pending() {
        WindowsPendingAuth pending;
        try {pending=JsonSerializer.Deserialize<WindowsPendingAuth>(pendingVault.Read() ?? "",Json) ?? throw new WindowsLoginRequiredException();}
        catch(Exception e) when(e is JsonException or System.Security.Cryptography.CryptographicException) {throw new WindowsLoginRequiredException();}
        if(!options.SameService(pending.Options) || pending.ExpiresAtEpochMs<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())throw new WindowsLoginRequiredException();
        return pending;
    }
    private WindowsWorkspaceDraft? Draft(WindowsPendingAuth pending) {
        try {
        var raw=draftVault.Read();if(raw is null)return null;
        var draft=JsonSerializer.Deserialize<WindowsWorkspaceDraft>(raw,Json);
        return draft?.UserId==pending.UserId && draft.ApiOrigin==options.ApiBaseUrl && draft.Key!=Guid.Empty && draft.Name?.Trim().Length is >0 and <=120 ? draft : null;
        } catch(Exception e) when(e is JsonException or System.Security.Cryptography.CryptographicException or IOException) {draftVault.Clear();return null;}
    }
    private void Current(WindowsPendingAuth expected) {if(Pending().UserId!=expected.UserId)throw new WindowsLoginRequiredException();}
    public bool HasDraft()=>Draft(Pending()) is not null;
    public string SuggestedName()=>Draft(Pending())?.Name ?? "우리 회사";
    private HttpRequestMessage Request(HttpMethod method,string path,WindowsPendingAuth pending) {
        var request=new HttpRequestMessage(method,new Uri(new Uri(options.ApiBaseUrl),path));
        request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",pending.AccessToken);return request;
    }
    private async Task<MeResponseMembershipsItem[]> Companies(WindowsPendingAuth pending,CancellationToken cancellation) {
        using var request=Request(HttpMethod.Get,"v1/me",pending);using var response=await http.SendAsync(request,cancellation);
        if(response.StatusCode==HttpStatusCode.Unauthorized)throw new WindowsLoginRequiredException();
        if(response.StatusCode!=HttpStatusCode.OK)throw new WindowsSessionUnavailableException();
        var me=await response.Content.ReadFromJsonAsync<MeResponse>(Json,cancellation) ?? throw new WindowsClientContractException();
        if(me.user_id!=pending.UserId.ToString("D"))throw new WindowsLoginRequiredException();
        return me.memberships.Where(row=>row.role is "owner" or "operator").ToArray();
    }
    public async Task<MeResponseMembershipsItem[]> CreateAsync(string name,CancellationToken cancellation=default) {
        var pending=Pending();var current=await Companies(pending,cancellation);Current(pending);if(current.Length>0){draftVault.Clear();return current;}
        name=name.Trim();if(name.Length is <1 or >120)throw new ArgumentException("Company name required");
        var draft=Draft(pending) ?? new(pending.UserId,options.ApiBaseUrl,Guid.NewGuid(),name);
        // Preserve the originally submitted name if the server response was lost.
        draftVault.Save(JsonSerializer.Serialize(draft,Json));
        using var request=Request(HttpMethod.Post,"v1/workspaces",pending);
        request.Headers.TryAddWithoutValidation("Idempotency-Key",draft.Key.ToString("D"));
        request.Content=JsonContent.Create(new WorkspaceCreateRequest(draft.Name),options:Json);
        Current(pending);
        using var response=await http.SendAsync(request,cancellation);
        if(response.StatusCode==HttpStatusCode.Forbidden)throw new WindowsWorkspaceInvitationException();
        if(response.StatusCode==HttpStatusCode.Unauthorized)throw new WindowsLoginRequiredException();
        if(response.StatusCode is not (HttpStatusCode.Created or HttpStatusCode.Conflict))throw new WindowsSessionUnavailableException();
        current=await Companies(pending,cancellation);
        if(current.Length==0)throw new WindowsWorkspaceInvitationException();
        if(Pending().UserId!=pending.UserId)throw new WindowsLoginRequiredException();
        draftVault.Clear();return current;
    }
}
