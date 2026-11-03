import { useEffect, useState, type ReactNode } from "react";
import type { Tab } from "./navigation.js";

export type FocusView = "home" | "document" | "read" | "site" | "actions" | "ai" | "copies" | "prepare" | "settings" | "folders" | "folder" | "guide" | "project" | "money" | "quotes";
export interface FocusRoute { tab: Tab; view: FocusView; id: string }
const views = new Set<FocusView>(["home", "document", "read", "site", "actions", "ai", "copies", "prepare", "settings", "folders", "folder", "guide", "project", "money", "quotes"]);
const needsId = new Set<FocusView>(["document", "read", "site", "actions", "ai", "copies", "prepare", "folder", "project", "money", "quotes"]);
export function readFocusRoute(hash: string): FocusRoute {
  const [rawTab, rawView, rawId = ""] = hash.replace(/^#/, "").split("/");
  const tab = rawTab === "projects" || rawTab === "materials" ? rawTab : "today";
  const view = views.has(rawView as FocusView) ? rawView as FocusView : "home";
  const id = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(rawId) ? rawId : "";
  return { tab, view: needsId.has(view) && !id ? "home" : view, id };
}
export function focusHash(route: FocusRoute) { return `#${route.tab}/${route.view}${route.id ? `/${route.id}` : ""}`; }

export function FocusHeader({ title, note, back }: { title: string; note?: string; back?: () => void }) {
  return <header className="focus-heading">
    {back && <button type="button" className="text-button back" onClick={back}>← 돌아가기</button>}
    <h1 tabIndex={-1}>{title}</h1>{note && <p className="muted">{note}</p>}
  </header>;
}
export function FocusBlock({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section data-chunk="true" className={`focus-block ${className}`}>{children}</section>;
}
export function MenuRow({ title, note, onClick, disabled = false }: { title: string; note?: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="menu-row" disabled={disabled} onClick={onClick}>
    <span><strong>{title}</strong>{note && <span className="muted">{note}</span>}</span><span aria-hidden="true">›</span>
  </button>;
}
export const guideSteps = [
  { title: "업무자료부터 준비", text: "업무 폴더를 고르면 새 자료를 살펴봐요. 원본은 바꾸지 않아요.", action: "폴더 고르기" },
  { title: "오늘, 한 가지만 답해요", text: "자료를 보고 필요한 질문을 준비해요. 모르면 나중에 답해도 돼요.", action: "오늘 보기" },
  { title: "지난 자료도 쉽게", text: "현장 이름이나 기억나는 말로 찾아요. 사용법은 도움말에서 다시 볼 수 있어요.", action: "자료 찾기" },
] as const;
export function Guide({ go, close, hasFolder }: { go: (step: number) => void; close: () => void; hasFolder: boolean }) {
  const [step, setStep] = useState(0);
  const current = guideSteps[step] ?? guideSteps[0];
  useEffect(() => { void step; document.querySelector<HTMLElement>("main h1")?.focus(); }, [step]);
  return <>
    <FocusHeader title={current.title} note={`사용법 ${step + 1} / 3`} back={close} />
    <FocusBlock><div className="guide-symbol" aria-hidden="true">{["01", "02", "03"][step]}</div>
      <p className="guide-copy">{current.text}</p>
      <button type="button" className="primary" data-primary="true" onClick={() => go(step)}>{step === 0 && hasFolder ? "내 폴더 보기" : current.action}</button>
      <button type="button" className="text-button full-width" onClick={() => step < 2 ? setStep(step + 1) : close()}>{step < 2 ? "다음 사용법" : "닫기"}</button>
    </FocusBlock>
  </>;
}
