import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectSemanticWindow,semanticData,semanticLayout,type SourceChunk} from '../services/api/src/semantic-layout.js';

const cell=(ordinal:number,row:number,column='A',text='회귀 자료'):SourceChunk=>({ordinal,locator:`sheet:0/cell:${column}${row}`,text,content_hash:'a'.repeat(64)});
test('semantic windows retain complete rows, bounded payload and contiguous progress',()=>{
 const primary=Array.from({length:120},(_,i)=>cell(i,Math.floor(i/10)+1,String.fromCharCode(65+i%10)));
 const first=selectSemanticWindow(primary);assert.equal(first.primary.length,60);
 assert.equal(semanticLayout(first.chunks).length,6);
 const second=selectSemanticWindow(primary.slice(60),primary.slice(0,60));
 assert.deepEqual([...first.primary,...second.primary].map(c=>c.ordinal),primary.map(c=>c.ordinal));
 const wide=selectSemanticWindow(Array.from({length:100},(_,i)=>cell(i,1,'A')));assert.equal(wide.primary.length,64);
 const bounded=selectSemanticWindow(Array.from({length:100},(_,i)=>cell(i,i+1,'A','한'.repeat(800))));
 assert.ok(bounded.primary.length>0&&bounded.primary.length<64);
 assert.ok(Buffer.byteLength(JSON.stringify(semanticData({modelVersion:'model',promptVersion:'prompt',indexJobId:'job',chunks:bounded.chunks})))<32768);
});
test('headers from earlier windows are context only and do not repeat work ordinals',()=>{
 const history=[cell(0,1,'A','견적서'),cell(40,10,'A','품명'),cell(41,10,'B','단위'),cell(42,10,'C','수량')];
 const result=selectSemanticWindow([cell(100,20,'A','석고보드'),cell(101,20,'B','EA'),cell(102,20,'C','10')],history);
 assert.deepEqual(result.primary.map(c=>c.ordinal),[100,101,102]);
 assert.deepEqual(result.context.map(c=>c.ordinal),[0,40,41,42]);
 assert.ok(result.chunks.slice(3).every(c=>c.contextOnly));
 assert.deepEqual(semanticLayout([{ordinal:1,locator:'section:0/table:1/cell:2,0',text:'x',active:true,contentHash:'a'.repeat(64)}]),[{row:'section:0/table:1/row:2',ordinals:[1]}]);
});
