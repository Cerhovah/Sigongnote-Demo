export type OperationsReport={checked_at:string;queues:{kind:string;pending:number;expired_leases:number;failed:number;oldest_seconds:number}[];outbox:{pending:number};delivery:{unknown:number;known_krw:string;reserved_krw:string};budget:{daily_krw:string;monthly_krw:string;unknown_count:number};storage:{used_bytes:number;reserved_bytes:number;limit_bytes:number};worker:{enabled:boolean;ready:boolean};release:{source_sha:string|null;status:string};acceptance:string};
const money=(v:unknown)=>typeof v==='string'&&/^\d{1,30}$/.test(v)?`${BigInt(v).toLocaleString('ko-KR')}원`:'확인 전';
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?`${v}건`:'확인 전';
const storage=(v:unknown,digits=2)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?`${(v/1e9).toFixed(digits)}GB`:'확인 전';
export function OperationsPanel({value}:{value:OperationsReport}){
 const names:Record<string,string>={parse_original:'원문 판독',render_document:'문서 출력'};
 return <section aria-label="운영과 비용" data-activity-ignore="true"><h2>처리 대기와 비용</h2>
 <p>이 회사의 자료 처리 현황 · {Number.isFinite(Date.parse(value.checked_at))?new Date(value.checked_at).toLocaleString('ko-KR'):'확인 시각 없음'}</p>
 <p>{value.worker?.enabled?(value.worker.ready?'서버 처리기가 응답하고 있어요.':'서버 처리기의 연결 또는 일부 작업을 확인해야 해요.'):'서버 처리기 상태를 아직 확인하지 못했어요.'} 처리 성공률·사용자 만족도를 뜻하지 않습니다.</p>
 <ul>{(value.queues??[]).map(q=><li key={q.kind}>{names[q.kind]??'자료 작업'}: 대기 {count(q.pending)} · 가장 오래된 대기 {Number.isFinite(q.oldest_seconds)?`${Math.max(0,Math.ceil(q.oldest_seconds/60))}분`:'확인 전'} · 재개 대기 {count(q.expired_leases)} · 누적 실패 {count(q.failed)}</li>)}</ul>
 <p>전달 대기 기록 {count(value.outbox?.pending)} · 발송 결과 확인 중 {count(value.delivery?.unknown)}</p>
 <p>이번 달 회사 전달 비용 확인분 {money(value.delivery?.known_krw)} · 미확정 예약 {money(value.delivery?.reserved_krw)}. 이전 달의 미확정 예약도 포함합니다. 공급자 청구서와 별도로 확인해야 해요.</p>
 <p>내 계정 전체 회사의 자료·음성 예산 사용: 오늘 {money(value.budget?.daily_krw)} / 1만원 · 이번 달 {money(value.budget?.monthly_krw)} / 5만원. 예약 포함이며 결과 미확정 {count(value.budget?.unknown_count)}입니다.</p>
 <p>내 계정 전체 회사 저장량 {storage(value.storage?.used_bytes)} · 전송 예약 {storage(value.storage?.reserved_bytes)} / {storage(value.storage?.limit_bytes,0)}</p>
 <details><summary>운영 확인 정보</summary><p>빌드 식별값(운영 확인용) {value.release?.source_sha?.slice(0,12)??'확인 전'} · {value.release?.status==='identified'?'빌드 기준 기록 있음':'수정 중 또는 확인 전'}. 실제 배포 일치·전체 복원·실사용 인수는 각각 확인합니다.</p></details></section>;
}
