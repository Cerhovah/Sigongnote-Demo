import { useEffect, useReducer, useState } from "react";
import { demoReducer, emptySession } from "./demo-session.js";
import { DirectoryView } from "./directory.js";
import { AppFrame, type Tab } from "./navigation.js";
import { TodayView } from "./today.js";

export function readRoute(hash: string): { tab: Tab; id?: string } {
  const [tab, id] = hash.replace(/^#/, "").split("/");
  const validTab = tab === "projects" || tab === "materials" ? tab : "today";
  return id ? { tab: validTab, id } : { tab: validTab };
}
export function App() {
  const [route, setRoute] = useState(() => readRoute(typeof window === "undefined" ? "" : window.location.hash));
  const [session, dispatch] = useReducer(demoReducer, emptySession);
  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash === "#main-content") return;
      setRoute(readRoute(window.location.hash));
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);
  useEffect(() => {
    const selector = route.tab === "today" && route.id && route.id !== "summary" ? "#question-title" : "main h1";
    document.querySelector<HTMLElement>(selector)?.focus();
  }, [route]);
  function navigate(tab: Tab, id?: string) {
    const hash = `#${tab}${id ? `/${id}` : ""}`;
    setRoute(readRoute(hash));
    if (window.location.hash !== hash) window.location.hash = hash;
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  return <AppFrame active={route.tab} onNavigate={tab => navigate(tab)}>
    {route.tab === "today" ? <TodayView session={session} {...(route.id ? { selectedId: route.id } : {})}
      onAction={dispatch} onSelect={id => navigate("today", id)} /> :
      <DirectoryView key={route.tab} mode={route.tab} session={session} {...(route.id ? { selectedId: route.id } : {})}
        onOpenProject={id => navigate("projects", id)} onOpenEvidence={id => navigate("materials", id)}
        onOpenQuestion={id => navigate("today", id)} onBack={() => navigate(route.tab)} />}
  </AppFrame>;
}
