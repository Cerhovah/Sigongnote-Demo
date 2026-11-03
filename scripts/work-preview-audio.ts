/** Synthetic tone only. This adapter never recognizes speech and rejects unknown bytes. */
import {createHash} from 'node:crypto';
import type {AudioProvider} from '../services/api/src/long-audio.js';
export function syntheticAudio(){
 const size=16000*2*3,bytes=Buffer.alloc(size+44);bytes.write('RIFF',0);bytes.writeUInt32LE(size+36,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(size,40);
 for(let i=0;i<size/2;i++)bytes.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*1000),44+i*2);return bytes;
}
export const syntheticAudioProvider:AudioProvider={name:'synthetic',async submit(bytes){if(createHash('sha256').update(bytes).digest('hex')!==createHash('sha256').update(syntheticAudio()).digest('hex'))throw new Error('SYNTHETIC_ONLY');return 'synthetic-tone-v1';},async poll(receipt){if(receipt!=='synthetic-tone-v1')throw new Error('SYNTHETIC_ONLY');return {status:'completed',segments:[{start:0,end:1000,text:'합성 햇살현장 납품 녹음 체험',speaker:{label:'A'}},{start:1000,end:2000,text:'작업: 주방 보수',speaker:{label:'A'}},{start:2000,end:3000,text:'석고보드 납품은 내일 확인해 주세요. 확정한 수량과 금액은 없습니다.',speaker:{label:'B'}}]};}};
