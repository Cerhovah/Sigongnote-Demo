import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { z } from "zod";
import { schemas } from "../packages/contracts/src/schemas.js";
type Schema = {type?:string|string[];anyOf?:Schema[];oneOf?:Schema[];properties?:Record<string,Schema>;required?:string[];items?:Schema;const?:unknown;enum?:unknown[];maximum?:number;minimum?:number};
const documents = Object.fromEntries(Object.entries(schemas).map(([name,schema])=>[name,z.toJSONSchema(schema,{target:"draft-2020-12"})]));
const check = process.argv.includes("--check");
function output(path:string,body:string) {
 if(check) { if(!existsSync(path) || readFileSync(path,"utf8") !== body) throw new Error(`Generated contract drift: ${path}`); }
 else { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,body); }
}
const header="// Generated from schemas.ts. Wire DTOs only; server runtime schemas enforce invariants.\n// Never display nullable minor as zero. Preserve knowledge and explicit required nulls.\n// C09/C14: align response readers to ignore added fields; incoming commands must stay strict.\n";
let ts=header;
for(const [name,schema] of Object.entries(documents)) ts+=await compile(schema as JSONSchema,name,{bannerComment:"",additionalProperties:false});
output("packages/contracts/generated/types.ts",ts);
output("packages/contracts/generated/schema.json",JSON.stringify({$schema:"https://json-schema.org/draft/2020-12/schema",$defs:documents},null,2)+"\n");
output("services/document-worker/src/sigongnote_worker/generated/schema.json",JSON.stringify({$schema:"https://json-schema.org/draft/2020-12/schema",$defs:documents},null,2)+"\n");
const bearer = [{bearerAuth:[]}];
const jsonResponse = (schemaName:string) => ({description:"OK",content:{"application/json":{schema:{$ref:`#/components/schemas/${schemaName}`}}}});
const errorResponse = {description:"Error",content:{"application/json":{schema:{$ref:"#/components/schemas/ApiError"}}}};
const tenantHeader = {name:"X-Tenant-ID",in:"header",required:true,schema:{type:"string",format:"uuid"}};
const idempotencyHeader = {name:"Idempotency-Key",in:"header",required:true,schema:{type:"string",format:"uuid"}};
const ingestionAttemptHeader = {...idempotencyHeader,description:
 "Reuse this key for network retries of one upload attempt. After a rejected attempt, keep client_capture_id and use a new Idempotency-Key for prepare."};
const durability=(operationId:string)=>({post:{operationId,security:bearer,parameters:[tenantHeader,{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}],requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/CaptureDurabilityRequest'}}}},responses:{'200':jsonResponse('CaptureDurabilityResponse'),'400':errorResponse,'401':errorResponse,'404':errorResponse,'410':errorResponse,'422':errorResponse,'503':errorResponse}}});
const paths={
 '/v1/capture-status':{get:{operationId:'captureStatus',security:bearer,parameters:[tenantHeader],responses:{'200':jsonResponse('CaptureStatusResponse'),'401':errorResponse,'404':errorResponse}}},
 '/v1/evidence/{id}/resume':{post:{operationId:'resumePdfEvidence',security:bearer,parameters:[tenantHeader,{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}],requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/EvidenceResumeRequest'}}}},responses:{'200':jsonResponse('EvidenceResumeResponse'),'400':errorResponse,'401':errorResponse,'404':errorResponse,'409':errorResponse}}},
 '/v1/capture-storage':{get:{operationId:'captureStorageUsage',security:bearer,parameters:[tenantHeader],responses:{'200':jsonResponse('CaptureStorageUsage'),'401':errorResponse,'404':errorResponse}}},
 '/v1/ingestions/{id}/durability':durability('captureDurability'),
 '/v1/revisions/{id}/durability':durability('revisionDurability'),
 "/v1/workspaces":{post:{operationId:"createWorkspace",description:"Persist the request key until success. On 201 or 409 reload /v1/me and continue with its current company; receipt name/version is historical, never an If-Match value. 403 means prior membership requires existing-company access or invitation.",security:bearer,parameters:[idempotencyHeader],
  requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/WorkspaceCreateRequest"}}}},
  responses:{"201":jsonResponse("WorkspaceResponse"),"400":errorResponse,"401":errorResponse,"404":errorResponse,"409":errorResponse,"422":errorResponse,"403":errorResponse,"429":errorResponse,"503":errorResponse}}},
 "/v1/capture-policy":{get:{operationId:"getCapturePolicy",security:bearer,responses:{"200":jsonResponse("CapturePolicy"),"401":errorResponse,"503":errorResponse}}},
 "/v1/projects":{post:{operationId:"createProject",security:bearer,parameters:[tenantHeader,idempotencyHeader],
  requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/ProjectCreateRequest"}}}},
  responses:{"201":jsonResponse("ProjectResponse"),"400":errorResponse,"401":errorResponse,"403":errorResponse,"404":errorResponse,"409":errorResponse}}},
 "/v1/site-folder-bindings/batch":{post:{operationId:"correctSiteFolderBindings",security:bearer,parameters:[tenantHeader],requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/SiteFolderBatchRequest"}}}},responses:{"200":jsonResponse("SiteFolderBindingsResponse"),"400":errorResponse,"401":errorResponse,"403":errorResponse,"404":errorResponse,"409":errorResponse,"410":errorResponse}}},
 "/v1/site-folder-bindings":{
  get:{operationId:"listSiteFolderBindings",security:bearer,parameters:[tenantHeader],responses:{"200":jsonResponse("SiteFolderBindingsResponse"),"401":errorResponse,"404":errorResponse}},
  post:{operationId:"createSiteFolderBinding",security:bearer,parameters:[tenantHeader,idempotencyHeader],
   requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/SiteFolderBindingRequest"}}}},
   responses:{"200":jsonResponse("SiteFolderBindingResponse"),"201":jsonResponse("SiteFolderBindingResponse"),"400":errorResponse,"401":errorResponse,"403":errorResponse,"404":errorResponse,"409":errorResponse,"410":errorResponse}}},
 "/v1/me":{get:{operationId:"getMe",security:bearer,responses:{"200":jsonResponse("MeResponse"),"401":errorResponse}}},
 "/v1/devices":{post:{operationId:"registerDevice",security:bearer,parameters:[tenantHeader,idempotencyHeader],
  requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/DeviceRegistrationRequest"}}}},
  responses:{"201":jsonResponse("DeviceResponse"),"400":errorResponse,"401":errorResponse,"403":errorResponse,"404":errorResponse,"409":errorResponse}}},
 "/v1/devices/{id}/revoke":{post:{operationId:"revokeDevice",security:bearer,parameters:[
  {name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}},tenantHeader,idempotencyHeader,
  {name:"If-Match",in:"header",required:true,schema:{type:"string"}}],
  responses:{"200":jsonResponse("DeviceResponse"),"400":errorResponse,"401":errorResponse,"404":errorResponse,"409":errorResponse}}},
 "/v1/capture-sources":{
  get:{operationId:"listCaptureSources",security:bearer,parameters:[tenantHeader],
   responses:{"200":jsonResponse("CaptureSourcesResponse"),"401":errorResponse,"404":errorResponse}},
  post:{operationId:"createCaptureSource",security:bearer,
   parameters:[tenantHeader,idempotencyHeader],
   requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/CaptureSourceCreateRequest"}}}},
   responses:{"201":jsonResponse("CaptureSourceResponse"),"400":errorResponse,"401":errorResponse,"404":errorResponse,"409":errorResponse}}
 },
 "/v1/capture-sources/{id}/checkpoint":{post:{operationId:"checkpointCaptureSource",security:bearer,
  parameters:[{name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}},
   tenantHeader,idempotencyHeader,{name:"If-Match",in:"header",required:true,schema:{type:"string"}}],
  requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/CaptureSourceCheckpointRequest"}}}},
  responses:{"200":jsonResponse("CaptureSourceResponse"),"400":errorResponse,"401":errorResponse,"404":errorResponse,"409":errorResponse,"410":errorResponse}}},
 "/v1/capture-sources/{id}/revoke":{post:{operationId:"revokeCaptureSource",security:bearer,
  parameters:[{name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}},
   tenantHeader,idempotencyHeader,{name:"If-Match",in:"header",required:true,schema:{type:"string"}}],
  responses:{"200":jsonResponse("CaptureSourceResponse"),"400":errorResponse,"401":errorResponse,"404":errorResponse,"409":errorResponse}}},
 "/v1/ingestions":{post:{operationId:"prepareIngestion",security:bearer,parameters:[tenantHeader,ingestionAttemptHeader],
  requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/IngestionPrepareRequest"}}}},
  responses:{"201":jsonResponse("IngestionPrepareResponse"),"400":errorResponse,"401":errorResponse,"404":errorResponse,"409":errorResponse,"413":errorResponse,"503":errorResponse}}},
 "/v1/ingestions/{id}/complete":{post:{operationId:"completeIngestion",security:bearer,parameters:[
  {name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}},tenantHeader,ingestionAttemptHeader],
  requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/IngestionCompleteRequest"}}}},
  responses:{"200":jsonResponse("IngestionReceiptResponse"),"400":errorResponse,"401":errorResponse,"404":errorResponse,"409":errorResponse,"422":errorResponse,"503":errorResponse}}},
};
output("packages/contracts/generated/openapi.json",JSON.stringify({openapi:"3.1.0",info:{title:"Sigongnote API",version:"1.0.0"},paths,components:{securitySchemes:{bearerAuth:{type:"http",scheme:"bearer",bearerFormat:"JWT"}},schemas:documents}},null,2)+"\n");

function normalize(schema:Schema):Schema {
 const expand=(item:Schema):Schema[]=>{const nested=item.oneOf??item.anyOf;return nested?nested.flatMap(expand):[item];};
 const variants=(schema.oneOf??schema.anyOf)?.flatMap(expand);
 if(variants?.every(item=>item.type==="object")) {
  const keys=[...new Set(variants.flatMap(item=>Object.keys(item.properties??{})))];
  return {type:"object",properties:Object.fromEntries(keys.map(key=>[key,{anyOf:variants.flatMap(item=>item.properties?.[key] ? [item.properties[key]] : [])}])),
   required:keys.filter(key=>variants.every(item=>item.required?.includes(key)))};
 }
 return variants ? {...schema,anyOf:variants} : schema;
}
function native(language:"cs"|"kt") {
 const definitions = new Map<string,string>();
 const shapes = new Map<string,string>();
 const cap=(value:string)=>value.split("_").map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join("");
 function type(raw:Schema,name:string):string {
  const s=normalize(raw);
  if(Array.isArray(s.type)) {
   const nullable=s.type.includes("null");
   const others=s.type.filter(value=>value!=="null");
   if(others.length!==1) throw new Error(`Unsupported native union: ${name}`);
   const value=type({...s,type:others[0]!},name);
   return nullable&&!value.endsWith("?") ? value+"?" : value;
  }
  if(s.anyOf) {
   const nullable=s.anyOf.some(v=>v.type==="null");
   const others=s.anyOf.filter(v=>v.type!=="null");
   if(!others.length) return language==="cs" ? "string?" : "String?";
   const types=[...new Set(others.map(v=>type(v,name)))];
   if(types.length!==1) throw new Error(`Unsupported native union: ${name}`);
   const value=types[0] as string;
   return nullable && !value.endsWith("?") ? value+"?" : value;
  }
  if(s.type==="object") {
   const fingerprint=JSON.stringify(s);
   if(definitions.has(name)) {
    if(shapes.get(name)!==fingerprint) throw new Error(`Native type name collision: ${name}`);
    return name;
   }
   shapes.set(name,fingerprint);
   definitions.set(name,"");
   const entries=Object.entries(s.properties??{}).sort(([a],[b])=>Number(s.required?.includes(b))-Number(s.required?.includes(a)));
   const fields=entries.map(([key,property])=>{
    // Keep wire keys while escaping reserved C# parameter names (for example "checked").
    const csKey=/^(abstract|as|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|ref|return|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|virtual|void|volatile|while)$/.test(key)?'@'+key:key;
    const optional=!s.required?.includes(key);
    let fieldType=type(property,name+cap(key));
    if(optional&&!fieldType.endsWith("?")) fieldType+="?";
    const ignore=optional ? "WhenWritingNull" : "Never";
    return language==="cs" ? `[property: JsonIgnore(Condition = JsonIgnoreCondition.${ignore})] ${fieldType} ${csKey}${optional ? " = null" : ""}` : `val ${key}: ${fieldType}${optional ? " = null" : ""}`;
   });
   definitions.set(name,language==="cs" ? `public sealed record ${name}(${fields.join(", ")});\n` : fields.length ? `@Serializable\ndata class ${name}(\n  ${fields.join(",\n  ")}\n)\n` : `@Serializable\nclass ${name}\n`);
   return name;
  }
  if(s.type==="array") { const item=type(s.items??{} ,name+"Item"); return language==="cs" ? item+"[]" : `List<${item}>`; }
  if(s.type==="integer" || (typeof s.const==="number" && Number.isInteger(s.const))) {
   const wide=(s.maximum??0)>2147483647||(s.minimum??0)<-2147483648||(typeof s.const==='number'&&(s.const>2147483647||s.const< -2147483648));
   return language==='cs'?(wide?'long':'int'):(wide?'Long':'Int');
  }
  if(s.type==="number") return language==="cs"?"double":"Double";
  if(s.type==="boolean") return language==="cs"?"bool":"Boolean";
  if(s.type==="string" || typeof s.const==="string") return language==="cs"?"string":"String";
  if(s.type==="null") return language==="cs"?"string?":"String?";
  throw new Error(`Unsupported schema type: ${name}`);
 }
 for(const [name,schema] of Object.entries(documents)) type(schema as Schema,name);
 return header+(language==="cs"?"#nullable enable\nusing System.Text.Json.Serialization;\nnamespace Sigongnote.Contracts;\n":"package com.sigongnote.contracts\n\nimport kotlinx.serialization.Serializable\n\n")+[...definitions.values()].join("\n");
}
output("packages/contracts/generated/csharp/Contracts.g.cs",native("cs"));
output("packages/contracts/generated/kotlin/Contracts.kt",native("kt"));
console.log("PASS");
