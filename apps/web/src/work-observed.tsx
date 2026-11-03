import type {ObservedWork} from './work-client.js';
const labels:Record<string,string>={ordered:'발주',dispatch:'출고',receipt:'인수',inspection:'검수',billing:'청구',payment:'입금'};
/** Evidence observations remain distinct from confirmed actions. No inferred zero or combined units. */
export function WorkObserved({value}:{value:ObservedWork}){
 const entries=Object.entries(labels).map(([kind,label])=>({kind,label,rows:value.observed_state[kind]??[]}));
 return <section className="card" aria-labelledby="work-observed-title"><h2 id="work-observed-title" className="card-title">이 일의 진행 기록</h2>
 <p>읽은 자료를 바탕으로 정리했어요. 실제 승인과 지급 내역은 별도로 관리해요.</p>
 <ul className="row-list">{entries.map(({kind,label,rows})=><li className="row" key={kind}><span><strong>{label}</strong><small>{rows.length?`${rows.length}개 항목 · ${rows.some(row=>row.uncertain)?'합계를 확인할 단서가 더 필요해요':'근거를 연결했어요'}`:'기록 없음'}</small></span></li>)}</ul>
 {value.coverage.unassertedCount>0?<p className="muted">예정·조건·전해 들은 내용 {value.coverage.unassertedCount}건은 진행 결과와 구분했어요.</p>:null}
 {value.coverage.conflictCount>0?<p className="muted">서로 다른 내용이 있어 합계를 확정하지 않았어요.</p>:null}
 </section>;
}
