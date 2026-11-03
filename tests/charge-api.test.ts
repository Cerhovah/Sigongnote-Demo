import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres from "postgres";
import { parseTradePack } from "../packages/domain/src/trade-pack.ts";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";
import { createApp } from "../services/api/src/app.ts";

test("C31b charge candidate and owner-confirmed revision persist once with tenant and CAS guards", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  assert.ok(env.MIGRATION_DATABASE_URL && env.DATABASE_URL);
  const admin = postgres(env.MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(env.DATABASE_URL, { max: 2 });
  const actor = randomUUID(), session = randomUUID(), tenant = randomUUID(), foreignTenant = randomUUID();
  const project = randomUUID(), order = randomUUID(), bundle = randomUUID(), secondBundle = randomUUID();
  const evidence = randomUUID(), adjustmentEvidence = randomUUID(), agreementEvidence = randomUUID();
  const cashNotificationEvidence=randomUUID(),secondBankEvidence=randomUUID(),
    settlementEvidence=randomUUID();
  const productEvidence1=randomUUID(),productEvidence2=randomUUID(),
    submissionEvidence=randomUUID(),replyEvidence=randomUUID(),
    oldReplyEvidence=randomUUID(),defectEvidence=randomUUID();
  let productRevision1:string|undefined,productRevision2:string|undefined;
  const chargeId = randomUUID();
  const pack = parseTradePack(JSON.parse(readFileSync("trade-packs/joinery/1.0.0.json", "utf8")));
  const app = createApp({ db: runtime, verifyToken: async () => ({ userId: actor, sessionId: session }) });
  let seeded = false;
  try {
    await admin.begin(async tx => {
      await tx`insert into auth.users(id) values (${actor}::uuid)`;
      await tx`insert into auth.sessions(id,user_id) values (${session}::uuid,${actor}::uuid)`;
      await tx`insert into app.tenants(id,display_name) values (${tenant}::uuid,'C31 own'),(${foreignTenant}::uuid,'C31 foreign')`;
      await tx`insert into app.memberships(tenant_id,user_id,role) values (${tenant}::uuid,${actor}::uuid,'owner')`;
      await tx`insert into app.projects(tenant_id,id,display_name) values (${tenant}::uuid,${project}::uuid,'fixture')`;
      await tx`insert into app.work_orders(tenant_id,id,project_id,display_name)
        values (${tenant}::uuid,${order}::uuid,${project}::uuid,'fixture')`;
      await tx`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,
        trade_pack_id,trade_pack_version,trade_pack_hash)
        values (${tenant}::uuid,${bundle}::uuid,${order}::uuid,'fixture',
          ${pack.packId},${pack.version},${pack.contentHash})`;
      await tx`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,
        trade_pack_id,trade_pack_version,trade_pack_hash)
        values (${tenant}::uuid,${secondBundle}::uuid,${order}::uuid,'fixture 2',
          ${pack.packId},${pack.version},${pack.contentHash})`;
      const [blob] = await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key)
        values (${tenant}::uuid,${"d".repeat(64)},1,'text/plain',${`${tenant}/c31`}) returning id`;
      const [document] = await tx`insert into app.documents(tenant_id) values (${tenant}::uuid) returning id`;
      const [revision] = await tx`insert into app.document_revisions(tenant_id,document_id,revision_number,blob_id,declared_mime)
        values (${tenant}::uuid,${document?.id}::uuid,1,${blob?.id}::uuid,'text/plain') returning id`;
      await tx`insert into app.evidence_index(tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
        values (${tenant}::uuid,${evidence}::uuid,${revision?.id}::uuid,'unassigned','delivery_work',
          'fixture','synthetic',${tx.json({kind:"text",position:{line:1}})},'original')`;
      const [adjustmentBlob] = await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key)
        values (${tenant}::uuid,${"e".repeat(64)},1,'text/plain',${`${tenant}/c32`}) returning id`;
      const [adjustmentDocument] = await tx`insert into app.documents(tenant_id) values (${tenant}::uuid) returning id`;
      const [adjustmentRevision] = await tx`insert into app.document_revisions(tenant_id,document_id,revision_number,blob_id,declared_mime)
        values (${tenant}::uuid,${adjustmentDocument?.id}::uuid,1,${adjustmentBlob?.id}::uuid,'text/plain') returning id`;
      await tx`insert into app.evidence_index(tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
        values (${tenant}::uuid,${adjustmentEvidence}::uuid,${adjustmentRevision?.id}::uuid,'unassigned','billing_payment',
          'fixture adjustment','synthetic',${tx.json({kind:"text",position:{line:1}})},'original')`;
      const [agreementBlob] = await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key)
        values (${tenant}::uuid,${"f".repeat(64)},1,'text/plain',${`${tenant}/c33-agreement`}) returning id`;
      const [agreementDocument] = await tx`insert into app.documents(tenant_id) values (${tenant}::uuid) returning id`;
      const [agreementRevision] = await tx`insert into app.document_revisions(tenant_id,document_id,revision_number,blob_id,declared_mime)
        values (${tenant}::uuid,${agreementDocument?.id}::uuid,1,${agreementBlob?.id}::uuid,'text/plain') returning id`;
      await tx`insert into app.evidence_index(tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
        values (${tenant}::uuid,${agreementEvidence}::uuid,${agreementRevision?.id}::uuid,'unassigned','agreement',
          'fixture agreement','synthetic',${tx.json({kind:"text",position:{line:1}})},'original')`;
      for (const item of [{id:cashNotificationEvidence,sha:"1".repeat(64),source:"notification_fragment",
        category:"billing_payment"},{id:secondBankEvidence,sha:"2".repeat(64),source:"original",
        category:"billing_payment"},{id:settlementEvidence,sha:"3".repeat(64),source:"original",
        category:"agreement"}]) {
        const [cashBlob]=await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key)
          values (${tenant}::uuid,${item.sha},1,'text/plain',${`${tenant}/cash-${item.id}`}) returning id`;
        const [cashDocument]=await tx`insert into app.documents(tenant_id) values (${tenant}::uuid) returning id`;
        const [cashRevision]=await tx`insert into app.document_revisions(tenant_id,document_id,revision_number,blob_id,declared_mime)
          values (${tenant}::uuid,${cashDocument?.id}::uuid,1,${cashBlob?.id}::uuid,'text/plain') returning id`;
        await tx`insert into app.evidence_index(tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
          values (${tenant}::uuid,${item.id}::uuid,${cashRevision?.id}::uuid,'unassigned',${item.category},
            'cash fixture','synthetic',${tx.json({kind:"text",position:{line:1}})},${item.source})`;
      }
      for (const item of [{id:productEvidence1,sha:"4".repeat(64),category:"drawing_material",
        scope:"product_reference"},{id:productEvidence2,sha:"5".repeat(64),category:"drawing_material",
        scope:"product_reference"},{id:submissionEvidence,sha:"6".repeat(64),category:"drawing_material",
        scope:"unassigned"},{id:replyEvidence,sha:"7".repeat(64),category:"drawing_material",
        scope:"unassigned"},{id:oldReplyEvidence,sha:"9".repeat(64),category:"drawing_material",
        scope:"unassigned"},{id:defectEvidence,sha:"8".repeat(64),category:"inspection_defect",
        scope:"unassigned"}]) {
        const [itemBlob]=await tx`insert into app.evidence_blobs
          (tenant_id,sha256,byte_length,sniffed_mime,storage_key)
          values (${tenant}::uuid,${item.sha},1,'text/plain',${`${tenant}/c35-${item.id}`}) returning id`;
        const [itemDocument]=await tx`insert into app.documents(tenant_id)
          values (${tenant}::uuid) returning id`;
        const [itemRevision]=await tx`insert into app.document_revisions
          (tenant_id,document_id,revision_number,blob_id,declared_mime)
          values (${tenant}::uuid,${itemDocument?.id}::uuid,1,${itemBlob?.id}::uuid,'text/plain')
          returning id`;
        if (item.id===productEvidence1) productRevision1=itemRevision?.id;
        if (item.id===productEvidence2) productRevision2=itemRevision?.id;
        await tx`insert into app.evidence_index
          (tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
          values (${tenant}::uuid,${item.id}::uuid,${itemRevision?.id}::uuid,${item.scope},
            ${item.category},'c35 fixture','synthetic',
            ${tx.json({kind:"text",position:{line:1}})},'original')`;
      }
    });
    seeded = true;
    const headers = { authorization: "Bearer fixture", "x-tenant-id": tenant };
    const candidate = { id: chargeId, tenantId: tenant, bundleId: bundle, category: "labor",
      partyId: null, identityState: "unresolved", canonicalCaseId: null,
      scopeQuantity: { value: "80", unitCode: "ea", semantic: "scope" },
      billingQuantity: { value: "5", unitCode: "day", semantic: "billing" },
      billingRateMinor: "300000", billingRatePerUnit: "day", expectedMinor: null, contractedMinor: null,
      documentedMinor: "1500000", confirmedActualMinor: null, customerChargeMinor: null,
      paidMinor: null, evidenceIds: [evidence], status: "candidate", taxMode: "unknown",
      settlementParentId: null };
    const key = randomUUID();
    const create = () => app.inject({ method: "POST", url: "/v1/charge-cases",
      headers: { ...headers, "idempotency-key": key }, payload: candidate });
    const [first, replay] = await Promise.all([create(), create()]);
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(replay.json(), first.json());
    await assert.rejects(admin`insert into app.charge_revisions
      (tenant_id,charge_case_id,version,actor_id,reason,payload,evidence_ids,confirmed_actual_minor,tax_mode)
      values (${tenant}::uuid,${chargeId}::uuid,99,${actor}::uuid,'fractional cost rejected',
        ${admin.json(candidate)},${admin.array([evidence],2950)},150000.5,'unknown')`,
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
    const confirmed = { ...candidate, partyId: randomUUID(), taxMode: "inclusive",
      confirmedActualMinor: "1500000", status: "confirmed" };
    const premature = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { charge: confirmed, reason: "합성 공임 근거 확인" } });
    assert.equal(premature.statusCode, 422);
    const attribution = await app.inject({ method: "POST", url: "/v1/decisions",
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { scope: "project_attribution", targets: [{ type: "evidence_index", id: evidence, version: 1 }],
        choice: "confirm_bundle", bundle_id: bundle, reason: "합성 원문과 이번 일 확인",
        evidence_ids: [evidence] } });
    assert.equal(attribution.statusCode, 201, attribution.body);
    const adjustmentAttribution = await app.inject({ method: "POST", url: "/v1/decisions",
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { scope: "project_attribution",
        targets: [{ type: "evidence_index", id: adjustmentEvidence, version: 1 }],
        choice: "confirm_bundle", bundle_id: bundle, reason: "합성 반품 원문과 이번 일 확인",
        evidence_ids: [adjustmentEvidence] } });
    assert.equal(adjustmentAttribution.statusCode, 201, adjustmentAttribution.body);
    const agreementAttribution = await app.inject({ method: "POST", url: "/v1/decisions",
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { scope: "project_attribution",
        targets: [{ type: "evidence_index", id: agreementEvidence, version: 1 }],
        choice: "confirm_bundle", bundle_id: bundle, reason: "합성 금액 합의 원문과 이번 일 확인",
        evidence_ids: [agreementEvidence] } });
    assert.equal(agreementAttribution.statusCode, 201, agreementAttribution.body);
    const settlementAttribution=await app.inject({method:"POST",url:"/v1/decisions",
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{scope:"project_attribution",
        targets:[{type:"evidence_index",id:settlementEvidence,version:1}],
        choice:"confirm_bundle",bundle_id:bundle,reason:"합성 별도 정산 합의 근거 귀속",
        evidence_ids:[settlementEvidence]}});
    assert.equal(settlementAttribution.statusCode,201,settlementAttribution.body);
    for (const item of [submissionEvidence,replyEvidence,oldReplyEvidence,defectEvidence]) {
      const linked=await app.inject({method:"POST",url:"/v1/decisions",
        headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
        payload:{scope:"project_attribution",targets:[{type:"evidence_index",id:item,version:1}],
          choice:"confirm_bundle",bundle_id:bundle,reason:"합성 제출 회신 하자 근거 귀속",
          evidence_ids:[item]}});
      assert.equal(linked.statusCode,201,linked.body);
    }
    const spoofed = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { charge: { ...confirmed, identityState: "confirmed_distinct" }, reason: "합성 공임 근거 확인" } });
    assert.equal(spoofed.statusCode, 422);
    const confirmation = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { charge: confirmed, reason: "합성 공임 근거 확인" } });
    assert.equal(confirmation.statusCode, 201, confirmation.body);
    assert.equal(confirmation.json().version, 2);
    assert.equal(confirmation.json().confirmed_actual_minor, "1500000");
    assert.equal(confirmation.json().changed_fields.includes("partyId"), true);
    const firstOutcomeId=randomUUID();
    const firstOutcome=await app.inject({method:"POST",url:"/v1/outcomes",
      headers:{...headers,"idempotency-key":randomUUID()},payload:{id:firstOutcomeId,
        bundle_id:bundle,expected_outcome_version:0,scope_completed:true,
        quantity_value:"5",unit_code:"day",owner_labor_included:null,
        revisit_count:0,transport_count:0,defect_count:0,
        condition_tags:["합성 실내"],evidence_ids:[evidence],
        reason:"확인된 공임 결과와 미정산 상태를 기록"}});
    assert.equal(firstOutcome.statusCode,201,firstOutcome.body);
    assert.equal(firstOutcome.json().actual_cost_minor,"1500000");
    assert.equal(firstOutcome.json().learning_eligible,false);
    assert.equal(firstOutcome.json().settlement_state,"unknown");
    const rate=await app.inject({method:"POST",url:"/v1/rate-observations",
      headers:{...headers,"idempotency-key":randomUUID()},payload:{id:randomUUID(),
        trade_pack_id:"joinery",trade_pack_version:"1.0.0",category:"labor",
        unit_code:"day",rate_minor:"300000",observed_on:"2026-09-29",
        valid_until:"2026-10-15",delivery_included:null,processing_included:null,
        condition_tags:["합성 실내"],evidence_id:agreementEvidence,
        tax_mode:"inclusive",external_origin_attested:true,
        reason:"합성 공임 현재 단가 원문 확인"}});
    assert.equal(rate.statusCode,201,rate.body);
    const duplicateRate=await app.inject({method:"POST",url:"/v1/rate-observations",
      headers:{...headers,"idempotency-key":randomUUID()},payload:{id:randomUUID(),
        trade_pack_id:"joinery",trade_pack_version:"1.0.0",category:"labor",
        unit_code:"day",rate_minor:"300000",observed_on:"2026-09-29",
        valid_until:"2026-10-15",delivery_included:null,processing_included:null,
        condition_tags:["합성 실내"],evidence_id:agreementEvidence,
        tax_mode:"inclusive",external_origin_attested:true,
        reason:"같은 근거와 품목을 다시 단가 등록 시도"}});
    assert.equal(duplicateRate.statusCode,409);
    const nonSourceRate=await app.inject({method:"POST",url:"/v1/rate-observations",
      headers:{...headers,"idempotency-key":randomUUID()},payload:{id:randomUUID(),
        trade_pack_id:"joinery",trade_pack_version:"1.0.0",category:"labor",
        unit_code:"day",rate_minor:"300000",observed_on:"2026-09-29",
        valid_until:"2026-10-15",delivery_included:null,processing_included:null,
        condition_tags:[],evidence_id:adjustmentEvidence,
        tax_mode:"inclusive",external_origin_attested:true,
        reason:"지급 내역은 외부 단가 근거가 아님"}});
    assert.equal(nonSourceRate.statusCode,404);
    const [identity] = await admin`select scope,choice from app.decisions
      where tenant_id=${tenant}::uuid and id=${confirmation.json().identity_decision_id}::uuid`;
    assert.deepEqual({scope:identity?.scope,choice:identity?.choice},
      {scope:"charge_identity",choice:"distinct_transaction"});
    const exportId=randomUUID();
    const exportBody={id:exportId,adapter_version:"labor-ledger-v1/1.0.0",
      source_sha256:"a".repeat(64),header_fingerprint:"b".repeat(64),
      lines:[{charge_case_id:chargeId,expected_version:2,work_date:"2026-09-29",
        work_type:"합성 공임",work_items:[{location:"가명 위치",description:"문틀 설치"}]}],
      reason:"확인된 공임 내부 원장 출력 승인"};
    const exportKey=randomUUID();
    const prepareExport=()=>app.inject({method:"POST",url:"/v1/exports",
      headers:{...headers,"idempotency-key":exportKey},payload:exportBody});
    const preparedExport=await prepareExport();
    assert.equal(preparedExport.statusCode,201,preparedExport.body);
    assert.deepEqual((await prepareExport()).json(),preparedExport.json());
    assert.equal(preparedExport.json().approved_snapshot.bundles[0].amount_minor,"1500000");
    assert.equal(preparedExport.json().approved_snapshot.bundles[0].unit,"일");
    assert.equal(preparedExport.json().delivery_verified,false);
    const exportRead=await app.inject({method:"GET",url:`/v1/exports/${exportId}`,headers});
    assert.equal(exportRead.statusCode,200,exportRead.body);
    assert.equal(exportRead.json().snapshot_sha256,preparedExport.json().snapshot_sha256);
    const duplicateExport=await app.inject({method:"POST",url:"/v1/exports",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{...exportBody,id:randomUUID()}});
    assert.equal(duplicateExport.statusCode,409);
    const voidExport=await app.inject({method:"POST",url:`/v1/exports/${exportId}/void`,
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{reason:"합성 내부 출력 폐기 후 정정본 발급"}});
    assert.equal(voidExport.statusCode,200,voidExport.body);
    const correctionExportId=randomUUID();
    const correctionExport=await app.inject({method:"POST",url:"/v1/exports",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{...exportBody,id:correctionExportId}});
    assert.equal(correctionExport.statusCode,201,correctionExport.body);
    const staleExport=await app.inject({method:"POST",url:"/v1/exports",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{...exportBody,id:randomUUID(),lines:[{...exportBody.lines[0],expected_version:1}]}});
    assert.equal(staleExport.statusCode,422);
    const foreignExport=await app.inject({method:"GET",url:`/v1/exports/${exportId}`,
      headers:{...headers,"x-tenant-id":foreignTenant}});
    assert.equal(foreignExport.statusCode,404);
    const handoffId=randomUUID();
    const handoffDraft=await app.inject({method:"POST",url:"/v1/external-actions",
      headers:{...headers,"idempotency-key":randomUUID()},payload:{id:handoffId,
        channel:"sms",recipient_label:"합성 수신자",recipient_address:"+12025550123",
        payload_text:"가명 현장 확인 요청",
        evidence_ids:[evidence],disclosure_scope:"work_status",
        expires_at:new Date(Date.now()+3600000).toISOString(),reason:"확인 요청 문자 초안 범위 승인"}});
    assert.equal(handoffDraft.statusCode,201,handoffDraft.body);
    const wrongRecipient=await app.inject({method:"POST",
      url:`/v1/external-actions/${handoffId}/handoff`,
      headers:{...headers,"idempotency-key":randomUUID()},payload:{
        recipient_address:"+12025550124",payload_sha256:handoffDraft.json().payload_sha256}});
    assert.equal(wrongRecipient.statusCode,409);
    const handoffKey=randomUUID();
    const handoffRequest=()=>app.inject({method:"POST",
      url:`/v1/external-actions/${handoffId}/handoff`,
      headers:{...headers,"idempotency-key":handoffKey},payload:{
        recipient_address:"+12025550123",payload_sha256:handoffDraft.json().payload_sha256}});
    const handed=await handoffRequest();
    assert.equal(handed.statusCode,200,handed.body);
    assert.equal(handed.json().delivery_verified,false);
    assert.deepEqual((await handoffRequest()).json(),handed.json());
    const noResend=await app.inject({method:"POST",
      url:`/v1/external-actions/${handoffId}/handoff`,
      headers:{...headers,"idempotency-key":randomUUID()},payload:{
        recipient_address:"+12025550123",payload_sha256:handoffDraft.json().payload_sha256}});
    assert.equal(noResend.statusCode,409);
    const cancelledHandoff=await app.inject({method:"POST",
      url:`/v1/external-actions/${handoffId}/cancel`,
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{reason:"합성 수신자에게 전달하지 않기로 결정"}});
    assert.equal(cancelledHandoff.statusCode,200,cancelledHandoff.body);
    assert.equal(cancelledHandoff.json().delivery_retracted,false);
    const replayAfterCancel=await handoffRequest();
    assert.equal(replayAfterCancel.statusCode,200);
    assert.equal(replayAfterCancel.json().handoff_status,"unavailable");
    assert.equal(replayAfterCancel.json().payload_text,undefined);
    const osShare=await app.inject({method:"POST",url:"/v1/external-actions",
      headers:{...headers,"idempotency-key":randomUUID()},payload:{id:randomUUID(),
        channel:"os_share",recipient_label:null,recipient_address:null,
        payload_text:"가명 현장 확인 요청",evidence_ids:[evidence],
        disclosure_scope:"work_status",expires_at:new Date(Date.now()+3600000).toISOString(),
        reason:"OS 공유 대상은 사용자가 최종 선택"}});
    assert.equal(osShare.statusCode,201,osShare.body);
    assert.equal(osShare.json().recipient_bound,false);
    const stale = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { charge: confirmed, reason: "합성 공임 근거 확인" } });
    assert.equal(stale.statusCode, 409);
    const foreign = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/confirm`,
      headers: { ...headers, "x-tenant-id": foreignTenant, "idempotency-key": randomUUID(), "if-match": '"2"' },
      payload: { charge: { ...confirmed, tenantId: foreignTenant }, reason: "합성 공임 근거 확인" } });
    assert.equal(foreign.statusCode, 404);
    const secondId = randomUUID();
    const second = { ...candidate, id: secondId };
    const secondCreate = await app.inject({ method: "POST", url: "/v1/charge-cases",
      headers: { ...headers, "idempotency-key": randomUUID() }, payload: second });
    assert.equal(secondCreate.statusCode, 201, secondCreate.body);
    const reuse = await app.inject({ method: "POST", url: `/v1/charge-cases/${secondId}/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' },
      payload: { charge: { ...confirmed, id: secondId }, reason: "동일 근거를 별도 비용으로 확인" } });
    assert.equal(reuse.statusCode, 409);
    const allocationPayload = { id: randomUUID(), policy: "approved_weight", policy_version: 1,
      targets: [{bundle_id:bundle,weight:"1"},{bundle_id:secondBundle,weight:"1"}],
      evidence_ids: [evidence], explanation: "합성 공통비 두 이번 일 배부 승인" };
    const allocationKey = randomUUID();
    const allocate = () => app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/allocate`,
      headers: { ...headers, "idempotency-key": allocationKey, "if-match": '"2"' },
      payload: allocationPayload });
    const allocation = await allocate();
    assert.equal(allocation.statusCode, 201, allocation.body);
    assert.deepEqual((await allocate()).json(), allocation.json());
    assert.equal(allocation.json().allocations.reduce((sum:bigint,row:{amountMinor:string}) =>
      sum+BigInt(row.amountMinor),0n),1500000n);
    const duplicateAllocation = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/allocate`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"2"' },
      payload: { ...allocationPayload, id: randomUUID() } });
    assert.equal(duplicateAllocation.statusCode, 409);
    const [allocatedView] = await admin`select sum(allocated_minor)::bigint as amount,
      count(*)::int as rows from app.current_bundle_costs
      where tenant_id=${tenant}::uuid and charge_case_id=${chargeId}::uuid`;
    assert.equal(String(allocatedView?.amount),"1500000");
    assert.equal(allocatedView?.rows,2);
    const adjustmentPayload = { id:randomUUID(),direction:"reversal",amount_minor:"30000",
      reason:"return",liability:"unknown",evidence_ids:[adjustmentEvidence],
      explanation:"합성 반환 확인, 기존 확정 원가 역조정" };
    const adjustment = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/adjust`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"2"' },
      payload: adjustmentPayload });
    assert.equal(adjustment.statusCode, 201, adjustment.body);
    assert.equal(adjustment.json().confirmed_actual_minor,"1470000");
    assert.equal(adjustment.json().version,3);
    const revisedOutcome=await app.inject({method:"POST",url:"/v1/outcomes",
      headers:{...headers,"idempotency-key":randomUUID()},payload:{id:randomUUID(),
        bundle_id:bundle,expected_outcome_version:1,scope_completed:true,
        quantity_value:"5",unit_code:"day",owner_labor_included:null,
        revisit_count:0,transport_count:0,defect_count:0,
        condition_tags:["합성 실내"],evidence_ids:[evidence],
        reason:"반품 조정 이후 실제 원가 재계산"}});
    assert.equal(revisedOutcome.statusCode,201,revisedOutcome.body);
    assert.equal(revisedOutcome.json().actual_cost_minor,null);
    assert.equal(revisedOutcome.json().unknown_cost_cases,2);
    assert.equal(revisedOutcome.json().version,2);
    const staleOutcome=await app.inject({method:"GET",url:`/v1/outcomes/${firstOutcomeId}`,headers});
    assert.equal(staleOutcome.statusCode,200,staleOutcome.body);
    assert.equal(staleOutcome.json().stale,true);
    assert.equal(staleOutcome.json().learning_eligible,false);
    const staleExportRead=await app.inject({method:"GET",url:`/v1/exports/${correctionExportId}`,
      headers});
    assert.equal(staleExportRead.statusCode,409);
    const repeatedAdjustment = await app.inject({ method: "POST", url: `/v1/charge-cases/${chargeId}/adjust`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"3"' },
      payload: { ...adjustmentPayload, id:randomUUID(), amount_minor:"1000" } });
    assert.equal(repeatedAdjustment.statusCode,409);
    const [staleView] = await admin`select allocation_state,allocated_minor,unallocated_minor
      from app.current_bundle_costs where tenant_id=${tenant}::uuid and charge_case_id=${chargeId}::uuid`;
    assert.equal(staleView?.allocation_state,"unallocated");
    assert.equal(staleView?.allocated_minor,null);
    assert.equal(String(staleView?.unallocated_minor),"1470000");
    const [currentCase] = await admin`select current_revision_id from app.charge_cases
      where tenant_id=${tenant}::uuid and id=${chargeId}::uuid`;
    const [allocationDecision] = await admin`select decision_id from app.charge_allocation_batches
      where tenant_id=${tenant}::uuid and id=${allocationPayload.id}::uuid`;
    await assert.rejects(admin`insert into app.charge_allocation_batches
      (tenant_id,charge_case_id,charge_revision_id,charge_version,policy,policy_version,total_minor,
        decision_id,evidence_ids)
      values (${tenant}::uuid,${chargeId}::uuid,${currentCase?.current_revision_id}::uuid,3,
        'direct',1,1470000,${allocationDecision?.decision_id}::uuid,${admin.array([evidence],2950)})`,
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
    const [allocationState] = await admin`select b.charge_version,c.version as current_version,
      sum(r.amount_minor)::bigint as allocated_minor from app.charge_allocation_batches b
      join app.charge_allocation_rows r on r.tenant_id=b.tenant_id and r.batch_id=b.id
      join app.charge_cases c on c.tenant_id=b.tenant_id and c.id=b.charge_case_id
      where b.tenant_id=${tenant}::uuid and b.id=${allocationPayload.id}::uuid
      group by b.charge_version,c.version`;
    assert.equal(Number(allocationState?.charge_version),2);
    assert.equal(Number(allocationState?.current_version),3);
    assert.equal(String(allocationState?.allocated_minor),"1500000");
    const invoiceId = randomUUID(), invoiceLineId = randomUUID();
    const invoice = { id:invoiceId,direction:"payable",counterparty_id:confirmed.partyId,bundle_id:null,
      agreement_id:null,sequence:null,
      stage:"other",tax_mode:"inclusive",source_evidence_id:adjustmentEvidence,due_at:null,
      lines:[{id:invoiceLineId,invoiceId,tenantId:tenant,direction:"payable",stage:"other",
        supplyMinor:"1400000",vatMinor:"70000",grossMinor:"1470000",taxMode:"inclusive",
        reversesInvoiceLineId:null}] };
    const invoiceCreate = await app.inject({ method:"POST",url:"/v1/invoices",
      headers:{...headers,"idempotency-key":randomUUID()},payload:invoice });
    assert.equal(invoiceCreate.statusCode,201,invoiceCreate.body);
    assert.equal(invoiceCreate.json().new_cost_minor,"0");
    const duplicateSourceId = randomUUID();
    const duplicateSource = await app.inject({ method:"POST",url:"/v1/invoices",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{...invoice,id:duplicateSourceId,
        lines:[{...invoice.lines[0],id:randomUUID(),invoiceId:duplicateSourceId}]} });
    assert.equal(duplicateSource.statusCode,409);
    const link = {id:randomUUID(),tenantId:tenant,invoiceLineId,chargeCaseId:chargeId,
      chargeRevisionId:currentCase?.current_revision_id,supplyMinor:"950000",vatMinor:"50000",
      grossMinor:"1000000",reversesLinkId:null};
    const linked = await app.inject({ method:"POST",url:"/v1/invoice-charge-links",
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{link,claim_complete:true} });
    assert.equal(linked.statusCode,201,linked.body);
    assert.equal(linked.json().new_cost_minor,"0");
    assert.equal(linked.json().difference_exception,true);
    const [openDifference] = await admin`select state from app.invoice_reconciliation_exceptions
      where tenant_id=${tenant}::uuid and invoice_line_id=${invoiceLineId}::uuid`;
    assert.equal(openDifference?.state,"open");
    const remainder = await app.inject({ method:"POST",url:"/v1/invoice-charge-links",
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{link:{...link,id:randomUUID(),grossMinor:"470000",supplyMinor:"450000",vatMinor:"20000"},
        claim_complete:true} });
    assert.equal(remainder.statusCode,201,remainder.body);
    assert.equal(remainder.json().difference_exception,false);
    const [resolvedDifference] = await admin`select state from app.invoice_reconciliation_exceptions
      where tenant_id=${tenant}::uuid and invoice_line_id=${invoiceLineId}::uuid`;
    assert.equal(resolvedDifference?.state,"resolved");
    const overlinked = await app.inject({ method:"POST",url:"/v1/invoice-charge-links",
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{link:{...link,id:randomUUID()},claim_complete:true} });
    assert.equal(overlinked.statusCode,422);
    const payableApproved = await app.inject({ method:"POST",url:`/v1/invoices/${invoiceId}/approve`,
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{reason:"합성 매입 명세와 연결 근거 최종 확인"} });
    assert.equal(payableApproved.statusCode,201,payableApproved.body);
    assert.equal(payableApproved.json().approved_gross_minor,"1470000");
    assert.equal(payableApproved.json().payment_confirmed,false);
    const blockedAdjustment = await app.inject({method:"POST",url:`/v1/charge-cases/${chargeId}/adjust`,
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"3"'},
      payload:{...adjustmentPayload,id:randomUUID(),amount_minor:"1000"}});
    assert.equal(blockedAdjustment.statusCode,422);
    const agreementId = randomUUID();
    const billingAgreement = await app.inject({method:"POST",url:"/v1/billing-agreements",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:agreementId,bundle_id:bundle,source_evidence_id:agreementEvidence,
        approved_gross_minor:"1000000",reason:"합성 고객과 총 계약금액 근거 확인"}});
    assert.equal(billingAgreement.statusCode,201,billingAgreement.body);
    const salesId = randomUUID(),salesLineId=randomUUID();
    const sales = await app.inject({ method:"POST",url:"/v1/invoices",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:salesId,direction:"receivable",counterparty_id:randomUUID(),bundle_id:bundle,
        agreement_id:agreementId,sequence:1,
        stage:"progress",tax_mode:"inclusive",source_evidence_id:agreementEvidence,due_at:null,
        lines:[{id:salesLineId,invoiceId:salesId,tenantId:tenant,direction:"receivable",stage:"progress",
          supplyMinor:"454545",vatMinor:"45455",grossMinor:"500000",taxMode:"inclusive",
          reversesInvoiceLineId:null}]} });
    assert.equal(sales.statusCode,201,sales.body);
    const salesApproved = await app.inject({ method:"POST",url:`/v1/invoices/${salesId}/approve`,
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{reason:"합성 고객 금액 합의와 기성 범위 확인"} });
    assert.equal(salesApproved.statusCode,201,salesApproved.body);
    assert.equal(salesApproved.json().approved_gross_minor,"500000");
    const excessId=randomUUID(),excessLineId=randomUUID();
    const excessDraft = await app.inject({method:"POST",url:"/v1/invoices",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:excessId,direction:"receivable",counterparty_id:randomUUID(),bundle_id:bundle,
        agreement_id:agreementId,sequence:1,stage:"final",tax_mode:"inclusive",
        source_evidence_id:agreementEvidence,due_at:null,
        lines:[{id:excessLineId,invoiceId:excessId,tenantId:tenant,direction:"receivable",stage:"final",
          supplyMinor:"545455",vatMinor:"54545",grossMinor:"600000",taxMode:"inclusive",
          reversesInvoiceLineId:null}]}});
    assert.equal(excessDraft.statusCode,201,excessDraft.body);
    const excessApproval=await app.inject({method:"POST",url:`/v1/invoices/${excessId}/approve`,
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{reason:"합성 잔금 청구 금액 확인"}});
    assert.equal(excessApproval.statusCode,422);
    const accountToken="synthetic-account-001",cashRecordId=randomUUID();
    const cashObservation=(id:string,evidenceId:string,source:"manual"|"bank"|"notification",
      providerTxnId:string|null)=>({id,tenantId:tenant,accountToken,direction:"incoming",
      amountMinor:"300000",occurredAt:"2026-09-01T12:05:00+09:00",timePrecision:"instant",
      normalizedMemo:"synthetic",provider:providerTxnId?"bank-fixture":null,providerTxnId,
      source,evidenceId});
    const manualId=randomUUID();
    const manual=await app.inject({method:"POST",url:"/v1/cash-observations",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashObservation(manualId,evidence,"manual",null)});
    assert.equal(manual.statusCode,201,manual.body);
    assert.equal(manual.json().identity.kind,"new_candidate");
    const duplicateRowEvidence=randomUUID();
    await admin`insert into app.evidence_index
      (tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
      select tenant_id,${duplicateRowEvidence}::uuid,revision_id,scope,category,display_title,
        search_text,locator,source_kind from app.evidence_index
      where tenant_id=${tenant}::uuid and id=${evidence}::uuid`;
    const duplicateRow=await app.inject({method:"POST",url:"/v1/cash-observations",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashObservation(randomUUID(),duplicateRowEvidence,"manual",null)});
    assert.equal(duplicateRow.statusCode,409);
    const firstCash=await app.inject({method:"POST",url:"/v1/cash-identity-decisions",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{observation_id:manualId,choice:"new_distinct",cash_record_id:cashRecordId,
        reason:"합성 수동 현금 근거 확인",evidence_ids:[evidence]}});
    assert.equal(firstCash.statusCode,201,firstCash.body);
    assert.equal(firstCash.json().bank_reconciled,false);
    const bankId=randomUUID();
    const bank=await app.inject({method:"POST",url:"/v1/cash-observations",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashObservation(bankId,adjustmentEvidence,"bank","txn-1")});
    assert.equal(bank.statusCode,201,bank.body);
    assert.equal(bank.json().identity.kind,"review");
    const bankLink=await app.inject({method:"POST",url:"/v1/cash-identity-decisions",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{observation_id:bankId,choice:"link_existing",cash_record_id:cashRecordId,
        reason:"합성 수동기록과 통장 거래 동일 확인",evidence_ids:[adjustmentEvidence]}});
    assert.equal(bankLink.statusCode,201,bankLink.body);
    assert.equal(bankLink.json().bank_reconciled,true);
    const noticeId=randomUUID();
    const notice=await app.inject({method:"POST",url:"/v1/cash-observations",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashObservation(noticeId,cashNotificationEvidence,"notification",null)});
    assert.equal(notice.statusCode,201,notice.body);
    const noticeLink=await app.inject({method:"POST",url:"/v1/cash-identity-decisions",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{observation_id:noticeId,choice:"link_existing",cash_record_id:cashRecordId,
        reason:"합성 알림과 기존 금융거래 동일 확인",evidence_ids:[cashNotificationEvidence]}});
    assert.equal(noticeLink.statusCode,201,noticeLink.body);
    const secondTransferId=randomUUID(),secondCashId=randomUUID();
    const secondTransfer=await app.inject({method:"POST",url:"/v1/cash-observations",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashObservation(secondTransferId,secondBankEvidence,"bank","txn-2")});
    assert.equal(secondTransfer.statusCode,201,secondTransfer.body);
    assert.equal(secondTransfer.json().identity.kind,"review");
    const wrongMerge=await app.inject({method:"POST",url:"/v1/cash-identity-decisions",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{observation_id:secondTransferId,choice:"link_existing",cash_record_id:cashRecordId,
        reason:"합성 다른 은행 거래번호는 병합 거절",evidence_ids:[secondBankEvidence]}});
    assert.equal(wrongMerge.statusCode,422);
    const secondCash=await app.inject({method:"POST",url:"/v1/cash-identity-decisions",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{observation_id:secondTransferId,choice:"new_distinct",cash_record_id:secondCashId,
        reason:"합성 별도 거래번호의 두 번째 입금 확인",evidence_ids:[secondBankEvidence]}});
    assert.equal(secondCash.statusCode,201,secondCash.body);
    const [cashTotals]=await admin`select count(*)::int as records,sum(amount_minor)::bigint as amount
      from app.cash_records where tenant_id=${tenant}::uuid`;
    assert.equal(cashTotals?.records,2);
    assert.equal(String(cashTotals?.amount),"600000");
    const [cashEvidence]=await admin`select count(*)::int as linked from app.cash_observation_links
      where tenant_id=${tenant}::uuid and cash_record_id=${cashRecordId}::uuid`;
    assert.equal(cashEvidence?.linked,3);
    const firstApplyId=randomUUID();
    const cashApplication=(id:string,cashId:string,amount:string,version:number,
      kind:"apply"|"reversal",reverses:string|null,evidenceId:string)=>({id,cash_record_id:cashId,
      invoice_id:salesId,amount_minor:amount,kind,reverses_application_id:reverses,
      expected_cash_version:version,expected_invoice_version:2,evidence_ids:[evidenceId],
      reason:"합성 입금과 승인 청구서 부분충당 확인"});
    const firstApply=await app.inject({method:"POST",url:"/v1/cash-applications",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashApplication(firstApplyId,cashRecordId,"300000",2,"apply",null,adjustmentEvidence)});
    assert.equal(firstApply.statusCode,201,firstApply.body);
    assert.equal(firstApply.json().invoice_remaining_minor,"200000");
    const secondApply=await app.inject({method:"POST",url:"/v1/cash-applications",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashApplication(randomUUID(),secondCashId,"200000",2,"apply",null,secondBankEvidence)});
    assert.equal(secondApply.statusCode,201,secondApply.body);
    assert.equal(secondApply.json().cash_unapplied_minor,"100000");
    const reverse=await app.inject({method:"POST",url:"/v1/cash-applications",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashApplication(randomUUID(),cashRecordId,"100000",3,"reversal",firstApplyId,
        adjustmentEvidence)});
    assert.equal(reverse.statusCode,201,reverse.body);
    assert.equal(reverse.json().invoice_remaining_minor,"100000");
    const applyLast=()=>app.inject({method:"POST",url:"/v1/cash-applications",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:cashApplication(randomUUID(),secondCashId,"100000",3,"apply",null,secondBankEvidence)});
    const competing=await Promise.all([applyLast(),applyLast()]);
    assert.deepEqual(competing.map(item=>item.statusCode).sort(),[201,409]);
    const settlement=await app.inject({method:"GET",url:`/v1/invoices/${salesId}/settlement`,headers});
    assert.equal(settlement.statusCode,200,settlement.body);
    assert.equal(settlement.json().remaining_minor,"0");
    assert.equal(settlement.json().bank_reconciled_cash_minor,"500000");
    assert.equal(settlement.json().payment_confirmed,false);
    assert.equal(settlement.json().statement_matched_full_cash,true);
    const offsetSalesId=randomUUID(),offsetLineId=randomUUID();
    const offsetSales=await app.inject({method:"POST",url:"/v1/invoices",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:offsetSalesId,direction:"receivable",
        counterparty_id:confirmed.partyId,bundle_id:bundle,agreement_id:agreementId,
        sequence:2,stage:"final",tax_mode:"inclusive",source_evidence_id:agreementEvidence,due_at:null,
        lines:[{id:offsetLineId,invoiceId:offsetSalesId,tenantId:tenant,direction:"receivable",
          stage:"final",supplyMinor:"272727",vatMinor:"27273",grossMinor:"300000",
          taxMode:"inclusive",reversesInvoiceLineId:null}]}});
    assert.equal(offsetSales.statusCode,201,offsetSales.body);
    const offsetApproved=await app.inject({method:"POST",url:`/v1/invoices/${offsetSalesId}/approve`,
      headers:{...headers,"idempotency-key":randomUUID(),"if-match":'"1"'},
      payload:{reason:"합성 별도 정산 대상 범위 확인"}});
    assert.equal(offsetApproved.statusCode,201,offsetApproved.body);
    const offsetId=randomUUID();
    const offsetBody={id:offsetId,kind:"offset",basis_kind:"offset_agreement",
      receivable_invoice_id:offsetSalesId,
      payable_invoice_id:invoiceId,reverses_settlement_id:null,amount_minor:"200000",
      evidence_id:settlementEvidence,expected_receivable_version:2,expected_payable_version:2,
      reason:"합성 쌍방 상계 합의 원문 확인"};
    const unsupportedOffset=await app.inject({method:"POST",url:"/v1/noncash-settlements",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{...offsetBody,id:randomUUID(),evidence_id:agreementEvidence}});
    assert.equal(unsupportedOffset.statusCode,422);
    const offset=await app.inject({method:"POST",url:"/v1/noncash-settlements",
      headers:{...headers,"idempotency-key":randomUUID()},payload:offsetBody});
    assert.equal(offset.statusCode,201,offset.body);
    assert.equal(offset.json().cash_flow_minor,"0");
    const offsetTooMuch=await app.inject({method:"POST",url:"/v1/noncash-settlements",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{...offsetBody,id:randomUUID(),amount_minor:"200000"}});
    assert.equal(offsetTooMuch.statusCode,422);
    const offsetReverse=await app.inject({method:"POST",url:"/v1/noncash-settlements",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{...offsetBody,id:randomUUID(),kind:"reversal",basis_kind:"reversal_basis",
        reverses_settlement_id:offsetId}});
    assert.equal(offsetReverse.statusCode,201,offsetReverse.body);
    assert.ok(productRevision1 && productRevision2);
    const productId1=randomUUID(),productId2=randomUUID(),submittalId=randomUUID();
    const product1=await app.inject({method:"POST",url:"/v1/product-documents",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:productId1,product_key:"synthetic-tile",revision_number:1,
        document_revision_id:productRevision1,evidence_id:productEvidence1}});
    assert.equal(product1.statusCode,201,product1.body);
    assert.equal(product1.json().site_approved,false);
    const prepared=await app.inject({method:"POST",url:"/v1/submittals",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:submittalId,bundle_id:bundle,recipient_label:"synthetic-recipient",
        product_document_ids:[productId1]}});
    assert.equal(prepared.statusCode,201,prepared.body);
    assert.equal(prepared.json().status,"prepared");
    const submitted=await app.inject({method:"POST",url:`/v1/submittals/${submittalId}/submit`,
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{expected_version:1,evidence_id:submissionEvidence,
        reason:"합성 제출 송신 근거를 별도 확인"}});
    assert.equal(submitted.statusCode,201,submitted.body);
    assert.equal(submitted.json().site_approved,false);
    const replied=await app.inject({method:"POST",url:`/v1/submittals/${submittalId}/reply`,
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{expected_version:2,reply_status:"approved",scope_product_document_ids:[productId1],
        conditions:null,evidence_id:replyEvidence,observed_at:"2026-09-03T10:00:00+09:00",
        reason:"합성 현장 회신의 승인 범위 확인"}});
    assert.equal(replied.statusCode,201,replied.body);
    const product2=await app.inject({method:"POST",url:"/v1/product-documents",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:productId2,product_key:"synthetic-tile",revision_number:2,
        document_revision_id:productRevision2,evidence_id:productEvidence2}});
    assert.equal(product2.statusCode,201,product2.body);
    const pinned=await app.inject({method:"GET",url:`/v1/submittals/${submittalId}`,headers});
    assert.equal(pinned.statusCode,200,pinned.body);
    assert.equal(pinned.json().product_documents[0].pinned_revision_id,productRevision1);
    assert.equal(pinned.json().product_documents[0].newer_revision_available,true);
    assert.equal(pinned.json().site_approved,true);
    const wrongScope=await app.inject({method:"POST",url:`/v1/submittals/${submittalId}/reply`,
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{expected_version:3,reply_status:"approved",scope_product_document_ids:[productId2],
        conditions:null,evidence_id:oldReplyEvidence,
        observed_at:"2026-09-01T10:00:00+09:00",
        reason:"합성 새 문서를 이전 승인으로 오인 금지"}});
    assert.equal(wrongScope.statusCode,422);
    const oldReply=await app.inject({method:"POST",url:`/v1/submittals/${submittalId}/reply`,
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{expected_version:3,reply_status:"rejected",scope_product_document_ids:[productId1],
        conditions:null,evidence_id:oldReplyEvidence,
        observed_at:"2026-09-01T10:00:00+09:00",
        reason:"합성 늦게 기록된 과거 회신의 시각 확인"}});
    assert.equal(oldReply.statusCode,201,oldReply.body);
    assert.equal(oldReply.json().out_of_order_reply,true);
    const stillApproved=await app.inject({method:"GET",url:`/v1/submittals/${submittalId}`,headers});
    assert.equal(stillApproved.statusCode,200,stillApproved.body);
    assert.equal(stillApproved.json().site_approved,true);
    assert.equal(stillApproved.json().out_of_order_reply,true);
    const defectId=randomUUID();
    const defect=await app.inject({method:"POST",url:"/v1/defect-cases",
      headers:{...headers,"idempotency-key":randomUUID()},
      payload:{id:defectId,original_bundle_id:bundle,original_charge_case_id:chargeId,
        reported_evidence_id:defectEvidence,description:"합성 타일 균열 보고와 원공사 연결",
        reason:"합성 원공사와 하자 근거의 연결만 확인"}});
    assert.equal(defect.statusCode,201,defect.body);
    assert.equal(defect.json().liability,"unknown");
    assert.equal(defect.json().customer_charge_minor,null);
    const [secondCandidate] = await admin`select current_revision_id from app.charge_cases
      where tenant_id=${tenant}::uuid and id=${secondId}::uuid`;
    await assert.rejects(admin`insert into app.invoice_charge_links
      (tenant_id,invoice_line_id,charge_case_id,charge_revision_id,gross_minor)
      values (${tenant}::uuid,${invoiceLineId}::uuid,${secondId}::uuid,
        ${secondCandidate?.current_revision_id}::uuid,1)`,
    (error:unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
    const [count] = await admin`select count(*)::int as n from app.charge_revisions
      where tenant_id=${tenant}::uuid and charge_case_id=${chargeId}::uuid`;
    assert.equal(count?.n, 3);
    await runtime.begin(async tx => {
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      const own = await tx`select id from app.charge_cases where tenant_id=${tenant}::uuid`;
      const other = await tx`select id from app.charge_cases where tenant_id=${foreignTenant}::uuid`;
      assert.equal(own.length, 2);
      assert.equal(other.length, 0);
    });
  } finally {
    await app.close();
    if (seeded) await admin.begin(async tx => {
      await tx`delete from app.command_receipts where tenant_id=${tenant}::uuid`;
      await tx`delete from app.external_handoffs where tenant_id=${tenant}::uuid`;
      await tx`delete from app.outcomes where tenant_id=${tenant}::uuid`;
      await tx`delete from app.rate_observations where tenant_id=${tenant}::uuid`;
      await tx`delete from app.export_batch_lines where tenant_id=${tenant}::uuid`;
      await tx`delete from app.export_batches where tenant_id=${tenant}::uuid`;
      await tx`delete from app.defect_cases where tenant_id=${tenant}::uuid`;
      await tx`delete from app.submittal_replies where tenant_id=${tenant}::uuid`;
      await tx`delete from app.submittal_items where tenant_id=${tenant}::uuid`;
      await tx`delete from app.submittals where tenant_id=${tenant}::uuid`;
      await tx`delete from app.product_documents where tenant_id=${tenant}::uuid`;
      await tx`delete from app.cash_applications where tenant_id=${tenant}::uuid`;
      await tx`delete from app.noncash_settlements where tenant_id=${tenant}::uuid`;
      await tx`delete from app.cash_observation_links where tenant_id=${tenant}::uuid`;
      await tx`delete from app.cash_record_identifiers where tenant_id=${tenant}::uuid`;
      await tx`delete from app.cash_records where tenant_id=${tenant}::uuid`;
      await tx`delete from app.cash_observations where tenant_id=${tenant}::uuid`;
      await tx`delete from app.invoice_reconciliation_exceptions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.invoice_charge_links where tenant_id=${tenant}::uuid`;
      await tx`delete from app.invoice_lines where tenant_id=${tenant}::uuid`;
      await tx`delete from app.invoices where tenant_id=${tenant}::uuid`;
      await tx`delete from app.billing_agreements where tenant_id=${tenant}::uuid`;
      await tx`delete from app.charge_allocation_rows where tenant_id=${tenant}::uuid`;
      await tx`delete from app.charge_allocation_batches where tenant_id=${tenant}::uuid`;
      await tx`delete from app.charge_adjustment_evidence_ownership where tenant_id=${tenant}::uuid`;
      await tx`delete from app.charge_adjustments where tenant_id=${tenant}::uuid`;
      await tx`delete from app.charge_evidence_ownership where tenant_id=${tenant}::uuid`;
      await tx`alter table app.charge_cases disable trigger charge_cases_guard`;
      await tx`update app.charge_cases set current_revision_id=null where tenant_id=${tenant}::uuid`;
      await tx`alter table app.charge_cases enable trigger charge_cases_guard`;
      await tx`delete from app.charge_revisions where tenant_id=${tenant}::uuid`;
      await tx`delete from app.charge_cases where tenant_id=${tenant}::uuid`;
      await tx`delete from app.evidence_attributions where tenant_id=${tenant}::uuid`;
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
      await tx`delete from app.tenants where id in (${tenant}::uuid,${foreignTenant}::uuid)`;
      await tx`delete from auth.sessions where id=${session}::uuid`;
      await tx`delete from auth.users where id=${actor}::uuid`;
    });
    await Promise.all([admin.end(),runtime.end()]);
  }
});
