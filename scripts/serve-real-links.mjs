import {createServer} from 'node:http';
import {networkInterfaces} from 'node:os';
const lan=process.argv.includes('--lan');
const hosts=new Set(['localhost','127.0.0.1',...(lan?Object.values(networkInterfaces()).flat().filter(x=>x?.family==='IPv4').map(x=>x.address):[])]);
createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 try {if(!hosts.has(new URL('http://'+req.headers.host).hostname)){res.writeHead(403).end();return;}}catch{res.writeHead(400).end();return;}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(410).end();return;}
 if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'sigongnote-live-links',ready:true,workerStatus:'cloud-managed'}));return;}
 res.writeHead(302,{Location:'https://sigongnote-api.onrender.com/'}).end();
}).listen(5190,lan?'0.0.0.0':'127.0.0.1',()=>console.log('READY real-service redirect on 5190'));
