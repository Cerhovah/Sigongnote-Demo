
export interface Source { id: string; root: string; enabled: number; last_scan: string | null; problem: string | null; skipped: number; managed?: { site: string | null; status: string; error: string | null } | null }
export interface Summary {
  field?: {configured:boolean;pending:number;lastSync:string|null};
  sources: Source[]; total: number; counts: { status: string; count: number }[]; duplicates: number;
  progress: { phase: string; inventoried: number; processed: number }; sites: { site: string; count: number }[];
  ai: { configured: boolean; model: string | null; dailyCalls: number; lastCall?: {result:string;estimatedUsd:number|null}|null };
  folderQuestion: { source_id: string; relative_dir: string; count: number } | null;
}
export interface Document {
  id: string; name: string; relative_path: string; status: string; revision: number; hash: string | null;
  excerpt: string; site: string | null; category: string; available: number;
  parsed?: { spans?: { text: string; locator: string }[]; excerptTruncated?: boolean; issues?: string[] };
  ai?: string | null;
}
export interface Copies { id: string; destination: string; items: { id: string; name: string; destination: string }[] }
export interface AiPreview { id: string; provider: string; model: string; payload: { spans: { text: string; locator: string }[] } }

export const labels: Record<string, string> = { complete: "내용을 읽었어요", partial: "일부 내용은 다시 살펴봐야 해요", encrypted: "암호가 걸려 있어 읽지 못했어요",
  failed: "내용을 읽지 못했어요", unsupported: "아직 읽을 수 없는 형식이에요", pending: "읽을 차례를 기다려요",
  storage_wait: "보관 공간을 기다리고 있어요", reading: "내용을 읽고 있어요", too_large: "50MB보다 커서 읽지 않았어요" };
export async function localRequest<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${route}`, { headers: { "X-Sigongnote-Local": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}) }).catch(() => { throw new Error("이 PC의 시공노트에 닿지 못했어요. 바탕화면 바로가기로 다시 열어 주세요."); });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401) throw new Error("PC의 시공노트 바로가기에서 다시 열어 주세요.");
    const messages: Record<string, string> = { MANAGED_FOLDER_EXISTS: "이 폴더 안에 이미 시공노트 폴더가 있어요. 기존 내용을 보존했어요.", MANAGED_FILE_CHANGED: "자료목록을 직접 수정하셨어요. 수정한 내용은 그대로 두었어요.", MANAGED_FOLDER_CHANGED: "연결한 폴더가 달라졌어요. 원래 폴더를 확인해 주세요.", MANAGED_FOLDER_UNAVAILABLE: "자료목록을 만들지 못했어요. 폴더가 연결되어 있는지 확인해 주세요.", SITE_MAPPING_CONFLICT: "이미 다른 현장으로 연결한 폴더예요. 현장을 확인해 주세요.", FIELD_SCOPE_REQUIRED: "폴더 허용을 다시 확인해 주세요.", FIELD_NOT_CONFIGURED: "업무 서버를 아직 준비하지 못했어요.", FIELD_ANSWER_CHANGED: "자료나 답변이 바뀌었어요. 새 내용을 보고 다시 답해 주세요.", FIELD_ADMIN_LOGIN_REQUIRED: "운영자 계정으로 로그인해 주세요.", FIELD_SERVER_REJECTED: "이 작업을 반영하지 못했어요. 계정과 허용 범위를 확인해 주세요.", AI_BUDGET_LIMIT: "정해 둔 AI 이용금액을 다 썼어요. 자료 찾기는 계속할 수 있어요.", AI_NOT_CONFIGURED: "외부 AI를 사용하려면 이 PC에 API 키·모델·하루 사용횟수를 먼저 설정해야 해요.",
      STALE_DOCUMENT: "그동안 자료가 바뀌었어요. 다시 열고 답해 주세요.", STALE_PLAN: "그동안 자료나 허용 범위가 바뀌었어요. 복사할 내용을 다시 살펴봐 주세요.",
      DAILY_CALL_LIMIT: "오늘 허용한 AI 사용횟수를 모두 썼어요.", AI_FAILED_NO_AUTOMATIC_RETRY: "AI 제안을 안전하게 확인하지 못했어요. 중복 과금을 막기 위해 다시 보내지 않았어요.",
      SCOPE_REVOKED: "이 폴더를 읽는 것을 중지했어요.", INVALID_LABEL: "현장 이름에는 특수문자를 빼고 80자 이내로 적어 주세요.",
      FOLDER_PICKER_UNAVAILABLE: "폴더 선택창을 닫은 뒤 다시 눌러 주세요.", NO_READABLE_TEXT: "AI에 보낼 만큼 읽힌 내용이 없어요.",
      INVALID_ROOT: "USB나 드라이브 전체가 아니라, 그 안의 업무 폴더를 골라 주세요.", DIFFERENT_DRIVE: "처음 허용한 USB와 달라요. 원래 USB를 꽂아 주세요.",
      NOT_READ_YET: "아직 이 자료를 읽지 못했어요. 잠시 뒤 다시 열어 주세요." };
    throw Object.assign(new Error(messages[result.error ?? ""] ?? "작업을 마치지 못했어요. 원본은 그대로입니다. 화면을 새로 열고 다시 시도해 주세요."),{code:result.error});
  }
  return response.json() as Promise<T>;
}
let pairing: Promise<void> | undefined;
export function ensurePaired() {
  if (!pairing) pairing = (async () => {
    const token = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (token) {
      history.replaceState(null, "", location.pathname + location.search);
      await localRequest("pair", { token });
    }
  })();
  return pairing;
}


