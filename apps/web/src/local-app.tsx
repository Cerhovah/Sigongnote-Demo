import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FieldToday, FieldProjects, FieldAdmin } from "./field-ui.js";
import { Navigation, type Tab } from "./navigation.js";
import { FocusBlock, FocusHeader, Guide, MenuRow, focusHash, readFocusRoute, type FocusRoute, type FocusView } from "./focus-ui.js";
import { ensurePaired, labels, localRequest, type Summary, type Document, type Copies, type AiPreview } from "./local-api.js";
export { localRequest } from "./local-api.js";

const home = (tab: Tab): FocusRoute => ({ tab, view: "home", id: "" });
const documentViews = new Set<FocusView>(["document", "read", "site", "actions", "ai", "copies", "prepare"]);
const guideKey = "sigongnote-guide-v3";
function hasSeenGuide() { try { return localStorage.getItem(guideKey) === "seen"; } catch { return false; } }
function prefersLargeText() { try { return localStorage.getItem("sigongnote-large-text") === "true"; } catch { return false; } }
function folderName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "업무 폴더"; }

function FolderQuestion({ question, busy, answer }: { question: NonNullable<Summary["folderQuestion"]>; busy: boolean;
  answer: (choice: "site" | "mixed" | "later", site?: string) => void }) {
  const [name, setName] = useState("");
  return <FocusBlock><h2>모두 같은 현장 일인가요?</h2><p data-record="true">{question.relative_dir}</p>
    <p className="muted">자료 {question.count}개와 앞으로 들어올 자료에 적용돼요. 하위 폴더는 따로 살펴요.</p>
    <label htmlFor="folder-site">현장 이름</label><input id="folder-site" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
    <button type="button" className="primary" data-primary="true" disabled={busy || !name.trim()} onClick={() => answer("site", name)}>같은 현장이에요</button>
    <div className="quiet-actions"><button type="button" className="secondary" disabled={busy} onClick={() => answer("mixed")}>여러 현장이에요</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => answer("later")}>나중에 할게요</button></div>
  </FocusBlock>;
}

export function LocalApp() {
  const [route, setRoute] = useState(() => readFocusRoute(location.hash));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [query, setQuery] = useState(""), [offset, setOffset] = useState(0);
  const [search, setSearch] = useState<{ total: number; documents: Document[] }>({ total: 0, documents: [] });
  const [searching, setSearching] = useState(true), [searchError, setSearchError] = useState("");
  const [statusError, setStatusError] = useState(""), [stopPrompt, setStopPrompt] = useState(false);
  const shownSearch = useRef(""), returnScroll = useRef(0), pendingMessage = useRef("");
  const lastRoute = useRef(location.hash);
  const [doc, setDoc] = useState<Document | null>(null), [site, setSite] = useState("");
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), working = useRef(false);
  const [copies, setCopies] = useState<Copies | null>(null), [aiPreview, setAiPreview] = useState<AiPreview | null>(null);
  const [refresh, setRefresh] = useState(0), [showTip, setShowTip] = useState(() => !hasSeenGuide());
  const [folderSite, setFolderSite] = useState("");
  const [commonFolder, setCommonFolder] = useState(false);
  const [largeText, setLargeText] = useState(prefersLargeText);
  const returnTo = useRef<FocusRoute>(home("materials"));
  const actor = new URLSearchParams(location.search).get("actor") === "agent_test" ? "agent_test" : "human";
  useEffect(() => {
    globalThis.document.documentElement.style.fontSize = largeText ? "225%" : "112.5%";
    try { localStorage.setItem("sigongnote-large-text", String(largeText)); } catch { /* optional reading preference */ }
  }, [largeText]);
  const go = useCallback((next: FocusRoute, replace = false) => {
    setRoute(next); setError(""); setMessage("");
    const hash = focusHash(next), url = `${location.pathname}${location.search}${hash}`;
    if (replace) history.replaceState(history.state, "", url);
    else if (location.hash !== hash) history.pushState({ parent: focusHash(readFocusRoute(location.hash)) }, "", url);
    lastRoute.current = hash;
  }, []);
  const page = (view: FocusView, id = "") => go({ tab: route.tab, view, id }, route.view === "actions" && ["ai", "copies", "site", "prepare"].includes(view));
  const backTo = (next: FocusRoute, receipt = "") => {
    if (history.state?.parent === focusHash(next)) { pendingMessage.current = receipt; history.back(); }
    else { go(next, true); setMessage(receipt); }
  };
  const record = (control: string, screen: Tab = route.tab) => {
    if (summary?.field?.configured) void localRequest("field/events", { control, screen, actor }).catch(() => {});
  };
  const navigate = (tab: Tab) => { if (working.current) return; record("screen_enter", tab); go(home(tab)); };
  useEffect(() => {
    const change = () => { if (lastRoute.current === location.hash) return; lastRoute.current = location.hash; setRoute(readFocusRoute(location.hash)); setError(""); setMessage(pendingMessage.current); pendingMessage.current = ""; };
    window.addEventListener("hashchange", change); window.addEventListener("popstate", change);
    return () => { window.removeEventListener("hashchange", change); window.removeEventListener("popstate", change); };
  }, []);
  useEffect(() => { void route.id; setStopPrompt(false); globalThis.document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true }); window.scrollTo(0, route.tab === "materials" && route.view === "home" ? returnScroll.current : 0); }, [route.tab, route.view, route.id]);
  useEffect(() => {
    let live = true;
    const load = async () => { try { await ensurePaired(); const next = await localRequest<Summary>("status"); if (live) { setSummary(next); setStatusError(""); } }
      catch (e) { if (live) setStatusError((e as Error).message); } };
    void load(); const timer = setInterval(() => { void load(); }, 8000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    void refresh; // Re-query after a successful edit.
    if (route.tab !== "materials" || route.view !== "home") return;
    let live = true; setSearching(true); setSearchError("");
    const timer = setTimeout(() => {
      void ensurePaired().then(() => localRequest<{ total: number; documents: Document[] }>(`documents?q=${encodeURIComponent(query)}&offset=${offset}`))
        .then(next => { if (live) { shownSearch.current = `${query}:${offset}`; setSearch({ ...next, documents: next.documents.slice(0, 20) }); } })
        .catch(() => { if (live) setSearchError("목록을 가져오지 못했어요."); })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, offset, refresh, route.tab, route.view]);
  useEffect(() => {
    if (!documentViews.has(route.view) || !route.id) return;
    let live = true; setDoc(null);
    void ensurePaired().then(() => localRequest<Document>(`documents/${route.id}`))
      .then(next => { if (live) { setDoc(next); setSite(next.site ?? ""); } })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [route.id, route.view]);
  const act = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setMessage("");
    try { await fn(); setRefresh(n => n + 1);
      // A failed status refresh must not relabel a successful write as a failure.
      void localRequest<Summary>("status").then(setSummary).catch(() => {});
    } catch (e) { setError((e as Error).message); }
    finally { working.current = false; setBusy(false); }
  };
  const openDocument = (id: string) => { record("evidence_open"); returnTo.current = route; returnScroll.current = window.scrollY; setCopies(null); setAiPreview(null); page("document", id); };
  const finishDocument = (text: string) => { backTo({ ...route, view: "document" }, text); setCopies(null); setAiPreview(null); };
  const download = () => act(async () => {
    if (!doc) return;
    const response = await fetch(`/api/documents/${doc.id}/copy`, { headers: { "X-Sigongnote-Local": "1" } });
    if (!response.ok) throw new Error("보관한 파일을 열지 못했어요.");
    const url = URL.createObjectURL(await response.blob());
    const anchor = globalThis.document.createElement("a"); anchor.href = url; anchor.download = doc.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  const dismissGuide = () => { setShowTip(false); try { localStorage.setItem(guideKey, "seen"); } catch { /* optional help preference */ } };
  const enabled = summary?.sources.filter(s => s.enabled) ?? [];
  const broken = enabled.some(s => s.problem && !["BACKLOG_PENDING", "SCAN_GAP"].includes(s.problem));
  const stale = enabled.some(s => s.last_scan && Date.now() - Date.parse(s.last_scan) > 86400000);
  const paused = summary?.sources.some(s => !s.enabled);
  const issueTitle = summary?.sources.some(s => s.enabled && s.problem === "CACHE_LIMIT") ? "보관 한도에 도달했어요" : summary?.sources.some(s => s.enabled && s.problem === "DISK_LOW") ? "PC 저장 공간이 부족해요" : summary?.sources.some(s => s.enabled && s.problem === "DIFFERENT_DRIVE") ? "다른 USB가 꽂혀 있어요" : "폴더를 읽지 못했어요";
  const readable = summary?.counts.filter(x => x.status === "complete" || x.status === "partial").reduce((n, x) => n + x.count, 0) ?? 0;
  const source = summary?.sources.find(s => s.id === route.id);
  if (location.pathname === "/admin") return <FieldAdmin request={localRequest} />;
  let content: ReactNode;
  if (route.view === "guide") content = <Guide hasFolder={enabled.length > 0} close={() => { dismissGuide(); go(home(route.tab)); }} go={step => {
    dismissGuide(); if (step === 0) page("folders"); else navigate(step === 1 ? "today" : "materials");
  }} />;
  else if (route.view === "settings") content = <><FocusHeader title="설정과 도움말" back={() => backTo(home(route.tab))} />
    <FocusBlock><MenuRow title="업무 폴더" note="허용한 폴더 살펴보기" onClick={() => page("folders")} />
      <MenuRow title="사용법" note="실제 자료로 시작하기" onClick={() => page("guide")} />
      <MenuRow title={largeText ? "기본 글자 크기로" : "글자 크게 보기"} note={largeText ? "현재 두 배 크기" : "두 배로 키워요"} onClick={() => setLargeText(value => !value)} />
      <a className="menu-row" href={`/admin${location.search}`}>운영자 기록 <span aria-hidden="true">›</span></a></FocusBlock></>;
  else if (route.view === "folders") content = <><FocusHeader title="업무 폴더" back={() => backTo({ tab: route.tab, view: "settings", id: "" })} />
    <FocusBlock><p>고른 폴더와 하위 폴더를 계속 읽어요. 원본은 바꾸지 않아요.</p>
      <button type="button" className="primary" data-primary="true" disabled={busy} onClick={() => void act(async () => { const picked = await localRequest<{ source?: Summary["sources"][number]; commonSuggested?: boolean }>("folders/pick", {}); const selected = picked.source; if (selected) { setFolderSite(folderName(selected.root)); setCommonFolder(picked.commonSuggested === true); setSummary(current => current ? { ...current, sources: [...current.sources.filter(row => row.id !== selected.id), selected] } : current); page("folder", selected.id); } })}>폴더 고르기</button>
      {summary?.sources.map(s => <MenuRow key={s.id} title={folderName(s.root)} note={!s.enabled ? "읽기 중지됨" : s.problem === "BACKLOG_PENDING" ? "지난 자료를 이어 읽는 중" : s.problem === "SCAN_GAP" ? "일부 폴더 확인 필요" : s.problem ? "폴더를 읽지 못했어요" : "읽기 허용됨"} onClick={() => { setFolderSite(s.managed?.site ?? folderName(s.root)); setCommonFolder(s.managed?.site === null); page("folder", s.id); }} />)}</FocusBlock>
    <FocusBlock><p>읽은 자료 {readable.toLocaleString()}개</p><p className="muted">PC가 꺼지거나 USB가 빠지면 기다려요.</p>
      <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => { await localRequest("scan", {}); setMessage("폴더를 다시 살펴보고 있어요."); })}>지금 다시 읽기</button></FocusBlock></>;
  else if (route.view === "folder") content = <><FocusHeader title="이 폴더 살펴보기" back={() => backTo({ tab: route.tab, view: "folders", id: "" })} />
    {source && !source.managed && <FocusBlock><h2>어느 현장 자료인가요?</h2>
      <label htmlFor="site-folder-name">현장 이름</label><input id="site-folder-name" value={folderSite} disabled={commonFolder || busy} maxLength={80} onChange={event => setFolderSite(event.target.value)} />
      <label className="folder-kind-choice"><input type="checkbox" checked={commonFolder} disabled={busy} onChange={event => setCommonFolder(event.target.checked)} /> 여러 현장의 공통 자료예요</label><p className="muted">하위 폴더가 여러 개면 공통 자료로 먼저 제안해요. 한 현장 자료라면 체크를 꺼 주세요.</p>
      <p>폴더 안의 시공노트에 약속 · 도면·자재 · 납품·작업 · 청구·지급 · 점검·하자 목록과 발행문서 폴더를 만들어요. 새 원본은 지금처럼 원래 업무 폴더에 넣어 주세요. 시공노트 목록 폴더 안에 넣은 자료는 다시 읽지 않아요.</p>
      <button type="button" className="primary" disabled={busy || (!commonFolder && !folderSite.trim())} onClick={() => void act(async () => {
        await localRequest(`folders/${source.id}/site`, { site: commonFolder ? null : folderSite.trim(), approved: true }); setMessage("현장 폴더를 연결했어요. 폴더 안의 시공노트에서 자료목록을 열 수 있어요.");
      })}>이 폴더로 연결하기</button></FocusBlock>}
    {source?.managed && <FocusBlock><h2>{source.managed.site ?? "회사 공통 자료"}</h2><p>{source.managed.status === "ready" ? "폴더 안의 시공노트에 다섯 종류의 자료목록이 있어요. 새 자료도 자동으로 이어 정리해요." : "자료목록을 갱신하지 못했어요. 원본과 직접 수정한 내용은 그대로 보존했어요."}</p>
      {source.managed.status !== "ready" && <button type="button" disabled={busy} onClick={() => void act(async () => { await localRequest(`folders/${source.id}/site/refresh`, {}); })}>폴더 다시 확인</button>}</FocusBlock>}
    <FocusBlock>{source && stopPrompt ? <><h2>읽기를 중지할까요?</h2><p>이 폴더의 새 자료를 가져오지 않아요. 보관한 복사본은 남아요.</p><button type="button" className="primary" data-primary="true" disabled={busy} onClick={() => void act(async () => { await localRequest(`folders/${source.id}`, { enabled: false }); setStopPrompt(false); setMessage("읽기를 중지했어요."); })}>읽기 중지</button><button type="button" className="text-button full-width" disabled={busy} onClick={() => setStopPrompt(false)}>계속 읽기</button></> : source ? <><p data-record="true">{source.root}</p><p>{source.problem === "CACHE_LIMIT" ? "보관 한도에 도달했어요. 새 자료를 읽지 못해요." : source.problem === "DISK_LOW" ? "PC의 저장 공간을 확보해 주세요." : source.problem === "DIFFERENT_DRIVE" ? "처음 허용한 USB를 꽂아주세요." : source.problem === "BACKLOG_PENDING" ? "지난 자료를 이어 읽고 있어요. 준비된 자료는 먼저 볼 수 있어요." : source.problem === "SCAN_GAP" ? "읽을 수 있는 자료는 준비했어요. 일부 하위 폴더를 읽지 못했어요." : source.problem ? "USB와 폴더 권한을 확인해 주세요." : source.enabled ? "새 자료를 계속 살펴봐요." : "읽기를 중지했어요."}</p>
      <p className="muted">{source.last_scan ? `마지막 확인 ${new Date(source.last_scan).toLocaleString("ko-KR")}` : "아직 살펴보지 못했어요."}</p>
      <button type="button" className="primary" data-primary="true" disabled={busy} onClick={() => void act(async () => {
        if (source.enabled) { await localRequest("scan", {}); setMessage("다시 살펴보고 있어요."); }
        else { await localRequest(`folders/${source.id}`, { enabled: true }); setMessage("다시 읽도록 허용했어요."); }
      })}>{source.enabled ? "다시 확인하기" : "읽기 허용"}</button>{!!source.enabled && <button type="button" className="text-button full-width" disabled={busy} onClick={() => setStopPrompt(true)}>읽기 중지…</button>}</> : <p>폴더를 찾지 못했어요.</p>}</FocusBlock></>;
  else if (documentViews.has(route.view)) {
    const titles: Partial<Record<FocusView, string>> = { document: "자료 살펴보기", read: "읽은 내용", site: "어느 현장 일인가요?", actions: "이 자료로 할 일", ai: "AI에게 보낼까요?", copies: "복사본을 만들까요?", prepare: "오늘 할 일을 준비할까요?" };
    const back = () => { if (busy) return; if (route.view === "document") backTo(returnTo.current); else backTo({ ...route, view: "document" }); };
    content = <><FocusHeader title={titles[route.view] ?? "자료"} back={back} />
      {!doc ? <FocusBlock><p>{error ? "자료를 다시 열어 주세요." : "자료를 가져오고 있어요."}</p></FocusBlock> : route.view === "document" ? <>
        <FocusBlock><p className="eyebrow" data-record="true">{doc.site ?? "현장을 알려주세요"}</p><h2 data-record="true">{doc.name}</h2>
          <p className="muted">{labels[doc.status]}</p>{!doc.available && <p className="attention">원래 파일을 찾지 못해 보관한 내용을 보여요.</p>}
          <div className="document-glimpse" data-record="true">{doc.parsed?.spans?.slice(0, 3).map(span => <p key={`${span.locator}-${span.text}`}>{span.text.slice(0, 250)}{span.text.length > 250 ? "…" : ""}</p>)}</div>
          {doc.parsed?.spans?.length ? <p className="muted">앞부분만 보여요.</p> : <p>아직 보여드릴 본문이 없어요.</p>}
          {doc.status === "partial" && <p className="attention">빠진 내용이 있을 수 있어요.</p>}
          <button type="button" className="primary" data-primary="true" disabled={busy || !doc.hash} onClick={() => page(doc.site ? "read" : "site", doc.id)}>{doc.site ? "내용 살펴보기" : "현장 알려주기"}</button>
          {!doc.site && <button type="button" className="text-button full-width" onClick={() => page("read", doc.id)}>내용 먼저 보기</button>}</FocusBlock>
        <FocusBlock><MenuRow title="더 할 일" note="복사 · AI 요약 · 오늘 할 일" onClick={() => page("actions", doc.id)} /></FocusBlock></>
      : route.view === "read" ? <FocusBlock><h2 data-record="true">{doc.name}</h2><p className="muted">{labels[doc.status]}</p>
        <button type="button" className="primary" data-primary="true" disabled={busy || !doc.hash} onClick={() => void download()}>파일 내려받기</button>
        <div className="source-reader" data-record="true">{doc.parsed?.spans?.slice(0, 80).map(span => <p key={`${span.locator}-${span.text}`}>{span.text}</p>)}</div>
        {(doc.parsed?.excerptTruncated || (doc.parsed?.spans?.length ?? 0) > 80 || doc.status === "partial") && <p className="attention">읽힌 내용이 전부는 아니에요. 전체는 파일에서 확인해 주세요.</p>}
        <details><summary>가져온 곳</summary><p data-record="true">{doc.relative_path}</p></details></FocusBlock>
      : route.view === "site" ? <FocusBlock><p data-record="true">{doc.name}</p><p className="muted">찾기 쉽게 모아둬요. 돈이나 완료 여부는 바꾸지 않아요.</p>
        <form onSubmit={e => { e.preventDefault(); void act(async () => { await localRequest(`documents/${doc.id}/site`, { site, revision: doc.revision }); finishDocument(summary?.field?.configured ? "이 PC에 현장 이름을 적었어요. 오늘 질문은 따로 남아 있어요." : "이 현장 자료로 기억했어요."); }); }}>
          <label htmlFor="real-site">현장 이름</label><input id="real-site" value={site} maxLength={80} onChange={e => setSite(e.target.value)} />
          <button className="primary" data-primary="true" type="submit" disabled={busy || !doc.hash || !site.trim()}>이 현장이에요</button>
        </form><button type="button" className="text-button full-width" disabled={busy} onClick={back}>취소</button></FocusBlock>
      : route.view === "actions" ? <FocusBlock><MenuRow title="파일 내려받기" onClick={() => void download()} disabled={busy || !doc.hash} />
        <MenuRow title="현장 알려주기" onClick={() => page("site", doc.id)} disabled={busy || !doc.hash} />
        <MenuRow title="정리용 복사본" note="원본은 그대로 둬요" disabled={busy || !doc.hash} onClick={() => void act(async () => { setCopies(await localRequest<Copies>("copies/prepare", { ids: [doc.id] })); page("copies", doc.id); })} />
        <MenuRow title="AI 요약" note={summary?.ai.configured ? "보낼 내용부터 확인해요" : "PC에 AI 설정이 필요해요"} disabled={busy || !summary?.ai.configured || !doc.hash} onClick={() => void act(async () => { setAiPreview(await localRequest<AiPreview>("ai/prepare", { id: doc.id })); page("ai", doc.id); })} />
        {summary?.field?.configured && <MenuRow title="오늘 할 일 준비" note="업무 서버로 자료를 보내요" disabled={busy} onClick={() => page("prepare", doc.id)} />}
        {doc.ai && <details><summary>AI가 제안한 내용</summary><p className="muted">확인이 필요한 제안이에요.</p><p data-record="true">{(JSON.parse(doc.ai) as { summary: string }).summary}</p><p data-record="true">{(JSON.parse(doc.ai) as { question: string }).question}</p></details>}</FocusBlock>
      : route.view === "ai" ? <FocusBlock>{aiPreview ? <><p>{aiPreview.provider}의 {aiPreview.model}에 아래 내용만 한 번 보내요.</p><p>API 이용료가 들 수 있어요. 제공사의 보관 정책이 적용돼요.</p>
        <p>일부 숫자는 가렸지만 이름·주소는 남을 수 있어요. 보내고 나면 회수할 수 없어요.</p>
        <details open><summary>보낼 내용 확인</summary><div className="source-reader" data-record="true">{aiPreview.payload.spans.map(span => <p key={`${span.locator}-${span.text}`}>{span.text}</p>)}</div></details>
        <button type="button" className="primary" data-primary="true" disabled={busy} onClick={() => void act(async () => { await localRequest(`ai/${aiPreview.id}/approve`, { consent: true }); finishDocument("AI 제안을 준비했어요. 돈에는 반영하지 않았어요."); })}>한 번 보내기</button>
        <button type="button" className="text-button full-width" disabled={busy} onClick={back}>보내지 않기</button></> : <><p>보낼 내용을 다시 준비해 주세요.</p><button type="button" onClick={() => page("actions", doc.id)}>더 할 일 보기</button></>}</FocusBlock>
      : route.view === "copies" ? <FocusBlock>{copies ? <><p>{copies.items.length}개를 이 PC에 복사해요. 원본은 그대로예요.</p>
        <p>저장할 곳</p><p data-record="true">{copies.destination}</p><ul className="copy-list" data-record="true">{copies.items.map(item => <li key={item.id}>{item.name}<br />{item.destination}</li>)}</ul>
        <button type="button" className="primary" data-primary="true" disabled={busy} onClick={() => void act(async () => { await localRequest(`copies/${copies.id}/approve`, { approved: true }); finishDocument(`복사본을 만들었어요. ${copies.destination}`); })}>복사본 만들기</button>
        <button type="button" className="text-button full-width" disabled={busy} onClick={back}>취소</button></> : <><p>복사할 내용을 다시 준비해 주세요.</p><button type="button" onClick={() => page("actions", doc.id)}>더 할 일 보기</button></>}</FocusBlock>
      : <FocusBlock><p data-record="true">{doc.name}</p><p>이 파일과 읽은 내용을 업무 서버로 보내요.</p><p>확인할 질문을 준비해요. 돈이나 완료 여부는 바꾸지 않아요.</p><p className="muted">보낸 자료는 이 화면에서 회수할 수 없어요.</p>
        <button type="button" className="primary" data-primary="true" disabled={busy} onClick={() => void act(async () => {
          const sent = await localRequest<{ status: string }>("field/prepare", { id: doc.id });
          if (sent.status === "failed") throw new Error("자료를 보내지 못했어요. 폴더 허용을 확인해 주세요.");
          finishDocument(sent.status === "acked" ? "오늘에 확인할 일을 준비했어요." : "자료를 보내고 있어요. 받으면 오늘에 보여요.");
        })}>보내고 준비하기</button><button type="button" className="text-button full-width" disabled={busy} onClick={back}>취소</button></FocusBlock>}</>;
  } else if (route.tab === "today") content = <><FocusHeader title="오늘" note="필요한 일만, 하나씩." />
    {!summary ? <FocusBlock><p>{statusError ? "업무자료를 가져오지 못했어요." : "업무자료를 가져오고 있어요."}</p></FocusBlock>
      : summary.field?.configured ? <FieldToday request={localRequest} open={openDocument} />
      : !enabled.length ? <FocusBlock><h2>업무자료가 어디 있나요?</h2><p>폴더를 고르면 새 자료를 살펴봐요.</p><button type="button" className="primary" data-primary="true" onClick={() => page("folders")}>업무 폴더 고르기</button></FocusBlock>
      : summary.folderQuestion ? <FolderQuestion key={`${summary.folderQuestion.source_id}:${summary.folderQuestion.relative_dir}`} question={summary.folderQuestion} busy={busy} answer={(answer, name) => void act(async () => {
        const q = summary.folderQuestion; if (!q) return;
        await localRequest(`folders/${q.source_id}/answer`, { directory: q.relative_dir, answer, ...(name ? { site: name } : {}) });
        setMessage(answer === "site" ? "함께 모아뒀어요. 돈이나 완료 여부는 바꾸지 않았어요." : "필요할 때 다시 알려주세요.");
      })} /> : <FocusBlock><h2>새로 답할 일이 없어요</h2><p>읽은 자료에서 필요한 일을 준비해요.</p><button type="button" className="primary" data-primary="true" onClick={() => navigate("materials")}>내 자료 보기</button></FocusBlock>}
    {(broken || stale || paused || (summary && !enabled.length)) ? <FocusBlock className="attention-block"><MenuRow title={broken ? issueTitle : stale ? "최근 자료를 못 살펴봤어요" : paused ? "읽기를 중지한 폴더가 있어요" : "PC의 업무 폴더를 골라주세요"} note="업무 폴더 확인하기" onClick={() => page("folders")} /></FocusBlock>
      : showTip && !error && !message ? <FocusBlock className="help-tip"><MenuRow title="처음이세요?" note="내 자료로 시작해 봐요" onClick={() => page("guide")} /><button type="button" className="text-button" onClick={dismissGuide}>다음에 볼게요</button></FocusBlock> : null}</>;
  else if (route.tab === "projects") content = <><FocusHeader title="현장" />
    {summary?.field?.configured ? <FieldProjects request={localRequest} route={route} go={go} /> : <FocusBlock>{summary?.sites.length ? summary.sites.map(s => <MenuRow key={s.site} title={s.site} note={`자료 ${s.count}개`} onClick={() => { setQuery(s.site); setOffset(0); navigate("materials"); }} />)
      : <><h2>어느 현장 일인가요?</h2><p>자료에서 현장을 알려주면 여기에 모아요.</p><button type="button" className="primary" data-primary="true" onClick={() => navigate("materials")}>자료 살펴보기</button></>}</FocusBlock>}</>;
  else content = <><FocusHeader title="자료" />
    <FocusBlock className="search-block"><label htmlFor="local-search">기억나는 말을 적어주세요</label><input id="local-search" type="search" value={query} onChange={e => { returnScroll.current = 0; setQuery(e.target.value); setOffset(0); }} onBlur={() => record("search")} placeholder="현장 이름, 견적, 납품…" /></FocusBlock>
    <FocusBlock><p className="result-count muted" aria-live="polite">{searchError || (searching ? "찾고 있어요…" : `${search.total.toLocaleString()}개${search.documents.length ? ` · ${offset + 1}–${offset + search.documents.length}` : ""}`)}</p>
      {searchError ? <button type="button" className="primary" data-primary="true" onClick={() => setRefresh(n => n + 1)}>다시 찾기</button> : (!searching || shownSearch.current === `${query}:${offset}`) && <ul className="plain-list">{search.documents.map(item => <li key={item.id}><MenuRow title={item.name} note={`${item.site ?? "현장을 알려주세요"} · ${labels[item.status] ?? "살펴보는 중"}`} onClick={() => openDocument(item.id)} disabled={busy} /></li>)}</ul>}
      {!searching && !searchError && !search.documents.length && <p>다른 말로 찾아보세요.</p>}
      {!searchError && <div className="pagination"><button type="button" className="secondary" disabled={!offset || searching} onClick={() => { returnScroll.current = 0; setOffset(n => Math.max(0, n - 20)); }}>이전</button>
        <button type="button" className="secondary" disabled={offset + 20 >= search.total || searching} onClick={() => { returnScroll.current = 0; setOffset(n => n + 20); }}>다음</button></div>}</FocusBlock></>;
  return <div className="app-shell focus-app"><button type="button" className="skip-link" onClick={() => globalThis.document.getElementById("main-content")?.focus()}>본문으로 바로 가기</button>
    <header className="focus-topbar"><strong className="brand"><span className="brand-mark" aria-hidden="true">시</span>시공노트</strong>
      <button type="button" className="text-button" disabled={busy} onClick={() => page("settings")}>도움말·설정</button></header>
    <main className="content" id="main-content" tabIndex={-1} aria-busy={busy}>{(error || statusError) && <p className="notice error" role="alert">{error || statusError}</p>}{message && <p className="notice receipt" role="status">{message}</p>}{content}</main>
    <a href="/?work=1">PC·휴대폰 공통 자료 보기</a><Navigation active={route.tab} onNavigate={navigate} /></div>;
}
