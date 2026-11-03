import type { EvidenceManifest, ParseOutput } from './parse-worker.js';

export function configuredPdfBatchPages(value:string|undefined):number {
 if(value===undefined)return 20;
 if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>200)throw Error('PDF_BATCH_CONFIG_INVALID');
 return Number(value);
}

/** Merge one bounded page window; page locators stay absolute and excerpts stay small. */
export function mergePdfManifest(previous:ParseOutput|null,current:EvidenceManifest,startPage:number):EvidenceManifest {
 if(previous&&(previous.coverage.next_page!==startPage||previous.evidence?.parserVersion!==current.parserVersion
  ||previous.coverage.pages_seen!==current.coverage.pages_seen))throw Error('PDF_CHECKPOINT_MISMATCH');
 const coverage:EvidenceManifest['coverage']={...current.coverage,page_start:1};
 for(const key of ['pages_read','pages_ocr_attempted','pages_ocr_read','pages_partial'])
  coverage[key]=Number(previous?.coverage[key]??0)+Number(current.coverage[key]??0);
 return {...current,chunkCount:(previous?.evidence?.chunkCount??0)+current.chunkCount,coverage,
  sourceStatus:current.sourceStatus==='complete'&&Number(coverage.pages_partial)>0?'partial':current.sourceStatus};
}

export function mergePdfOutput(previous:ParseOutput|null,current:ParseOutput,startPage:number):ParseOutput {
 if(!current.evidence)throw Error('EVIDENCE_MANIFEST_MISSING');
 const evidence=mergePdfManifest(previous,current.evidence,startPage);
 const spans:ParseOutput['spans']=[];let bytes=0,truncated=Boolean(previous?.excerptTruncated||current.excerptTruncated);
 for(const span of [...(previous?.spans??[]),...current.spans]){
  const size=Buffer.byteLength(JSON.stringify(span))+4;
  if(spans.length>=1000||bytes+size>2*1024*1024){truncated=true;continue;}
  spans.push(span);bytes+=size;
 }
 const issues=[...new Set([...(previous?.issues??[]),...current.issues])]
  .filter(issue=>issue!=='page_limit_exceeded'||evidence.coverage.next_page!=null).slice(0,40);
 return {...current,evidence,coverage:evidence.coverage,spans,excerptTruncated:truncated,issues,
  status:truncated&&evidence.sourceStatus==='complete'?'partial':evidence.sourceStatus as ParseOutput['status']};
}
