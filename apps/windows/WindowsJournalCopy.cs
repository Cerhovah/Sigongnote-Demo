using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
namespace Sigongnote.Windows;
public static class WindowsJournalCopy {
 public static async Task Write(string root,MirrorJournal journal,JsonElement data,string apiOrigin,CancellationToken token,Action checkpoint){
  const string relative="최근 업무일지.html";var target=Path.Combine(root,relative);WindowsMirrorFiles.Safe(root,target);
  if(File.Exists(target)){var current=await WindowsMirrorFiles.Hash(target,token);if(!journal.IndexHashes.TryGetValue(relative,out var expected)||!expected.Split('|').Contains(current))return;}
  var origin=new Uri(apiOrigin);if(origin.Scheme!="https"&&!(origin.Scheme=="http"&&origin.IsLoopback))throw new IOException();
  static string H(string s)=>System.Net.WebUtility.HtmlEncode(s);
  var entries=new StringBuilder();
  foreach(var item in data.GetProperty("items").EnumerateArray().Take(30)){
   var id=item.GetProperty("id").GetString();if(!Guid.TryParseExact(id,"D",out _))throw new IOException();
   var at=DateTimeOffset.Parse(item.GetProperty("received_at").GetString()!,System.Globalization.CultureInfo.InvariantCulture).ToOffset(TimeSpan.FromHours(9));
   var project=item.TryGetProperty("project_name",out var p)&&p.ValueKind==JsonValueKind.String?p.GetString():"현장 확인 전";
   var text=item.GetProperty("excerpt").GetString()??"";
   if(text.Length==0)text=item.GetProperty("reading_state").GetString()=="waiting"?"자료 도착 · 내용을 읽는 중":"원본 보관 · 읽은 내용 없음";
   var tags=string.Join(" · ",item.GetProperty("categories").EnumerateArray().Select(v=>WindowsMirrorFiles.Category(v.GetString())));
   entries.Append($"<article><p>{at:yyyy-MM-dd HH:mm} 도착 · {H(project??"")}</p><h2>{H(tags)}</h2><p class=content>{H(text)}</p><a href=\"{H(new Uri(origin,"/#/materials/item/"+id).AbsoluteUri)}\">앱에서 원문과 최신 상태 확인</a></article>");
  }
  var body=$"<!doctype html><html lang=ko><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none';style-src 'unsafe-inline';base-uri 'none'\"><title>최근 업무일지</title><style>body{{font:20px/1.7 sans-serif;max-width:900px;margin:32px auto;padding:0 20px}}article{{padding:20px 0;border-bottom:1px solid #ddd}}h2{{font-size:18px}}.content{{white-space:pre-wrap}}</style><h1>최근 업무일지</h1><p>최근 도착 기록 최대 30개 · 한국 시간 · 연결 중 자동 갱신</p><p>동의한 PC 사본입니다. 앱에서 전체 날짜별 기록과 최신 접근 상태를 확인하세요. 직접 수정한 사본은 자동으로 덮어쓰지 않습니다.</p>{entries}</html>";
  var bytes=Encoding.UTF8.GetBytes(body);var hash=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();if(journal.IndexHashes.GetValueOrDefault(relative)==hash)return;var temp=target+"."+Guid.NewGuid()+".tmp";
  try{await File.WriteAllBytesAsync(temp,bytes,token);journal.IndexHashes[relative]=journal.IndexHashes.TryGetValue(relative,out var previous)?previous+"|"+hash:hash;checkpoint();WindowsMirrorFiles.Safe(root,target);File.Move(temp,target,true);journal.IndexHashes[relative]=hash;checkpoint();}finally{if(File.Exists(temp))File.Delete(temp);}
 }
}
