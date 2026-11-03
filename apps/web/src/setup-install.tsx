import {useState} from 'react';
export const serviceAddress='https://sigongnote-api.onrender.com/';
export type InstallDevice='android'|'windows'|'web';
export function InstallSteps({initial='android',onReturn}:{initial?:InstallDevice;onReturn?:()=>void}){
 const [device,setDevice]=useState(initial);
 return <section className="setup-install" aria-label="앱 다운로드">
  <label className="field">사용할 기기<select value={device} onChange={e=>setDevice(e.target.value as InstallDevice)}><option value="windows">Windows 컴퓨터</option><option value="android">안드로이드 휴대폰</option><option value="web">웹 · 아이폰</option></select></label>
  <a className="button-primary" href={device==='web'?serviceAddress:serviceAddress+'download/'+device}>{device==='web'?'바로 시작하기':device==='windows'?'Windows 앱 받기':'Android 앱 받기'}</a>
  {device!=='web'&&<details><summary>설치 방법</summary>{device==='windows'?<p>받은 설치 파일을 실행하세요. 설치가 끝나면 바탕화면의 시공노트를 여세요.</p>:<p>받은 Sigongnote-Android.apk를 열고 설치하세요.</p>}</details>}
  {onReturn&&<button type="button" className="text-button" onClick={onReturn}>업무로 돌아가기</button>}
 </section>;
}
