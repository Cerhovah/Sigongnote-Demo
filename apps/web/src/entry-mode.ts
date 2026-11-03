/** Public and retired demonstration URLs always enter the real account flow. */
export function entryMode(href:string,native:boolean):'native'|'local-work'|'local'|'cloud'|'install'{
 const url=new URL(href);
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(loopback&&(url.port==='5174'||url.searchParams.get('work')==='local')&&!url.searchParams.has('demo'))return url.searchParams.get('legacy')==='1'?'local':'local-work';
 if(native)return 'native';
 if(url.pathname==='/install')return 'install';
 return 'cloud';
}
