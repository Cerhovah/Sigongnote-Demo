import {InstallSteps,serviceAddress,type InstallDevice} from './setup-install.js';
export function InstallApp(){
 const requested=new URLSearchParams(location.search).get('device');
 const initial:InstallDevice=requested==='windows'||requested==='web'||requested==='android'?requested:/Windows/i.test(navigator.userAgent)?'windows':/Android/i.test(navigator.userAgent)?'android':'web';
 return <main className="cloud-welcome install-page">
  <a className="install-brand" href="/">시공노트</a><h1>내 기기에서<br/>바로 시작하세요.</h1>
  <InstallSteps initial={initial}/>
  <a className="button-secondary" href={serviceAddress}>웹에서 바로 시작</a>
  <details><summary>버전 · 파일 확인</summary><p>Android 0.3.0-rc.13 · Windows 0.3.0-rc.13</p><p><a href="/download/checksums">Android 검증값</a> · <a href="/download/windows-checksums">Windows 검증값</a></p></details>
 </main>;
}
