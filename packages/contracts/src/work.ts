import { WorkRequestSchema } from "./schemas.js";
import type { z } from "zod";
export type WorkRequest=z.infer<typeof WorkRequestSchema>;
export function workPath(input:WorkRequest){
 const request=WorkRequestSchema.parse(input);
 if(request.route==='archive.status'||request.route==='archive.command')return '/v1/work/archive';
 if(request.route==='journal.tasks')return '/v1/work/journal/tasks';
 if(request.route==='events.read')return '/v1/work/events/'+request.id;
 if(request.route==='events.list'){const p=new URLSearchParams();if(request.project_id)p.set('project_id',request.project_id);if(request.limit)p.set('limit',String(request.limit));return '/v1/work/events?'+p;}
 if(request.route==='ai.consent')return '/v1/local-journal/ai-consent';
 if(request.route==='journal.command')return '/v1/work/journal/commands';
 if(request.route==='journal.list'){const p=new URLSearchParams();if(request.project_id)p.set('project_id',request.project_id);if(request.q)p.set('q',request.q);if(request.cursor)p.set('cursor',request.cursor);if(request.category)p.set('category',request.category);return '/v1/work/journal?'+p;}
 if(request.route==='setup.read'||request.route==='setup.command')return '/v1/work/setup';
 if(request.route==='setup.capture')return '/v1/work/setup/capture';
 if(request.route==='agenda.read')return '/v1/work/agenda';
 if(request.route==='ledger.read')return '/v1/work/ledger/'+request.id+(request.cursor?'?cursor='+request.cursor:'');
 if(request.route==='ledger.list'){const p=new URLSearchParams();if(request.project_id)p.set('project_id',request.project_id);if(request.category)p.set('category',request.category);if(request.cursor)p.set('cursor',request.cursor);return '/v1/work/ledger?'+p;}
 if(request.route==='improvements.list')return '/v1/improvements';
 if(request.route==='improvements.command')return '/v1/improvements/commands';
 if(request.route==='learning.list')return '/v1/learning'+(request.cursor?'?cursor='+request.cursor:'');
 if(request.route==='learning.read')return '/v1/learning/'+request.id;
 if(request.route==='context-learning.list')return '/v1/context-learning';
 if(request.route==='context-learning.command')return '/v1/context-learning/commands';
 if(request.route==='learning.command')return '/v1/learning/commands';
 if(request.route==='deliveries.list')return '/v1/deliveries?source_kind='+request.source_kind+'&source_id='+request.source_id;
 if(request.route==='deliveries.read')return '/v1/deliveries/'+request.id;
 if(request.route==='deliveries.prepare')return '/v1/deliveries/prepare';
 if(request.route==='deliveries.authorize')return '/v1/deliveries/authorize';
 if(request.route==='deliveries.cancel')return '/v1/deliveries/cancel';
 if(request.route==='sheets.share')return '/v1/photo-sheets/share';
 if(request.route==='sheets.prepare')return '/v1/photo-sheets';
 if(request.route==='sheets.read'||request.route==='sheets.file')return '/v1/photo-sheets/'+request.id+(request.route==='sheets.file'?'/file':'');
 if(request.route==='photos.list')return '/v1/photos?project_id='+request.project_id+(request.cursor?'&cursor='+request.cursor:'');
 if(request.route==='photos.group')return '/v1/photos/groups/'+request.id;
 if(request.route==='photos.preview')return '/v1/photos/'+request.id+'/preview';
 if(request.route==='photos.command')return '/v1/photos/groups';
 if(request.route==="agent.start")return "/v1/agent/runs";
 if(request.route==="agent.continue")return `/v1/agent/runs/${request.id}/continue`;
 if(request.route==="agent.read"||request.route==="agent.cancel")return `/v1/agent/runs/${request.id}${request.route==="agent.cancel"?"/cancel":""}`;
 if(request.route==='capture.status')return '/v1/capture-status';
 if(request.route==='evidence.resume')return `/v1/evidence/${request.id}/resume`;
 if(request.route==='folders.read')return '/v1/site-folder-bindings';
 if(request.route==='folders.correct')return '/v1/site-folder-bindings/batch';
 if(request.route==="evidence.chunks")return `/v1/evidence/${request.id}/chunks${request.cursor?`?cursor=${encodeURIComponent(request.cursor)}`:""}`;
 if(request.route==="activity.delete")return "/v1/work/activity/delete";
 if(request.route==="activity.status")return "/v1/work/activity/status";
 if(request.route==="activity.consent")return "/v1/work/activity/consent";
 if(request.route==="activity.append")return "/v1/work/activity/events";
 if(request.route==="activity.list"){const p=new URLSearchParams();if(request.cursor)p.set('cursor',request.cursor);if(request.q)p.set('q',request.q);return `/v1/work/activity?${p}`;}
 if(request.route==="audio.correct")return "/v1/work/audio/corrections";
 if(request.route==="maintenance.status")return "/v1/work/maintenance";
 if(request.route==="policies.list")return "/v1/owner-policies";
 if(request.route==="policies.command")return "/v1/owner-policies/commands";
 if(request.route==="work.reply")return "/v1/work/replies";
 if(request.route==="questions.list")return "/v1/work/questions";
 if(request.route==="work.command")return "/v1/work-commands";
 if(request.route==="sync.item")return `/v1/sync/changes?kind=${request.target_kind}&id=${request.id}`;
 if(request.route==="sync.changes")return `/v1/sync/changes${request.sync_version?"?sync_version=2":""}${request.cursor?`${request.sync_version?"&":"?"}cursor=${encodeURIComponent(request.cursor)}`:""}`;
 if(request.route==="documents.share")return `/v1/documents/${request.id}/share-intents`;
 if(request.route==="documents.shareOutcome")return `/v1/documents/${request.id}/share-intents/${request.intent_id}/outcomes`;
 if(request.route==="documents.list")return "/v1/documents";
 if(request.route==='documents.prepare')return '/v1/document-drafts';
 if(request.route==="documents.issued")return `/v1/documents/${request.id}`;
 if(request.route==="documents.file")return `/v1/documents/${request.id}/files/${request.format}`;
 if(request.route==="documents.retry")return `/v1/documents/${request.id}/render-retry`;
 if(request.route==="documents.cancel")return `/v1/documents/${request.id}/cancel`;
 if(request.route==="documents.issue")return request.replacement_id?`/v1/documents/${request.replacement_id}/cancel`:"/v1/documents/issue";
 if(request.route==="documents.complete")return `/v1/document-drafts/${request.id}/complete`;
 if(request.route==="documents.read")return `/v1/document-drafts/${request.id}`;
 if(request.route==="voice.status")return "/v1/voice/status";
 if(request.route==="voice.consent")return "/v1/voice/consent";
 if(request.route==="voice.transcribe")return "/v1/voice/transcribe";
 if(request.route==="voice.result")return `/v1/voice/${request.id}`;
 if(request.route==="voice.cancel")return `/v1/voice/${request.id}/cancel`;
 if(request.route==="context")return "/v1/work/context";
 if(request.route==="guide.read"||request.route==="guide.save")return "/v1/work/guide";
 if(request.route==="conversation.turn"||request.route==="conversation.read")return `/v1/conversations/${request.id}/turns`;
 if(request.route==="organization.answer")return `/v1/work/materials/${request.id}/organization`;
 if(request.route==="materials.original")return `/v1/work/materials/${request.id}/original`;
 if(request.route==="materials.message")return `/v1/work/materials/${request.id}/message`;
 if(request.route==="materials.detail")return `/v1/work/materials/${request.id}`;
 const params=new URLSearchParams();if(request.q)params.set("q",request.q);if(request.cursor)params.set("cursor",request.cursor);if(request.category)params.set("category",request.category);if(request.project_id)params.set("project_id",request.project_id);
 return `/v1/work/materials?${params}`;
}

export function workHttp(input:WorkRequest){
 const r=WorkRequestSchema.parse(input);const path=workPath(r);
 if(r.route==='ai.consent')return {path,method:'POST' as const,body:{allowed:r.allowed,expected_version:r.expected_version,client_command_id:r.client_command_id,...(r.processing_policy?{processing_policy:r.processing_policy}:{})}};
 if(r.route==='documents.prepare')return {path,method:'POST' as const,body:{project_id:r.project_id,type:r.type,client_command_id:r.client_command_id}};
 if(r.route==='archive.command'||r.route==='journal.command'||r.route==='setup.command'||r.route==='setup.capture')return {path,method:'POST' as const,body:JSON.parse(r.command)};
 if(r.route==='photos.command'||r.route==='sheets.prepare'||r.route==='sheets.share'||r.route==='deliveries.prepare'||r.route==='deliveries.authorize'||r.route==='deliveries.cancel')return {path,method:'POST' as const,body:JSON.parse(r.command)};
 if(r.route==="agent.start")return {path,method:"POST" as const,body:JSON.parse(r.command)};
 if(r.route==="agent.cancel"||r.route==="agent.continue")return {path,method:"POST" as const,body:{}};
 if(r.route==='evidence.resume')return {path,method:'POST' as const,body:JSON.parse(r.command)};
 if(r.route==='folders.correct')return {path,method:'POST' as const,body:JSON.parse(r.command)};
 if(r.route==='learning.command'||r.route==='improvements.command'||r.route==='context-learning.command')return {path,method:'POST' as const,body:JSON.parse(r.command)};
 if(r.route==="activity.delete")return {path,method:"POST" as const,body:{}};
 if(r.route==="activity.append")return {path,method:"POST" as const,body:JSON.parse(r.command)};
 if(r.route==="activity.consent")return {path,method:"POST" as const,body:{allowed:r.allowed}};
 if(r.route==="audio.correct"||r.route==="work.command"||r.route==="work.reply"||r.route==="policies.command")return {path,method:"POST" as const,body:JSON.parse(r.command)};
 if(r.route==="documents.issue"){const issue={client_command_id:r.client_command_id,drafts:[{id:r.id,basis_hash:r.basis_hash,...(r.amount_minor?{amount_minor:r.amount_minor}:{})}],recipient_confirmation:r.recipient_confirmation};if(r.replacement_id&&!r.expected_hash)throw new Error("정정할 문서를 다시 열어 주세요.");return {path,method:"POST" as const,body:r.replacement_id?{client_command_id:r.client_command_id,expected_hash:r.expected_hash,replacement:issue}:issue};}
 if(r.route==="documents.share")return {path,method:"POST" as const,body:{client_command_id:r.client_command_id,format:r.format}};
 if(r.route==="documents.shareOutcome")return {path,method:"POST" as const,body:{client_command_id:r.client_command_id,outcome:r.outcome}};
 if(r.route==="documents.retry")return {path,method:"POST" as const,body:{client_command_id:r.client_command_id}};
 if(r.route==="documents.cancel")return {path,method:"POST" as const,body:{client_command_id:r.client_command_id,expected_hash:r.expected_hash}};
 if(r.route==="documents.complete"){const {route,id,...body}=r;return {path,method:"POST" as const,body};}
 if(r.route==="voice.consent")return {path,method:"POST" as const,body:{allowed:r.allowed,consent_version:r.consent_version}};
 if(r.route==="voice.transcribe")return {path,method:"POST" as const,body:{id:r.id,mime:r.mime,audio:r.audio,consent_version:r.consent_version}};
 if(r.route==="voice.cancel")return {path,method:"POST" as const,body:{}};
 if(r.route==="conversation.turn")return {path,method:"POST" as const,key:r.client_turn_id,body:{client_turn_id:r.client_turn_id,text:r.text,...(r.input_kind?{input_kind:r.input_kind}:{}),...(r.selected_project_id?{selected_project_id:r.selected_project_id}:{}),attachment_refs:[]}};
 if(r.route==="organization.answer")return {path,method:"POST" as const,body:{project_id:r.project_id,version:r.version}};
 if(r.route==="guide.save")return {path,method:"POST" as const,body:{step:r.step,completed:r.completed}};
 return {path,method:"GET" as const};
}
