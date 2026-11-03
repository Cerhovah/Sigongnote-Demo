import {useEffect,useState} from 'react';
import type {WorkClient} from './work-client.js';
import type {ReadinessReport} from '@sigongnote/contracts';
type Summary={checked_at:string;support_id:string;readiness?:ReadinessReport;jobs:{waiting:number;working:number;failed:number;oldest_wait_seconds:number|null};capture:{connected:number;gated:number;pending:number;last_received_at:string|null};usage:{voice_reserved_seconds:number;audio_reserved_seconds:number;voice_known_cost_minor:string|null;voice_unknown_cost_count:number};backup:{verified_at:string|null}};
export function WorkMaintenance({client}:{client:WorkClient}){
 const [tick,setTick]=useState(0),[value,setValue]=useState<Summary|null>(null),[error,setError]=useState(''),[copied,setCopied]=useState(false);
 // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the explicit user refresh generation.
 useEffect(()=>{let live=true;setValue(null);setError('');setCopied(false);void client.request<Summary>({route:'maintenance.status'}).then(v=>{if(live)setValue(v);},()=>{if(live)setError('상태를 확인하지 못했어요. 대표 계정과 연결을 확인해 주세요.');});return()=>{live=false;};},[client,tick]);
 const report=value?`시공노트 지원 확인\n확인 시각: ${value.checked_at}\n문의번호: ${value.support_id}\n처리 대기 ${value.jobs.waiting}, 처리 중 ${value.jobs.working}, 확인 필요 ${value.jobs.failed}\n연결 대기 ${value.capture.pending}\n전체 복원: 미검증\n실제 청구 비용: 미정산`:'';
 return <div className="work-maintenance">{error?<p role="alert" className="notice notice-warn">{error}</p>:null}{!value?(!error?<p role="status" className="muted">현재 상태를 확인하고 있어요…</p>:null):<>
 <dl className="stat-grid"><div><dt>처리 대기</dt><dd>{value.jobs.waiting}건</dd></div><div><dt>처리 중</dt><dd>{value.jobs.working}건</dd></div><div><dt>확인 필요</dt><dd>{value.jobs.failed}건</dd></div><div><dt>연결한 자료 위치</dt><dd>{value.capture.connected}곳</dd></div></dl>
 {value.readiness?<ReadinessDetails value={value.readiness}/>:<p>자세한 연결 상태는 서버 업데이트 후 확인할 수 있어요.</p>}
 {value.jobs.oldest_wait_seconds!==null?<p>가장 오래 기다린 자료: {Math.max(1,Math.ceil(value.jobs.oldest_wait_seconds/60))}분</p>:null}
 <p>연결 준비 중 {value.capture.gated}곳 · 기기가 보고한 전송 대기 {value.capture.pending}건</p><p>마지막 서버 수신: {value.capture.last_received_at?new Date(value.capture.last_received_at).toLocaleString('ko-KR'):'아직 확인하지 못했어요'}. 꺼진 기기의 최신 대기는 포함되지 않을 수 있어요.</p>
 <p>실제 청구 비용은 아직 정산되지 않았어요. 아래 예약량은 실제 사용량·청구 금액과 다릅니다.</p>
 <details className="quiet-details"><summary>음성 처리량과 복원 확인</summary><p>짧은 요청 예약 {value.usage.voice_reserved_seconds}초 · 녹음 예약 {value.usage.audio_reserved_seconds}초</p><p>이 회사의 서버와 모든 기기 자료를 함께 복원한 기록은 아직 없습니다. 개발 환경 복원 시험과 실사용 백업은 별도로 확인합니다.</p></details>
 <div className="stack"><button type="button" className="button-secondary" onClick={()=>{if(!navigator.clipboard){setError('자동 복사가 지원되지 않아요. 문의번호와 화면의 처리 건수를 적어 주세요.');return;}void navigator.clipboard.writeText(report).then(()=>setCopied(true),()=>setError('아래 문의번호를 복사해 주세요.'));}}>원문 없는 문의 내용 복사</button><button type="button" className="button-quiet" onClick={()=>setTick(x=>x+1)}>상태 다시 확인</button></div><p role="status">{copied?'문의 내용을 복사했어요. ':''}문의번호 {value.support_id}</p><p className="muted">문자·사진·연락처·파일 경로는 문의 내용에 포함하지 않습니다.</p>
 </>}</div>;
}
export function ReadinessDetails({value}:{value:ReadinessReport}){
 const labels={ready:'연결 확인',needs_setup:'연결 준비',needs_reconnect:'권한 다시 연결',waiting:'처리 대기',unverified:'확인 필요'};
 const formats={parser_available:'본문 판독기 있음 · 파일별 확인',provider_required:'판독 서비스 연결 필요',discovery_only:'탐색 대상 · 본문 판독 별도 준비',excluded:'이번 범위 제외'};
 return <section aria-label="기능별 연결 상태">
  <h2>지금 연결된 기능</h2><ul className="stack">{value.capabilities.map(c=><li key={c.id}><strong>{c.label} · {labels[c.state]}</strong><p>{c.reason}</p>{c.action==='restore_permission'?<p><a href="#/folders">권한 다시 연결</a> · 연결했던 PC나 휴대폰에서 해당 폴더의 접근 권한을 허용해 주세요.</p>:c.action==='connect_folder'?<a href="#/folders">업무 폴더 연결</a>:null}</li>)}</ul>
  <details className="quiet-details"><summary>읽은 범위와 자료 종류</summary><p>내 연결 {value.coverage.source_count}곳 중 탐색 보고 {value.coverage.reported_scanned_count}곳. 전체 내용을 빠짐없이 읽었는지는 아직 확인 중이에요.</p><p>파일 발견·전송·본문 판독은 각각 다릅니다. 읽지 못한 형식을 완료로 표시하지 않아요.</p><ul>{value.formats.map(f=><li key={f.label}>{f.label}: {formats[f.status]} ({f.extensions.join(', ')})</li>)}</ul></details>
  <details className="quiet-details"><summary>처리 예산과 용량 기준</summary><p>사용자당 월 5만원·하루 1만원 이내, 연결 자료 100GB 기준입니다.</p><p>{value.limits.budget_enforced?'API 호출 전 남은 예산을 확인합니다.':'예산 설정 기준이며 실제 비용 제한 연결은 준비 중입니다.'} 서버·저장·팩스 비용은 별도입니다.</p></details>
 </section>;
}
