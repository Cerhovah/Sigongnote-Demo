import { useEffect, useRef, useState } from "react";
import { answerOutcome, emptySession, followUpText, questions, remainingQuestions, waitingQuestions,
  type Answer, type DemoAction, type DemoSession, type Question } from "./demo-session.js";

export const fixtureToday = { items: questions, latestSourceAt: null as string | null,
  missingSources: ["휴대폰 문자·사진", "업무 폴더"] };

export function SourceExcerpt({ sources }: { sources: Question["sources"] }) {
  return <details className="sources"><summary>무엇을 보고 물어보나요?</summary>
    <p className="muted">아래는 체험을 위해 만든 자료예요.</p>
    {sources.map(source => <div className="source-excerpt" key={source.title}>
      <strong>{source.title}</strong><blockquote>{source.excerpt}</blockquote>
      {source.partial && <p className="muted">알림에 보인 일부 내용이에요. 전체 문자는 보지 못했어요.</p>}
    </div>)}
  </details>;
}

export function QuestionCard({ item, answer, onAnswer, onUndo, onNext, history = [] }: {
  item: Question; answer?: Answer; onAnswer: (answer: Answer) => void; onUndo: () => void;
  onNext: () => void; history?: DemoSession["history"];
}) {
  const [editing, setEditing] = useState(false);
  const [quantityOpen, setQuantityOpen] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(answer);
  const outcome = answer && !editing ? answerOutcome(item, answer) : null;
  useEffect(() => {
    if (previous.current !== answer) heading.current?.focus();
    previous.current = answer;
  }, [answer]);
  useEffect(() => {
    if (quantityOpen) document.getElementById("received-quantity")?.focus();
    else if (editing) heading.current?.focus();
  }, [editing, quantityOpen]);
  function submit(value: Answer) { setEditing(false); setQuantityOpen(false); onAnswer(value); }
  return <article className={`question-card${outcome ? " answered" : ""}`} aria-labelledby="question-title">
    <div className="card-context"><span>{item.project} · {item.work}</span><span className="deadline">{item.when}</span></div>
    {outcome ? <>
      <p className="receipt-label">예시에 답을 남겼어요</p>
      <h2 id="question-title" ref={heading} tabIndex={-1}>{outcome.summary}</h2>
      <p className="consequence" role="status">{outcome.consequence}</p>
      <button type="button" className="primary" onClick={onNext}>다음 질문 보기 <span aria-hidden="true">→</span></button>
      <div className="quiet-actions">
        <button type="button" className="text-button" onClick={() => { setEditing(true); setQuantity(answer?.quantity?.toString() ?? ""); }}>답 고치기</button>
        <button type="button" className="text-button" onClick={onUndo}>답변 취소</button>
      </div>
      {history.length > 1 && <details className="sources"><summary>어떻게 답했었나요?</summary><ol className="answer-history">
        {history.map(entry => <li key={entry.sequence}>
          {entry.after ? answerOutcome(item, entry.after).summary : "답변을 취소했어요."}</li>)}
      </ol></details>}
    </> : <>
      <h2 id="question-title" ref={heading} tabIndex={-1}>{quantityOpen ? "문틀을 몇 개 받으셨나요?" : item.question}</h2>
      <p className="question-reason">{item.reason}</p>
      {quantityOpen ? <form onSubmit={event => {
        event.preventDefault();
        if (!/^\d{1,5}$/.test(quantity)) { setError("받은 개수를 0부터 99,999 사이의 숫자로 적어주세요."); return; }
        submit({ choice: "quantity", quantity: Number(quantity) });
      }}>
        <label className="input-label" htmlFor="received-quantity">실제로 받은 개수</label>
        <div className="quantity-input"><input id="received-quantity" inputMode="numeric" value={quantity}
          aria-invalid={Boolean(error)} aria-describedby={error ? "quantity-error" : undefined}
          onChange={event => { setQuantity(event.target.value); setError(""); }} autoComplete="off" /><span>개</span></div>
        {error && <p id="quantity-error" className="error" role="alert">{error}</p>}
        <button type="submit" className="primary">이 수량으로 답하기</button>
        <button type="button" className="text-button" onClick={() => setQuantityOpen(false)}>수량 입력 닫기</button>
      </form> : <div className="answer-buttons">
        <button type="button" className="primary" onClick={() => submit({ choice: "yes" })}>{item.yes}</button>
        <button type="button" className="secondary" onClick={() => item.quantity === undefined ?
          submit({ choice: "no" }) : setQuantityOpen(true)}>{item.no}</button>
        <div className="quiet-actions answer-escape">
          <button type="button" className="text-button" onClick={() => submit({ choice: "unknown" })}>잘 모르겠어요</button>
          <button type="button" className="text-button" onClick={() => submit({ choice: "later" })}>오후에 볼게요</button>
        </div>
      </div>}
      {editing && <button type="button" className="text-button" onClick={() => { setEditing(false); setQuantityOpen(false); }}>이전 답 그대로 두기</button>}
    </>}
    <SourceExcerpt sources={item.sources} />
  </article>;
}

export function TodayView({ data = fixtureToday, session = emptySession, selectedId, onSelect = () => {}, onAction = () => {} }: {
  data?: typeof fixtureToday; session?: DemoSession; selectedId?: string;
  onSelect?: (id: string) => void; onAction?: (action: DemoAction) => void;
}) {
  const remaining = remainingQuestions(data.items, session);
  const waiting = waitingQuestions(data.items, session);
  const unanswered = remaining.filter(item => !session.answers[item.id]);
  const selected = data.items.find(item => item.id === selectedId);
  const item = selected ?? (selectedId === "summary" ? undefined : unanswered[0]);
  const otherQuestions = remaining.filter(other => other.id !== item?.id);
  const answered = data.items.filter(other => session.answers[other.id] && session.answers[other.id]?.choice !== "later");
  return <>
    <div className="page-heading"><p className="eyebrow">오늘</p>
      <h1 tabIndex={-1}>무엇부터 확인할까요?</h1><p className="muted">{remaining.length ? `답을 기다리는 질문 ${remaining.length}개` : data.items.length ? "준비된 질문에 모두 답했어요" : "아직 업무 자료를 가져오지 못했어요"}</p></div>
    {item ? <QuestionCard key={item.id} item={item} {...(session.answers[item.id] ? { answer: session.answers[item.id] } : {})}
      history={session.history.filter(entry => entry.id === item.id)}
      onAnswer={answer => { onAction({ type: "answer", id: item.id, answer }); onSelect(item.id); }}
      onUndo={() => onAction({ type: "undo", id: item.id })}
      onNext={() => onSelect(unanswered.find(other => other.id !== item.id)?.id ?? "summary")} /> :
      <section className="question-card empty">
        <h2>{remaining.length ? "나중에 답할 질문이 남아 있어요." : data.items.length ? "지금 답하실 질문은 없어요." : "살펴볼 자료가 있나요?"}</h2>
        <p>{data.items.length ? `답한 뒤에도 챙겨야 할 일은 ${waiting.length}개예요.` :
          "아직 업무 자료를 가져오지 못했어요. 확인할 일이 없는지는 알 수 없어요."}</p>
        <p className="muted">새로고침하면 처음부터 다시 체험할 수 있어요.</p>
      </section>}
    {otherQuestions.length > 0 && <section className="queue-section" aria-labelledby="queue-title">
      <h2 id="queue-title">함께 확인할 일 <span>{otherQuestions.length}</span></h2>
      <ul className="plain-list">{otherQuestions.map(other => <li key={other.id}>
        <button type="button" className="list-link" onClick={() => onSelect(other.id)}>
          <span><strong>{other.project}</strong><span>{other.question}</span></span>
          <span className="list-meta">{session.answers[other.id]?.choice === "later" ? "오후에 다시" : other.when}<span aria-hidden="true"> ›</span></span>
        </button></li>)}</ul>
    </section>}
    {waiting.length > 0 && <section className="queue-section" aria-labelledby="followup-title">
      <h2 id="followup-title">답한 뒤에도 남은 일 <span>{waiting.length}</span></h2>
      <ul className="plain-list">{waiting.map(other => <li key={other.id}><button type="button" className="list-link" onClick={() => onSelect(other.id)}>
        <span><strong>{other.project} · {other.work}</strong><span>{followUpText(other, session.answers[other.id] as Answer)}</span></span><span aria-hidden="true">›</span>
      </button></li>)}</ul>
    </section>}
    {answered.length > 0 && <details className="past-answers"><summary>내가 답한 내용 {answered.length}개 · 다시 보기</summary>
      <ul className="plain-list">{answered.map(other => <li key={other.id}><button type="button" className="list-link" onClick={() => onSelect(other.id)}>
        <span><strong>{other.project}</strong><span>{answerOutcome(other, session.answers[other.id] as Answer).summary}</span></span><span aria-hidden="true">›</span>
      </button></li>)}</ul></details>}
    <details className="capture-note"><summary>어떤 자료를 보고 있나요?</summary>
      <p>지금은 예시 자료만 보고 있어요. 실제 업무 자료를 자동으로 가져오지는 않아요.</p>
      <p>아직 가져오지 않는 자료: {data.missingSources.join(" · ") || "표시할 항목 없음"}</p>
      <p>최근 업무 자료를 가져온 때: {data.latestSourceAt ?? "아직 없음"}</p>
    </details>
  </>;
}
