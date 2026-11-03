import type { ReactNode } from "react";
export type Tab = "today" | "projects" | "materials";
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "오늘", icon: "M5 4h14v17H5z M9 2v4 M15 2v4 M5 9h14 M9 14l2 2 4-4" },
  { id: "projects", label: "현장", icon: "M3 21h18 M5 21V9l7-5 7 5v12 M10 21v-7h4v7" },
  { id: "materials", label: "자료", icon: "M3 7h7l2 2h9v12H3z M3 7V4h7l2 3h7v2" },
];
export function Navigation({ active, onNavigate }: { active: Tab; onNavigate: (tab: Tab) => void }) {
  return <nav className="bottom-nav" aria-label="주요 메뉴">{tabs.map(tab =>
    <a key={tab.id} href={`#${tab.id}`} aria-current={active === tab.id ? "page" : undefined}
      onClick={event => { event.preventDefault(); onNavigate(tab.id); }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={tab.icon} /></svg>
      <span>{tab.label}</span></a>)}</nav>;
}
export function AppFrame({ active, onNavigate, children }: { active: Tab; onNavigate: (tab: Tab) => void; children: ReactNode }) {
  return <div className="app-shell">
    <button type="button" className="skip-link" onClick={() => document.getElementById("main-content")?.focus()}>본문으로 바로 가기</button>
    <div className="app-header"><header className="topbar"><strong className="brand"><span className="brand-mark" aria-hidden="true">시</span>시공노트</strong><span className="demo-badge">예시 체험</span></header>
      <div className="demo-note">실제 업무에는 반영되지 않아요.<br />새로고침하면 예시 답이 지워져요.</div></div>
    <main id="main-content" className="content" tabIndex={-1}>{children}</main>
    <Navigation active={active} onNavigate={onNavigate} />
  </div>;
}
