import { useCallback, useEffect, useRef, useState } from "react";
import { FocusBlock, FocusHeader, MenuRow, type FocusRoute } from "./focus-ui.js";
type Request = <T>(route: string, body?: unknown) => Promise<T>;
interface Question { id: string; question: string; version: number; attribution_version: number; source_hash: string; local_document_id: string; document_id: string; display_title: string }
interface Project { id: string; display_name: string }
interface ProjectDetail { project: Project; quotes: { id: string; version: number }[]; money: { confirmed_cost: string | null; receivable: string | null; payable: string | null } }
interface Report { events: Record<string, unknown>[]; human_events: number | null; active_ms: number | null; task_completed: null; truncated: boolean; interpretation: string }

export function FieldToday({ request, open }: { request: Request; open: (id: string) => void }) {
  const [items, setItems] = useState<Question[]>([]), [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState(""), [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const inFlight = useRef(false), retries = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    const [q, p] = await Promise.all([request<{ items: Question[] }>("field/today"), request<{ projects: Project[] }>("field/projects")]);
    setItems(q.items); setProjects(p.projects); setSelected(""); setCurrent(0); setError("");
  }, [request]);
  useEffect(() => { let live = true; void load().catch(() => { if (live) setError("답할 일을 가져오지 못했어요."); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [load]);
  const question = items[current];
  const actor = new URLSearchParams(location.search).get("actor") === "agent_test" ? "agent_test" : "human";
  async function answer(choice: string) {
    if (!question || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    const signature = JSON.stringify([question.id, question.version, question.attribution_version, choice, selected]);
    let key = retries.current.get(signature); if (!key) { key = crypto.randomUUID(); retries.current.set(signature, key); }
    try {
      await request(`field/questions/${question.id}/answer`, { key, answer: { version: question.version, attribution_version: question.attribution_version, source_hash: question.source_hash, choice, project_id: choice === "project" ? selected : null, actor } });
      retries.current.delete(signature);
      void request("field/events", { screen: "today", control: choice === "project" ? "answer" : choice, actor, task_id: question.id, document_id: question.document_id }).catch(() => {});
      setMessage(choice === "project" ? "이 현장 자료로 모았어요. 돈이나 완료 여부는 그대로예요." : "내일 다시 보여 드릴게요.");
      // Hide the answered question immediately, even if refreshing later fails.
      setItems(list => list.filter(item => item.id !== question.id)); setCurrent(0); setSelected("");
      await load().catch(() => setError("답은 저장했어요. 다음 질문을 가져오지 못했어요."));
    } catch (e) {
      setError((e as Error).message.includes("바뀌었") ? "자료가 바뀌었어요. 다시 살펴봐 주세요." : "저장을 확인하지 못했어요. 다시 누르면 이어서 확인해요.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <FocusBlock>
    {loading ? <p>답할 일을 가져오고 있어요.</p> : question ? <>
      <p className="eyebrow">확인할 일 {current + 1} / {items.length}</p><h2>{question.question}</h2><p data-record="true">{question.display_title}</p>
      {!projects.length && <p>현장 목록이 준비되면 고를 수 있어요.</p>}
      <button type="button" className="text-button" disabled={busy} onClick={() => open(question.local_document_id)}>자료 먼저 보기</button>
      {projects.length > 0 && <><label htmlFor="field-project">현장 이름</label><select id="field-project" value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
        <option value="">현장을 골라주세요</option>{projects.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select>
      <button type="button" className="primary" data-primary="true" disabled={busy || !selected} onClick={() => void answer("project")}>이 현장 일이에요</button></>}
      <div className="quiet-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void answer("unknown")}>잘 모르겠어요</button><button type="button" className="text-button" disabled={busy} onClick={() => void answer("later")}>내일 볼게요</button></div>
      {items.length > 1 && <button type="button" className="text-button full-width" disabled={busy} onClick={() => { setCurrent(n => (n + 1) % items.length); setSelected(""); }}>다른 질문 보기</button>}
    </> : !error ? <><h2>새로 답할 일이 없어요</h2><p>읽은 자료에서 필요한 일을 준비해요.</p></> : null}
    {message && <p className="receipt notice" role="status">{message}</p>}{error && <><p className="error notice" role="alert">{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => { setLoading(true); void load().catch(() => setError("답할 일을 가져오지 못했어요.")).finally(() => setLoading(false)); }}>다시 불러오기</button></>}
  </FocusBlock>;
}

export function formatFieldMoney(value: string | null) { return value === null || !/^-?\d+$/.test(value) ? "아직 확인 못했어요" : `${BigInt(value).toLocaleString("ko-KR")}원`; }
export function FieldProjects({ request, route, go }: { request: Request; route: FocusRoute; go: (route: FocusRoute) => void }) {
  const [items, setItems] = useState<Project[]>([]), [detail, setDetail] = useState<ProjectDetail | null>(null);
  const view = ["project", "money", "quotes"].includes(route.view) ? route.view : "list";
  const setView = (next: "list" | "project" | "money" | "quotes") => go({ tab: "projects", view: next === "list" ? "home" : next, id: next === "list" ? "" : route.id });
  const [query, setQuery] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => { void request<{ projects: Project[] }>("field/projects").then(r => setItems(r.projects)).catch(() => setError("현장을 가져오지 못했어요.")).finally(() => setLoading(false)); }, [request]);
  useEffect(() => {
    if (!route.id || view === "list") return;
    let live = true; setBusy(true); setError(""); setDetail(null);
    void request<ProjectDetail>(`field/projects/${route.id}`).then(next => { if (live) setDetail(next); }).catch(() => { if (live) setError("이 현장을 읽지 못했어요."); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [request, route.id, view]);
  const choose = (id: string) => go({ tab: "projects", view: "project", id });
  const quotes = async (id: string) => { setBusy(true); setError(""); try { await saveDownload(`/api/field/quotes/${id}/pdf`, "견적서.pdf", "POST"); } catch { setError("승인한 견적을 만들지 못했어요."); } finally { setBusy(false); } };
  return <>{error && <p className="error notice" role="alert">{error}</p>}{view === "list" ? <>
    <FocusBlock className="search-block"><label htmlFor="project-search">현장 찾기</label><input id="project-search" type="search" value={query} onChange={e => setQuery(e.target.value)} /></FocusBlock>
    <FocusBlock>{loading ? <p>현장을 가져오고 있어요.</p> : items.filter(p => p.display_name.includes(query)).map(p => <MenuRow key={p.id} title={p.display_name} onClick={() => void choose(p.id)} disabled={busy} />)}
      {!loading && !items.length && !error && <p>아직 등록된 현장이 없어요.</p>}{!loading && items.length > 0 && !items.some(p => p.display_name.includes(query)) && <p>다른 이름으로 찾아보세요.</p>}</FocusBlock></>
    : <><button type="button" className="text-button back" onClick={() => setView(view === "project" ? "list" : "project")}>← {view === "project" ? "현장 목록" : "현장으로"}</button>{!detail ? <FocusBlock><p>{error ? "다시 현장을 골라주세요." : "현장을 가져오고 있어요."}</p></FocusBlock> :
      <FocusBlock><h2 data-record="true">{detail.project.display_name}</h2>{view === "project" ? <><MenuRow title="비용과 받을 돈" note="근거를 확인한 내역" onClick={() => setView("money")} /><MenuRow title="승인한 견적" onClick={() => setView("quotes")} /></>
        : view === "money" ? <><dl><dt>확인된 비용</dt><dd className="money-value">{formatFieldMoney(detail.money.confirmed_cost)}</dd><dt>받을 돈</dt><dd className="money-value">{formatFieldMoney(detail.money.receivable)}</dd><dt>줄 돈</dt><dd className="money-value">{formatFieldMoney(detail.money.payable)}</dd></dl><p className="muted">전체 정산이 끝났다는 뜻은 아니에요.</p></>
        : detail.quotes.length ? detail.quotes.map((q, i) => <MenuRow key={q.id} title={`견적서 ${i + 1} · ${q.version}차`} note="승인한 PDF 내려받기" disabled={busy} onClick={() => void quotes(q.id)} />) : <p>아직 승인한 견적이 없어요.</p>}</FocusBlock>}</>}</>;
}

async function saveDownload(path: string, name: string, method = "GET") {
  const response = await fetch(path, { method, headers: { "X-Sigongnote-Local": "1" } });
  if (!response.ok) throw new Error("파일을 내려받지 못했어요. 로그인과 기간을 확인해 주세요.");
  const url = URL.createObjectURL(await response.blob()), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function FieldAdmin({ request }: { request: Request }) {
  const [backup, setBackup] = useState(""), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [report, setReport] = useState<Report | null>(null);
  const [view, setView] = useState<"home" | "period" | "events" | "backup">("home");
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const [from, setFrom] = useState(today), [to, setTo] = useState(today);
  const [applied, setApplied] = useState({ from: today, to: today });
  const load = async () => { setReport(await request<Report>(`admin/report?from=${from}&to=${to}`)); setApplied({ from, to }); setView("home"); };
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="app-shell focus-app"><main className="content"><FocusHeader title={view === "period" ? "기록을 볼 기간" : view === "events" ? "사용 흐름" : view === "backup" ? "이 PC의 백업" : "운영자 기록"} />
    {!report ? <FocusBlock><form onSubmit={e => { e.preventDefault(); void act(async () => { await request("admin/login", { email, password }); setPassword(""); await load(); }); }}>
      <label htmlFor="admin-email">이메일</label><input id="admin-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
      <label htmlFor="admin-password">비밀번호</label><input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
      <button className="primary" data-primary="true" type="submit" disabled={busy}>로그인</button></form></FocusBlock>
      : view === "period" ? <FocusBlock><form onSubmit={e => { e.preventDefault(); void act(load); }}><label htmlFor="admin-from">시작일</label><input id="admin-from" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} required /><label htmlFor="admin-to">종료일</label><input id="admin-to" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} required /><button type="submit" className="primary" data-primary="true" disabled={busy}>기간 적용</button></form></FocusBlock>
      : view === "backup" ? <FocusBlock><p>자료 목록과 참조하는 최신본·수정본 사본을 이 PC의 백업 폴더에 보관해요.</p><p>아래에서 내려받는 파일은 색인만 포함해요. 사본이 든 백업 폴더와 서버 장부는 별도로 보관해야 해요.</p><p>복구할 때 이 Windows 계정과 암호키가 필요해요.</p>
        <button type="button" className="primary" data-primary="true" disabled={busy} onClick={() => void act(async () => { const b = await request<{ download: string; verified:{missingCount:number} }>("admin/backup", {}); await saveDownload(b.download, "시공노트-색인.sgnbackup"); setBackup(b.verified.missingCount?`색인은 내려받았지만 원문 사본 ${b.verified.missingCount}건을 보관하지 못했어요. 나머지 사본은 이 PC의 백업 폴더에 있어요. 전체 백업은 미완료입니다.`:"색인을 내려받았어요. 원문 사본은 이 PC의 백업 폴더에 있어요."); })}>백업 만들고 색인 내려받기</button>{backup && <p role="status">{backup}</p>}</FocusBlock>
      : view === "events" ? <FocusBlock><ul className="plain-list">{report.events.slice(-100).map(e => <li key={String(e.event_id)}>{new Date(String(e.received_at)).toLocaleString("ko-KR")} · {e.actor === "agent_test" ? "자동 검증" : "사용자"} · {({ answer: "답변", later: "나중에", unknown: "모름", evidence_open: "자료 보기", screen_enter: "화면 열기", screen_exit: "화면 닫기", search: "검색" } as Record<string, string>)[String(e.control_id)] ?? "앱 사용"}</li>)}</ul></FocusBlock>
      : <><FocusBlock><p className="muted">{applied.from} ~ {applied.to}</p><dl><dt>사람의 행동</dt><dd>{report.human_events ?? "아직 관측 없음"}</dd><dt>사람의 활동시간</dt><dd>{report.active_ms === null ? "아직 관측 없음" : `${Math.round(report.active_ms / 1000)}초`}</dd></dl><p>완료한 업무 수는 아직 측정하지 못해요.</p><p className="muted">자동 검증은 사람의 성과에서 제외해요.</p>{report.truncated && <p className="attention">1만 건을 넘었어요. 기간을 줄여 주세요.</p>}
        <button type="button" className="primary" data-primary="true" onClick={() => setView("period")}>기간 바꾸기</button></FocusBlock>
        <FocusBlock><MenuRow title="사용 흐름" onClick={() => setView("events")} /><MenuRow title="사용 기록 내려받기" note="보고서 CSV · 복구용은 아니에요" disabled={busy} onClick={() => void act(() => saveDownload(`/api/admin/report.csv?from=${applied.from}&to=${applied.to}`, "시공노트-사용기록.csv"))} /><MenuRow title="백업" onClick={() => setView("backup")} /></FocusBlock></>}
    {error && <p className="error notice" role="alert">{error}</p>}{view !== "home" && <button type="button" className="text-button full-width" disabled={busy} onClick={() => setView("home")}>운영자 기록으로</button>}
    <a className="menu-row" href={`/${location.search}`}>내 업무로 돌아가기</a></main></div>;
}
