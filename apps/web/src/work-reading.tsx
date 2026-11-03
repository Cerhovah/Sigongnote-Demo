import type {ReadinessReport} from '@sigongnote/contracts';

/** A device scan is evidence of discovery, never evidence that all contents were read. */
export function WorkReading({value,onFolders}:{value:ReadinessReport|undefined;onFolders?:()=>void}){
 if(!value)return <p className="muted">자료 연결 상태는 아직 확인하지 못했어요. 자료별로 읽은 범위를 확인해 주세요.</p>;
 const sources=value.capabilities.filter(c=>c.source_id),reconnect=sources.filter(c=>c.state==='needs_reconnect');
 const worker=value.capabilities.find(c=>c.id==='worker'),folders=value.capabilities.find(c=>c.id==='folders');
 return <details className="quiet-details reading-status"><summary>내 자료 위치 {value.coverage.source_count}곳 중 {value.coverage.reported_scanned_count}곳 살펴봄</summary>
  <p>폴더에서 찾은 파일과 본문을 읽은 자료는 달라요. 읽은 범위는 자료를 열어 확인할 수 있어요.</p>
  {!value.coverage.source_count&&folders?<p>{folders.reason}</p>:null}
  {worker?<p>{worker.reason}</p>:null}
  {sources.filter(c=>c.state!=='ready').map(c=><p key={c.id}>{c.label} · {c.reason}</p>)}
  <p className="muted">{new Date(value.checked_at).toLocaleString('ko-KR')}에 확인한 상태예요. 기기가 꺼져 있으면 최신 전송 상태를 알 수 없어요.</p>
  {onFolders?<button type="button" className="button-secondary" onClick={onFolders}>{!value.coverage.source_count?'업무 폴더 연결':reconnect.length?'폴더 연결·권한 확인':'연결한 폴더 보기'}</button>:null}
 </details>;
}
