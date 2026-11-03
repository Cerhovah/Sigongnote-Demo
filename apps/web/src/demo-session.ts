// Synthetic rehearsal only. Never use this reducer to authorize real ledger mutations.
export type Choice = "yes" | "no" | "quantity" | "later" | "unknown";
export type Question = {
  id: string; projectId: string; project: string; work: string; when: string;
  question: string; reason: string; yes: string; no: string; quantity?: number;
  sources: { title: string; excerpt: string; partial?: boolean }[];
  outcomes: { yes: Outcome; no: Outcome };
};
export type Outcome = { summary: string; consequence: string; needsEvidence: boolean };
export type Answer = { choice: Choice; quantity?: number };
export type DemoSession = { answers: Record<string, Answer>; history: { sequence: number; id: string; before: Answer | null; after: Answer | null }[] };
export type DemoAction = { type: "answer"; id: string; answer: Answer } | { type: "undo"; id: string };
export const emptySession: DemoSession = { answers: {}, history: [] };

export const questions: Question[] = [
  { id: "ready", projectId: "project-3", project: "한결 현장", work: "욕실 타일", when: "오늘 작업 전",
    question: "타일 붙일 바탕이 준비됐나요?", reason: "오늘 작업 예정이에요. 바탕이 준비돼야 다시 오는 일을 줄일 수 있어요.",
    yes: "네, 준비됐어요", no: "아직 준비 안 됐어요",
    sources: [{ title: "현장 담당자의 알림", excerpt: "오늘 욕실 타일 작업 예정입니다.", partial: true }],
    outcomes: {
      yes: { summary: "바탕이 준비됐다고 적어뒀어요.", consequence: "작업을 시작할 조건에 반영해 두었어요. 타일 시공이 끝났다는 뜻은 아니에요.", needsEvidence: false },
      no: { summary: "바탕 준비를 기다린다고 적어뒀어요.", consequence: "준비됐다는 소식이 올 때까지 이 일은 남겨둘게요. 재방문 비용은 아직 알 수 없어요.", needsEvidence: true },
    } },
  { id: "delivery", projectId: "project-1", project: "가람 현장", work: "3층 문틀 납품", when: "오늘 청구 전",
    question: "문틀 25개, 모두 받으셨나요?", reason: "받은 수량을 맞춰두면 대금을 확인할 때 빠뜨리지 않을 수 있어요.",
    yes: "네, 25개 다 받았어요", no: "받은 수량이 달라요", quantity: 25,
    sources: [{ title: "자재 납품서", excerpt: "가람 현장 · 3층 문틀 · 납품 수량 25개" }],
    outcomes: {
      yes: { summary: "문틀 25개를 받았다고 적어뒀어요.", consequence: "받은 수량을 남겼어요. 비용과 청구 금액은 거래 약속과 단가를 더 확인해야 해요.", needsEvidence: false },
      no: { summary: "받은 수량이 다르다고 적어뒀어요.", consequence: "납품 담당자에게 실제 받은 수량을 확인할 일이 남아 있어요.", needsEvidence: true },
    } },
  { id: "duplicate", projectId: "project-2", project: "새빛 현장", work: "문 보수", when: "비용 계산 전",
    question: "이 두 내역은 같은 보수 작업인가요?", reason: "각각 150,000원이에요. 같은 작업이면 비용을 한 번만 계산해야 해요.",
    yes: "네, 같은 작업이에요", no: "아니요, 별개 작업이에요",
    sources: [{ title: "보수 작업 내역", excerpt: "새빛 현장 · 문 보수 · 150,000원" },
      { title: "보수 비용 청구서", excerpt: "새빛 현장 · 문 보수 · 150,000원" }],
    outcomes: {
      yes: { summary: "같은 작업이라고 적어뒀어요.", consequence: "예시 비용은 150,000원 한 번만 계산했어요. 두 서류는 모두 보관해요.", needsEvidence: false },
      no: { summary: "별개 작업이라고 적어뒀어요.", consequence: "예시 비용은 두 건, 합계 300,000원이에요. 실제로 보낸 돈과는 구분해요.", needsEvidence: false },
    } },
  { id: "payment", projectId: "project-4", project: "마루 현장", work: "예시 장비업체 · 9월 29일 대여", when: "오늘 지급 기한",
    question: "장비 대여비를 이미 보내셨나요?", reason: "이체내역을 아직 보지 못했어요. 다시 보내기 전에 여쭤봐요.",
    yes: "네, 이미 보냈어요", no: "아직 안 보냈어요",
    sources: [{ title: "장비 대여 내역", excerpt: "마루 현장 · 예시 장비업체 · 9월 29일 대여 · 오늘 지급 예정. 이체내역과 금액은 없어요." }],
    outcomes: {
      yes: { summary: "이미 보내셨다고 적어뒀어요.", consequence: "보냈다는 답을 남겼어요. 이체내역을 확인할 일이 남아 있고, 보낸 돈은 아직 계산하지 않아요.", needsEvidence: true },
      no: { summary: "아직 안 보내셨다고 적어뒀어요.", consequence: "금액과 받을 분을 확인할 일이 남아 있어요. 이 답변으로 돈이 보내지지는 않아요.", needsEvidence: true },
    } },
];

export function answerOutcome(question: Question, answer: Answer): Outcome {
  if (answer.choice === "unknown") return { summary: "잘 모르신다고 적어뒀어요.",
    consequence: "담당자에게 물어볼 일로 남겨둘게요. 이 체험에서는 실제 연락을 보내지 않아요.", needsEvidence: true };
  if (answer.choice === "later") return { summary: "오늘 오후에 다시 볼게요.",
    consequence: "확인할 일로 남아 있어요. 이 체험에서는 휴대폰 알림을 보내지 않아요.", needsEvidence: true };
  if (answer.choice === "quantity" && answer.quantity !== undefined) return {
    summary: `문틀 ${answer.quantity}개를 받았다고 적어뒀어요.`,
    consequence: answer.quantity === question.quantity ? question.outcomes.yes.consequence :
      `받은 ${answer.quantity}개를 남겼어요. 납품 담당자에게 다른 수량을 확인해 주세요. 금액은 거래 약속과 단가를 더 확인해야 해요.`,
    needsEvidence: answer.quantity !== question.quantity,
  };
  return answer.choice === "yes" ? question.outcomes.yes : question.outcomes.no;
}

export function demoReducer(session: DemoSession, action: DemoAction): DemoSession {
  const question = questions.find(item => item.id === action.id);
  if (!question) return session;
  const before = session.answers[action.id] ?? null;
  if (action.type === "undo") {
    if (!before) return session;
    const answers = { ...session.answers };
    delete answers[action.id];
    return { answers, history: [...session.history, { sequence: session.history.length + 1, id: action.id, before, after: null }] };
  }
  const answer = action.answer;
  if (answer.choice === "quantity" && (question.quantity === undefined || answer.quantity === undefined ||
      !Number.isSafeInteger(answer.quantity) || answer.quantity < 0 || answer.quantity > 99999)) return session;
  if (before?.choice === answer.choice && before.quantity === answer.quantity) return session;
  return { answers: { ...session.answers, [action.id]: answer },
    history: [...session.history, { sequence: session.history.length + 1, id: action.id, before, after: answer }] };
}

export function remainingQuestions(items: Question[], session: DemoSession) {
  return items.filter(item => !session.answers[item.id] || session.answers[item.id]?.choice === "later");
}

export function waitingQuestions(items: Question[], session: DemoSession) {
  return items.filter(item => {
    const answer = session.answers[item.id];
    return answer && answer.choice !== "later" && answerOutcome(item, answer).needsEvidence;
  });
}

export function followUpText(question: Question, answer: Answer): string {
  if (answer.choice === "unknown") return "담당자에게 물어볼 일이 남아 있어요.";
  if (question.id === "ready") return "현장 담당자와 오늘 작업 일정을 확인해 주세요.";
  if (question.id === "delivery") return "납품 담당자에게 다른 수량을 확인해 주세요.";
  if (question.id === "payment" && answer.choice === "no") return "금액과 받을 분을 확인하고, 오늘 지급 기한을 챙겨주세요.";
  return "보냈다는 답과 이체내역을 맞춰볼 일이 남아 있어요.";
}
