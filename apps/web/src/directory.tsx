import { useState } from "react";
import { answerOutcome, emptySession, followUpText, questions, type DemoSession } from "./demo-session.js";

type Material = { id: string; projectId: string | null; title: string; context: string; excerpt: string; term: string; partial?: boolean };
export type DirectoryData = { projects: { id: string; name: string; hint: string }[]; evidence: Material[] };
export const fixtureDirectory: DirectoryData = {
  projects: [
    { id: "project-1", name: "가람 현장", hint: "서쪽 3층 · 문틀 납품" },
    { id: "project-2", name: "새빛 현장", hint: "동쪽 출입문 · 보수 작업" },
    { id: "project-3", name: "한결 현장", hint: "욕실 · 타일 작업" },
    { id: "project-4", name: "마루 현장", hint: "장비 대여" },
  ],
  evidence: [
    { id: "e-1", projectId: "project-1", title: "자재 납품서", context: "가람 현장 · 3층 문틀",
      excerpt: "문틀 25개를 납품한다는 내용이에요. 이 서류에는 현장에서 실제로 받은 수량은 적혀 있지 않아요.", term: "가람 문틀 25개 납품서" },
    { id: "e-2", projectId: "project-2", title: "보수 작업 내역과 청구서", context: "새빛 현장 · 문 보수",
      excerpt: "두 서류에 각각 150,000원이 적혀 있어요. 서류만으로는 같은 작업인지 알 수 없어요.", term: "새빛 보수 비용 청구서" },
    { id: "e-3", projectId: null, title: "9월 자재 단가표", context: "여러 현장에서 참고하는 가격",
      excerpt: "자재 가격을 참고하는 문서예요. 이번 납품에 적용할 가격은 거래 약속을 확인해야 해요.", term: "단가 가격 자재" },
    { id: "e-4", projectId: null, title: "문틀 규격 안내", context: "제품 크기와 설치 조건",
      excerpt: "문틀 크기와 설치 조건을 설명하는 문서예요. 이 문서만으로 실제 납품이나 작업을 알 수는 없어요.", term: "문틀 제품 규격 도면" },
    { id: "e-5", projectId: null, title: "자재를 내려놓은 사진", context: "어느 현장인지는 아직 몰라요",
      excerpt: "자재가 놓여 있는 사진을 가정한 예시예요. 현장 이름을 알 수 없어 다른 현장 사진에 섞지 않았어요.", term: "사진 자재" },
    { id: "e-6", projectId: "project-3", title: "타일 작업 알림", context: "한결 현장 · 욕실",
      excerpt: "오늘 욕실 타일 작업 예정입니다.", term: "한결 타일 일정 문자", partial: true },
    { id: "e-7", projectId: "project-4", title: "장비 대여 내역", context: "마루 현장",
      excerpt: "오늘 지급할 예정이라는 내용이에요. 금액과 이체내역은 아직 없어요.", term: "마루 장비 대여 지급" },
  ],
};
export function searchMaterials(data: DirectoryData, query: string) {
  const phrase = query.normalize("NFKC").toLocaleLowerCase("ko-KR").trim();
  return data.evidence.filter(item => !phrase ||
    (`${item.title} ${item.context} ${item.term}`).normalize("NFKC").toLocaleLowerCase("ko-KR").includes(phrase));
}

export function DirectoryView({ mode, data = fixtureDirectory, session = emptySession, selectedId,
  onOpenProject = () => {}, onOpenEvidence = () => {}, onOpenQuestion = () => {}, onBack = () => {} }: {
  mode: "projects" | "materials"; data?: DirectoryData; session?: DemoSession; selectedId?: string;
  onOpenProject?: (id: string) => void; onOpenEvidence?: (id: string) => void;
  onOpenQuestion?: (id: string) => void; onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  const project = mode === "projects" ? data.projects.find(item => item.id === selectedId) : undefined;
  const evidence = mode === "materials" ? data.evidence.find(item => item.id === selectedId) : undefined;
  const projectQuestions = questions.filter(item => item.projectId === project?.id);
  function materialList(items: Material[]) {
    return <ul className="plain-list material-list">{items.map(item => <li key={item.id}>
      <button className="list-link" type="button" onClick={() => onOpenEvidence(item.id)}>
        <span><strong>{item.title}</strong><span>{item.context}</span></span><span aria-hidden="true">›</span>
      </button></li>)}</ul>;
  }
  return evidence ? <>
    <button className="text-button back" type="button" onClick={onBack}>← 자료 목록</button>
    <div className="page-heading"><p className="eyebrow">{evidence.context}</p><h1 tabIndex={-1}>어떤 내용이 있었나요?</h1></div>
    <article className="document-preview"><p className="receipt-label">예시 자료에서 읽은 내용</p><h2>{evidence.title}</h2>
      <blockquote>{evidence.excerpt}</blockquote>
      {evidence.partial && <p className="muted">알림에 보인 일부예요. 전체 문자는 보지 못했어요.</p>}
      <p className="muted">원본 파일을 대신하는 문서는 아니에요.</p>
    </article>
    {evidence.projectId && <button type="button" className="secondary" onClick={() => onOpenProject(evidence.projectId as string)}>이 현장 살펴보기</button>}
  </> : mode === "projects" ? project ? <>
    <button className="text-button back" type="button" onClick={onBack}>← 현장 목록</button>
    <div className="page-heading"><p className="eyebrow">{project.name} · {project.hint}</p><h1 tabIndex={-1}>지금 무슨 일이 남았나요?</h1></div>
    {projectQuestions.map(question => {
      const answer = session.answers[question.id];
      const outcome = answer ? answerOutcome(question, answer) : null;
      return <section className="project-question" key={question.id}>
        <p className="eyebrow">{question.work}</p><h2>{outcome?.summary ?? question.question}</h2>
        <p>{outcome?.consequence ?? question.reason}</p>
        {answer && outcome?.needsEvidence && answer.choice !== "later" && <p className="next-step">{followUpText(question, answer)}</p>}
        <button type="button" className="primary" onClick={() => onOpenQuestion(question.id)}>
          {answer ? "답한 내용 다시 보기" : "여기에 답하기"}</button>
      </section>;
    })}
    <section className="money-section"><h2>받을 돈과 줄 돈은 얼마인가요?</h2>
      <dl><div><dt>받을 돈</dt><dd>아직 계산 전</dd></div><div><dt>줄 돈</dt><dd>아직 계산 전</dd></div>
        {project.id === "project-2" && ["yes", "no"].includes(session.answers.duplicate?.choice ?? "") &&
          <div><dt>이 보수에 들어간 비용 · 예시</dt><dd>{session.answers.duplicate?.choice === "yes" ? "150,000원" : "300,000원"}</dd></div>}
      </dl>
      <p className="muted">금액과 실제 주고받은 내역이 더 필요해요.</p>
    </section>
    <section className="queue-section"><h2>어떤 서류가 왔나요?</h2>{materialList(data.evidence.filter(item => item.projectId === project.id))}</section>
  </> : <>
    <div className="page-heading"><p className="eyebrow">현장</p><h1 tabIndex={-1}>어느 현장이 궁금하세요?</h1></div>
    <ul className="plain-list project-list">{data.projects.map(item => {
      const outstanding = questions.filter(question => question.projectId === item.id &&
        (!session.answers[question.id] || session.answers[question.id]?.choice === "later")).length;
      return <li key={item.id}><button className="list-link" type="button" onClick={() => onOpenProject(item.id)}>
        <span><strong>{item.name}</strong><span>{item.hint}</span></span>
        <span className="list-meta">{outstanding ? `답할 질문 ${outstanding}개` : "답한 내용 보기"}<span aria-hidden="true"> ›</span></span>
      </button></li>;
    })}</ul>
  </> : <>
    <div className="page-heading"><p className="eyebrow">자료</p><h1 tabIndex={-1}>어떤 자료를 찾으세요?</h1></div>
    <label className="input-label" htmlFor="material-search">기억나는 현장이나 물건 이름</label>
    <input id="material-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
      placeholder="예: 가람, 문틀, 단가" autoComplete="off" />
    <p className="muted search-count" role="status">{query.trim() ? `찾은 자료 ${searchMaterials(data, query).length}개` : "체험용 서류와 사진이에요."}</p>
    {searchMaterials(data, query).length ? materialList(searchMaterials(data, query)) :
      <p className="empty">이 이름으로는 찾지 못했어요. 다른 이름으로 찾아보세요.</p>}
  </>;
}
