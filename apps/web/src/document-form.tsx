import {useState} from 'react';
import type {DocumentForm} from '@sigongnote/contracts';

const partyFields=[['business_number','사업자등록번호',13],['representative','대표자',60],['address','사업장 주소',180],['business_type','업태',60],['business_item','종목',60],['contact','담당자 · 연락처',100]] as const;
export function DocumentFormNotice({form={},type}:{form?:DocumentForm;type:string}){
 const missing=(['issuer','recipient'] as const).reduce((n,side)=>n+partyFields.filter(([key])=>!form[side]?.[key]).length,0);
 return <div className="muted">{missing?<p>사업자 정보 {missing}개가 비어 있어요. 빈칸으로 출력됩니다. 입력하려면 ‘내용 다시 보기’를 눌러 주세요.</p>:null}{type==='invoice'&&!form.payment_account?<p>입금 계좌가 비어 있어요. 필요한 경우 발행 전에 입력해 주세요.</p>:null}</div>;
}
export function DocumentFormSummary({form={}}:{form?:DocumentForm}){
 return <div className="stack">{(['issuer','recipient'] as const).map(side=><section key={side}><h4>{side==='issuer'?'보내는 업체':'받는 업체'} 사업자 정보</h4><dl>{partyFields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{form[side]?.[key]||'미입력'}</dd></div>)}</dl></section>)}
 {([['valid_until','견적 유효일'],['delivery_date','납품·거래일'],['delivery_place','납품 장소'],['payment_terms','결제 조건'],['payment_account','입금 계좌 · 예금주'],['note','비고']] as const).map(([key,label])=>form[key]?<p key={key}>{label}: {form[key]}</p>:null)}<p className="muted">출력물에 직인 전용 빈칸을 둡니다. 직인 이미지나 서명은 자동으로 넣지 않아요.</p></div>;
}
export function DocumentFormEditor({form={},issuer,type,busy,onSave,onDirty}:{form?:DocumentForm;issuer:string;type:string;busy:boolean;onSave:(form:DocumentForm)=>void;onDirty:()=>void}){
 const [value,setValue]=useState<DocumentForm>(form),[dirty,setDirty]=useState(false);
 const change=(next:DocumentForm)=>{setValue(next);setDirty(true);onDirty();};
 return <details className="quiet-details"><summary>사업자 정보 · 직인 칸 · 거래 조건</summary>
 <form aria-label="문서 사업자 정보" onSubmit={e=>{e.preventDefault();onSave(value);}}>
 <p>이 문서에 표시할 정보입니다. 모르는 항목은 비워 두세요. 저장하면 새 초안에 반영되며, 발행한 문서는 그대로 남습니다.</p>
 {(['issuer','recipient'] as const).map(side=><fieldset key={side}><legend>{side==='issuer'?'보내는 업체':'받는 업체'}</legend>
 {side==='issuer'?<label className="field">출력할 상호<input maxLength={180} required value={value.issuer?.name??issuer} onChange={e=>change({...value,issuer:{...value.issuer,name:e.target.value}})}/></label>:null}
 {partyFields.map(([key,label,max])=><label className="field" key={key}>{label}<input maxLength={max} {...(key==='business_number'?{placeholder:'000-00-00000',pattern:'[0-9]{3}-[0-9]{2}-[0-9]{5}'}:{})} value={value[side]?.[key]??''} onChange={e=>change({...value,[side]:{...value[side],[key]:e.target.value}})}/></label>)}
 </fieldset>)}
 {type==='estimate'?<label className="field">견적 유효일<input type="date" value={value.valid_until??''} onChange={e=>change({...value,valid_until:e.target.value})}/></label>:null}
 {type==='purchase_order'||type==='delivery_statement'?<><label className="field">{type==='purchase_order'?'희망 납품일':'거래일'}<input type="date" value={value.delivery_date??''} onChange={e=>change({...value,delivery_date:e.target.value})}/></label><label className="field">납품 장소<input maxLength={180} value={value.delivery_place??''} onChange={e=>change({...value,delivery_place:e.target.value})}/></label></>:null}
 <label className="field">결제 조건<input maxLength={180} value={value.payment_terms??''} onChange={e=>change({...value,payment_terms:e.target.value})}/></label>
 {type==='estimate'||type==='invoice'?<><label className="field">입금 계좌 · 예금주<input maxLength={180} value={value.payment_account??''} onChange={e=>change({...value,payment_account:e.target.value})}/></label><span className="muted">발행 전에 계좌와 예금주를 직접 확인해 주세요. 지급이나 송금을 실행하는 설정은 아닙니다.</span></>:null}
 <label className="field">비고<textarea maxLength={300} value={value.note??''} onChange={e=>change({...value,note:e.target.value})}/></label>
 <p className="muted">직인 칸은 인쇄 후 날인할 수 있는 빈칸입니다. 재료비·노무비·경비 구분은 넣지 않습니다.</p>
 <button className="button-secondary" type="submit" disabled={busy||!dirty}>{busy?'저장 중…':'정보 저장하고 초안에 반영'}</button>
 </form></details>;
}
