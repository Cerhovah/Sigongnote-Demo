import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres from "postgres";
import { parseTradePack } from "../packages/domain/src/trade-pack.ts";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";
import { createApp } from "../services/api/src/app.ts";

test("C40 quote pins sourced rate and keeps unknown costs unapproved",async()=>{
  assert.equal((await verifyLocalDevelopmentDb()).status,"READY");
  const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
  assert.ok(env.MIGRATION_DATABASE_URL && env.DATABASE_URL);
  const admin=postgres(env.MIGRATION_DATABASE_URL,{max:1});
  const runtime=postgres(env.DATABASE_URL,{max:2});
  const actor=randomUUID(),session=randomUUID(),tenant=randomUUID(),otherTenant=randomUUID();
  const project=randomUUID(),order=randomUUID(),bundle=randomUUID(),evidence=randomUUID();
  const rateId=randomUUID(),decisionId=randomUUID();
  const pack=parseTradePack(JSON.parse(readFileSync("trade-packs/joinery/1.0.0.json","utf8")));
  const app=createApp({db:runtime,verifyToken:async()=>({userId:actor,sessionId:session})});
  let seeded=false;
  const call=async(method:"POST"|"GET",url:string,body?:unknown,tenantHeader=tenant,key=randomUUID())=>
    await app.inject({method,url,headers:{authorization:"Bearer fixture", "x-tenant-id":tenantHeader,
      "idempotency-key":key},...(body===undefined?{}:{payload:body as object})});
  const acceptanceEvidence=async(sha:string,quoteMarker?:string)=>{
    const id=randomUUID();
    await admin.begin(async tx=>{
      const [blob]=await tx`insert into app.evidence_blobs
        (tenant_id,sha256,byte_length,sniffed_mime,storage_key)
        values (${tenant}::uuid,${sha},1,'text/plain',${`${tenant}/accept-${id}`}) returning id`;
      const [document]=await tx`insert into app.documents(tenant_id)
        values (${tenant}::uuid) returning id`;
      const [revision]=await tx`insert into app.document_revisions
        (tenant_id,document_id,revision_number,blob_id,declared_mime)
        values (${tenant}::uuid,${document?.id}::uuid,1,${blob?.id}::uuid,'text/plain') returning id`;
      await tx`insert into app.evidence_index
        (tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
        values (${tenant}::uuid,${id}::uuid,${revision?.id}::uuid,'unassigned',
          'agreement','synthetic acceptance','synthetic',
          ${tx.json({kind:"text",position:{line:1,
            ...(quoteMarker?{quote_snapshot_sha256:quoteMarker}:{})}})},'original')`;
    });
    return id;
  };
  try {
    await admin.begin(async tx=>{
      await tx`insert into auth.users(id) values (${actor}::uuid)`;
      await tx`insert into auth.sessions(id,user_id) values (${session}::uuid,${actor}::uuid)`;
      await tx`insert into app.tenants(id,display_name) values
        (${tenant}::uuid,'C40 fixture'),(${otherTenant}::uuid,'C40 foreign')`;
      await tx`insert into app.memberships(tenant_id,user_id,role)
        values (${tenant}::uuid,${actor}::uuid,'owner')`;
      await tx`insert into app.projects(tenant_id,id,display_name)
        values (${tenant}::uuid,${project}::uuid,'C40')`;
      await tx`insert into app.work_orders(tenant_id,id,project_id,display_name)
        values (${tenant}::uuid,${order}::uuid,${project}::uuid,'C40')`;
      await tx`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,
        trade_pack_id,trade_pack_version,trade_pack_hash)
        values (${tenant}::uuid,${bundle}::uuid,${order}::uuid,'C40',
          ${pack.packId},${pack.version},${pack.contentHash})`;
      const [blob]=await tx`insert into app.evidence_blobs
        (tenant_id,sha256,byte_length,sniffed_mime,storage_key)
        values (${tenant}::uuid,${"a".repeat(64)},1,'text/plain',${`${tenant}/quote-source`})
        returning id`;
      const [document]=await tx`insert into app.documents(tenant_id)
        values (${tenant}::uuid) returning id`;
      const [revision]=await tx`insert into app.document_revisions
        (tenant_id,document_id,revision_number,blob_id,declared_mime)
        values (${tenant}::uuid,${document?.id}::uuid,1,${blob?.id}::uuid,'text/plain')
        returning id`;
      await tx`insert into app.evidence_index
        (tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
        values (${tenant}::uuid,${evidence}::uuid,${revision?.id}::uuid,'unassigned',
          'agreement','synthetic','synthetic',${tx.json({kind:"text",position:{line:1}})},'original')`;
      await tx`insert into app.decisions
        (tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
        values (${tenant}::uuid,${decisionId}::uuid,${actor}::uuid,'rate_observation',
          'confirm_source_rate',${tx.array([rateId],2950)},${tx.array([1],20)},
          ${tx.array([evidence],2950)},'C40 synthetic rate source',${"b".repeat(64)})`;
      await tx`insert into app.rate_observations
        (tenant_id,id,actor_id,decision_id,evidence_id,source_revision_id,
          source_blob_sha256,trade_pack_id,trade_pack_version,category,unit_code,
          rate_minor,tax_mode,external_origin_attested,observed_on,valid_until,
          condition_tags)
        values (${tenant}::uuid,${rateId}::uuid,${actor}::uuid,${decisionId}::uuid,
          ${evidence}::uuid,${revision?.id}::uuid,${"a".repeat(64)},'joinery','1.0.0',
          'labor','day',1000000,'exclusive',true,current_date,current_date+30,
          ${tx.array([],25)})`;
    });
    seeded=true;
    const coverage=pack.costCategories.concat("owner_labor","allocated_overhead")
      .map(category=>({category,state:category==="labor"?"included":"excluded",
        reason:category==="labor"?null:"not in this scope"}));
    const quoteId=randomUUID(),revisionId=randomUUID(),quoteCostId=randomUUID();
    const body={id:quoteId,revision_id:revisionId,bundle_id:bundle,kind:"new",
      target_order_id:null,expected_order_version:null,margin_bps:2000,
      vat_mode:"exclusive",condition_tags:[],cost_coverage:coverage,
      lines:[{id:quoteCostId,category:"labor",quantity_value:"1",
        unit_code:"day",source_rate_id:rateId}]};
    const key=randomUUID();
    const created=await call("POST","/v1/quotes",body,tenant,key);
    assert.equal(created.statusCode,201,created.body);
    assert.deepEqual([created.json().base_cost_minor,created.json().supply_minor,
      created.json().vat_minor,created.json().total_minor],
      ["1000000","1250000","125000","1375000"]);
    assert.equal(created.json().external_share_allowed,false);
    assert.equal((await call("POST","/v1/quotes",body,tenant,key)).json().id,quoteId);
    const shown=await call("GET",`/v1/quotes/${quoteId}`);
    assert.equal(shown.statusCode,200,shown.body);
    assert.equal(shown.json().stale,false);
    await admin`update app.work_bundles set trade_pack_hash=${"c".repeat(64)}
      where tenant_id=${tenant}::uuid and id=${bundle}::uuid`;
    assert.equal((await call("GET",`/v1/quotes/${quoteId}`)).json().stale,true);
    await admin`update app.work_bundles set trade_pack_hash=${pack.contentHash}
      where tenant_id=${tenant}::uuid and id=${bundle}::uuid`;
    assert.equal((await call("GET",`/v1/quotes/${quoteId}`,undefined,otherTenant)).statusCode,404);
    const conversation=randomUUID(),draftTurn=randomUUID();
    const draftResponse=await call("POST",`/v1/conversations/${conversation}/turns`,{client_turn_id:draftTurn,text:"견적서 준비해줘",selected_project_id:project,attachment_refs:[]});
    assert.equal(draftResponse.statusCode,200,draftResponse.body);
    const draftId=draftResponse.json().document_draft.id;
    const draft=await call("GET",`/v1/document-drafts/${draftId}`);assert.equal(draft.statusCode,200,draft.body);assert.ok(draft.json().missing.includes("부가세 조건"));
    const filled=await call("POST",`/v1/document-drafts/${draftId}/complete`,{client_command_id:randomUUID(),recipient:"합성 고객",tax_mode:"exclusive",tax_bps:1000});assert.equal(filled.statusCode,200,filled.body);
    const finalDraft=await call("GET",`/v1/document-drafts/${filled.json().id}`);assert.equal(finalDraft.statusCode,200,finalDraft.body);assert.equal(finalDraft.json().state,"draft_ready");assert.equal(finalDraft.json().document.totals.total,"1375000");assert.equal(finalDraft.json().stale,false);
    const [newQuote]=await admin`select quote_revision_id from app.document_drafts where tenant_id=${tenant}::uuid and id=${filled.json().id}::uuid`;assert.ok(newQuote?.quote_revision_id);assert.notEqual(newQuote?.quote_revision_id,revisionId);
    const approvalId=randomUUID(),scopeId=randomUUID();
    const approved=await call("POST",`/v1/quotes/${quoteId}/approve`,{
      id:approvalId,expected_quote_version:1,reason:"C41 synthetic quote approval",
      customer_exclusions:["Site demolition excluded"],customer_disclosure_attested:true,
      scope_lines:[{id:scopeId,display_name:"Synthetic scope",quantity_value:"30",
        unit_code:"day",operation:"add",target_contract_line_id:null,
        expected_line_version:null,cost_line_ids:[quoteCostId]}]});
    assert.equal(approved.statusCode,201,approved.body);
    assert.equal(approved.json().customer_snapshot.supply_minor,"1250000");
    assert.equal(approved.json().customer_snapshot.scope_lines[0].supply_minor,"1250000");
    assert.equal(approved.json().customer_snapshot.condition_tags,undefined);
    assert.equal(approved.json().pdf_state,"not_rendered");
    const handoff=await call("GET",`/v1/quotes/${quoteId}/approved-snapshot`);
    assert.equal(handoff.statusCode,200,handoff.body);
    assert.equal(handoff.json().snapshot_sha256,approved.json().snapshot_sha256);
    const mismatchedEvidence=await acceptanceEvidence("b".repeat(64),"0".repeat(64));
    const mismatchBody={id:randomUUID(),approval_id:approvalId,expected_quote_version:2,
      acceptance_evidence_id:mismatchedEvidence,
      accepted_snapshot_sha256:approved.json().snapshot_sha256,
      manual_agreement_match_attested:true,
      new_project_id:project,new_order_id:randomUUID(),new_bundle_id:randomUUID(),
      new_order_name:"Rejected mismatch",new_bundle_name:"Rejected mismatch",
      reason:"C41 signed old quote mismatch"};
    assert.equal((await call("POST",`/v1/quotes/${quoteId}/accept`,mismatchBody)).statusCode,422);
    const firstAcceptanceEvidence=await acceptanceEvidence("c".repeat(64));
    const acceptanceId=randomUUID(),newOrderId=randomUUID(),newBundleId=randomUUID();
    const acceptBody={id:acceptanceId,approval_id:approvalId,expected_quote_version:2,
      acceptance_evidence_id:firstAcceptanceEvidence,
      accepted_snapshot_sha256:approved.json().snapshot_sha256,
      manual_agreement_match_attested:true,
      new_project_id:project,new_order_id:newOrderId,new_bundle_id:newBundleId,
      new_order_name:"Accepted synthetic work",new_bundle_name:"Accepted scope",
      reason:"C41 synthetic quote acceptance"};
    const acceptKey=randomUUID();
    const accepted=await call("POST",`/v1/quotes/${quoteId}/accept`,acceptBody,tenant,acceptKey);
    assert.equal(accepted.statusCode,201,accepted.body);
    assert.equal(accepted.json().contract_line_effects,1);
    assert.equal((await call("POST",`/v1/quotes/${quoteId}/revise`,{
      id:randomUUID(),expected_quote_version:3,margin_bps:3000,
      reason:"C41 accepted quote cannot revise"})).statusCode,422);
    assert.equal((await call("POST",`/v1/quotes/${quoteId}/accept`,acceptBody,
      tenant,acceptKey)).json().acceptance_id,acceptanceId);
    const [contract]=await admin`select quantity_value,supply_minor,work_bundle_id
      from app.contract_lines
      where tenant_id=${tenant}::uuid and id=${scopeId}::uuid`;
    assert.equal(contract?.quantity_value,"30");
    assert.equal(String(contract?.supply_minor),"1250000");
    assert.equal(contract?.work_bundle_id,newBundleId);
    const untouchedId=randomUUID();
    await admin`insert into app.contract_lines
      (tenant_id,id,work_order_id,display_name,unit_code,quantity_value,supply_minor)
      values (${tenant}::uuid,${untouchedId}::uuid,${newOrderId}::uuid,'Unchanged scope',
        'day','20',200000)`;
    const amendmentId=randomUUID(),amendmentRevision=randomUUID(),amendmentCostId=randomUUID();
    const amendment={...body,id:amendmentId,revision_id:amendmentRevision,
      bundle_id:newBundleId,kind:"amendment",target_order_id:newOrderId,
      expected_order_version:1,lines:[{...body.lines[0],id:amendmentCostId}]};
    const amended=await call("POST","/v1/quotes",amendment);
    assert.equal(amended.statusCode,201,amended.body);
    const amendmentApproval=randomUUID();
    const amendApproved=await call("POST",`/v1/quotes/${amendmentId}/approve`,{
      id:amendmentApproval,expected_quote_version:1,
      reason:"C41 synthetic replacement approval",
      customer_exclusions:[],customer_disclosure_attested:true,
      scope_lines:[{id:randomUUID(),display_name:"Replacement scope",quantity_value:"35",
        unit_code:"day",operation:"replace",target_contract_line_id:scopeId,
        expected_line_version:1,cost_line_ids:[amendmentCostId]}]});
    assert.equal(amendApproved.statusCode,201,amendApproved.body);
    const secondAcceptanceEvidence=await acceptanceEvidence("d".repeat(64));
    const amendmentAccepted=await call("POST",`/v1/quotes/${amendmentId}/accept`,{
      id:randomUUID(),approval_id:amendmentApproval,expected_quote_version:2,
      acceptance_evidence_id:secondAcceptanceEvidence,
      accepted_snapshot_sha256:amendApproved.json().snapshot_sha256,
      manual_agreement_match_attested:true,
      new_project_id:null,new_order_id:null,new_bundle_id:null,
      new_order_name:null,new_bundle_name:null,reason:"C41 synthetic replacement accepted"});
    assert.equal(amendmentAccepted.statusCode,201,amendmentAccepted.body);
    const [replaced]=await admin`select quantity_value,version from app.contract_lines
      where tenant_id=${tenant}::uuid and id=${scopeId}::uuid`;
    assert.equal(replaced?.quantity_value,"35");
    assert.equal(Number(replaced?.version),2);
    const [untouched]=await admin`select quantity_value,version from app.contract_lines
      where tenant_id=${tenant}::uuid and id=${untouchedId}::uuid`;
    assert.deepEqual([untouched?.quantity_value,Number(untouched?.version)],["20",1]);
    const history=await admin`select quantity_value from app.contract_line_revisions
      where tenant_id=${tenant}::uuid and contract_line_id=${scopeId}::uuid order by version`;
    assert.deepEqual(history.map(item=>item.quantity_value),["30","35"]);
    const billingDecision=randomUUID(),invoiceDecision=randomUUID(),agreementId=randomUUID(),
      invoiceId=randomUUID();
    await admin.begin(async tx=>{
      await tx`insert into app.decisions
        (tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,
          reason,payload_hash)
        values (${tenant}::uuid,${billingDecision}::uuid,${actor}::uuid,
          'billing_agreement','confirm_fixture',${tx.array([newBundleId],2950)},
          ${tx.array([1],20)},${tx.array([firstAcceptanceEvidence],2950)},
          'C41 synthetic billing basis',${"e".repeat(64)})`;
      await tx`insert into app.billing_agreements
        (tenant_id,id,bundle_id,source_evidence_id,approved_gross_minor,decision_id)
        values (${tenant}::uuid,${agreementId}::uuid,${newBundleId}::uuid,
          ${firstAcceptanceEvidence}::uuid,1000000,${billingDecision}::uuid)`;
      await tx`insert into app.decisions
        (tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,
          reason,payload_hash)
        values (${tenant}::uuid,${invoiceDecision}::uuid,${actor}::uuid,
          'invoice_approval','approve_fixture',${tx.array([invoiceId],2950)},
          ${tx.array([1],20)},${tx.array([firstAcceptanceEvidence],2950)},
          'C41 synthetic invoice basis',${"f".repeat(64)})`;
      await tx`insert into app.invoices
        (tenant_id,id,direction,status,stage,tax_mode,bundle_id,agreement_id,sequence,
          source_evidence_id,approval_decision_id)
        values (${tenant}::uuid,${invoiceId}::uuid,'receivable','draft','progress',
          'not_applicable',${newBundleId}::uuid,${agreementId}::uuid,1,
          ${firstAcceptanceEvidence}::uuid,null)`;
      await tx`insert into app.invoice_lines
        (tenant_id,invoice_id,supply_minor,gross_minor)
        values (${tenant}::uuid,${invoiceId}::uuid,1000000,1000000)`;
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx`update app.invoices set status='approved',version=2,approval_decision_id=${invoiceDecision}::uuid where tenant_id=${tenant}::uuid and id=${invoiceId}::uuid`;
    });
    const reductionId=randomUUID(),reductionCostId=randomUUID();
    const reducedDraft=await call("POST","/v1/quotes",{
      ...amendment,id:reductionId,revision_id:randomUUID(),expected_order_version:2,
      lines:[{...amendment.lines[0],id:reductionCostId,quantity_value:"0.5"}]});
    assert.equal(reducedDraft.statusCode,201,reducedDraft.body);
    const reducedApproval=randomUUID();
    const reducedApproved=await call("POST",`/v1/quotes/${reductionId}/approve`,{
      id:reducedApproval,expected_quote_version:1,
      customer_exclusions:[],customer_disclosure_attested:true,
      reason:"C41 synthetic reduction approval",
      scope_lines:[{id:randomUUID(),display_name:"Reduced scope",quantity_value:"20",
        unit_code:"day",operation:"replace",target_contract_line_id:scopeId,
        expected_line_version:2,cost_line_ids:[reductionCostId]}]});
    assert.equal(reducedApproved.statusCode,201,reducedApproved.body);
    await admin`update app.evidence_index set recorded_at=now()
      where tenant_id=${tenant}::uuid and id=${firstAcceptanceEvidence}::uuid`;
    const reductionAccept={id:randomUUID(),approval_id:reducedApproval,
      expected_quote_version:2,acceptance_evidence_id:firstAcceptanceEvidence,
      accepted_snapshot_sha256:reducedApproved.json().snapshot_sha256,
      manual_agreement_match_attested:true,
      new_project_id:null,new_order_id:null,new_bundle_id:null,
      new_order_name:null,new_bundle_name:null,reason:"C41 synthetic reduction acceptance"};
    assert.equal((await call("POST",`/v1/quotes/${reductionId}/accept`,
      reductionAccept)).statusCode,409);
    const thirdAcceptanceEvidence=await acceptanceEvidence("9".repeat(64));
    assert.equal((await call("POST",`/v1/quotes/${reductionId}/accept`,{
      ...reductionAccept,id:randomUUID(),acceptance_evidence_id:thirdAcceptanceEvidence})).statusCode,422);
    const [notReduced]=await admin`select quantity_value from app.contract_lines
      where tenant_id=${tenant}::uuid and id=${scopeId}::uuid`;
    assert.equal(notReduced?.quantity_value,"35");
    const unknown={...body,id:randomUUID(),revision_id:randomUUID(),
      lines:[{...body.lines[0],id:randomUUID(),source_rate_id:null}]};
    const incomplete=await call("POST","/v1/quotes",unknown);
    assert.equal(incomplete.statusCode,201,incomplete.body);
    assert.equal(incomplete.json().state,"needs_inputs");
    assert.equal(incomplete.json().supply_minor,null);
    const revisedQuoteId=randomUUID(),oldRevisionId=randomUUID(),newRevisionId=randomUUID(),
      revisedCostId=randomUUID();
    const marginDraft=await call("POST","/v1/quotes",{...body,id:revisedQuoteId,
      revision_id:oldRevisionId,lines:[{...body.lines[0],id:revisedCostId}]});
    assert.equal(marginDraft.statusCode,201,marginDraft.body);
    const supersededApproval=await call("POST",`/v1/quotes/${revisedQuoteId}/approve`,{
      id:randomUUID(),expected_quote_version:1,
      customer_exclusions:[],customer_disclosure_attested:true,
      reason:"C41 synthetic superseded approval",
      scope_lines:[{id:randomUUID(),display_name:"Superseded scope",quantity_value:"1",
        unit_code:"day",operation:"add",target_contract_line_id:null,
        expected_line_version:null,cost_line_ids:[revisedCostId]}]});
    assert.equal(supersededApproval.statusCode,201,supersededApproval.body);
    const revise=await call("POST",`/v1/quotes/${revisedQuoteId}/revise`,{
      id:newRevisionId,expected_quote_version:2,margin_bps:3000,
      reason:"C41 synthetic margin revision"});
    assert.equal(revise.statusCode,201,revise.body);
    assert.equal(revise.json().supply_minor,"1428572");
    assert.equal((await call("GET",`/v1/quotes/${revisedQuoteId}/approved-snapshot`)).statusCode,404);
    const comparison=await call("GET",`/v1/quotes/${revisedQuoteId}/compare`);
    assert.equal(comparison.statusCode,200,comparison.body);
    assert.deepEqual([comparison.json().before.margin_bps,comparison.json().after.margin_bps,
      comparison.json().supply_delta_minor],[2000,3000,"178572"]);
  } finally {
    await app.close();
    try { if (seeded) await admin.begin(async tx=>{
      await tx`delete from app.document_drafts where tenant_id=${tenant}::uuid and supersedes_id is not null`;
      await tx`delete from app.document_drafts where tenant_id=${tenant}::uuid`;
      await tx`delete from app.conversation_turns where tenant_id=${tenant}::uuid`;
      await tx`delete from app.conversations where tenant_id=${tenant}::uuid`;
      await tx`delete from app.command_receipts where tenant_id=${tenant}::uuid`;
      await tx`delete from app.contract_line_revisions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.contract_lines where tenant_id=${tenant}::uuid`;
      await tx`delete from app.quote_acceptances where tenant_id=${tenant}::uuid`;
      await tx`delete from app.quote_scope_lines where tenant_id=${tenant}::uuid`;
      await tx`delete from app.quote_approvals where tenant_id=${tenant}::uuid`;
      await tx`delete from app.invoice_lines where tenant_id=${tenant}::uuid`;
      await tx`delete from app.invoices where tenant_id=${tenant}::uuid`;
      await tx`delete from app.billing_agreements where tenant_id=${tenant}::uuid`;
      await tx`delete from app.quote_lines where tenant_id=${tenant}::uuid`;
      await tx`update app.quotes set current_revision_id=null where tenant_id=${tenant}::uuid`;
      await tx`delete from app.quote_revisions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.quotes where tenant_id=${tenant}::uuid`;
      await tx`delete from app.rate_observations where tenant_id=${tenant}::uuid`;
      await tx`delete from app.decisions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.evidence_index where tenant_id=${tenant}::uuid`;
      await tx`delete from app.document_revisions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.documents where tenant_id=${tenant}::uuid`;
      await tx`delete from app.evidence_blobs where tenant_id=${tenant}::uuid`;
      await tx`delete from app.work_bundles where tenant_id=${tenant}::uuid`;
      await tx`delete from app.work_orders where tenant_id=${tenant}::uuid`;
      await tx`delete from app.projects where tenant_id=${tenant}::uuid`;
      await tx`alter table app.memberships disable trigger memberships_guard`;
      await tx`delete from app.memberships where tenant_id=${tenant}::uuid`;
      await tx`alter table app.memberships enable trigger memberships_guard`;
      await tx`delete from app.tenants where id in (${tenant}::uuid,${otherTenant}::uuid)`;
      await tx`delete from auth.sessions where id=${session}::uuid`;
      await tx`delete from auth.users where id=${actor}::uuid`;
    }); } finally { await runtime.end();await admin.end(); }
  }
});
