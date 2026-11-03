import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const paths = {
  structures: "fixtures/synthetic/source-structures-v1.json",
  oracles: "fixtures/synthetic/case-oracles-v1.json",
  registries: "fixtures/synthetic/unit-registries-v1.json",
  sourceIndex: "handoff/CASE_INDEX.json",
  manifest: "fixtures/synthetic/manifest-v1.json",
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const contents = name => readFileSync(paths[name]);
const document = name => JSON.parse(contents(name).toString("utf8"));
const asNumber = value => {
  assert.match(value,/^(?:0|[1-9][0-9]*)$/);
  return BigInt(value);
};
function allNodes(root) {
  const result = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    result.push(value);
    Object.values(value).forEach(visit);
  };
  visit(root);
  return result;
}
function findDoc(structures,id) {
  const result = structures.documents.find(item => item.id === id);
  assert.ok(result,`Missing synthetic document ${id}`);
  return result;
}
export function verifyFixtureCatalog() {
  const structures = document("structures");
  const oracles = document("oracles");
  const registries = document("registries");
  const sourceIndex = document("sourceIndex");
  const manifest = document("manifest");
  assert.equal(structures.fixture_version,"C08-structural-v1");
  assert.equal(oracles.fixture_version,"C08-oracle-v1");
  assert.equal(oracles.execution_state,"NOT_RUN");
  for (const name of ["structures","oracles","registries","sourceIndex"]) {
    assert.equal(sha256(contents(name)),manifest[`${name}_sha256`],`${name} hash drift`);
  }
  assert.equal(oracles.source_case_index_sha256,manifest.sourceIndex_sha256);
  assert.equal(registries.fixture_version,"C08-unit-registry-v1");
  assert.equal(sourceIndex.cases.length,78);
  assert.equal(oracles.cases.length,30);
  const expectedIds=Array.from({length:30},(_,i)=>`T${String(i+1).padStart(2,"0")}`);
  assert.deepEqual(oracles.cases.map(item=>item.id),expectedIds);
  assert.deepEqual(sourceIndex.cases.slice(0,30).map(item=>item.id),expectedIds);
  const docIds = new Set(structures.documents.map(item=>item.id));
  assert.equal(docIds.size,structures.documents.length);
  const sourceSplitGroups = new Map();
  const locators = new Set();
  const refs = [];
  for(const doc of structures.documents) {
    assert.match(doc.id,/^SF-I(?:0[4-9]|10|12)$/);
    assert.equal(doc.kind.startsWith("synthetic_"),true);
    for(const node of allNodes(doc)) {
      if(typeof node.locator === "string") {
        assert.ok(node.locator.startsWith(`${doc.id}/`));
        assert.equal(locators.has(node.locator),false,`Duplicate locator ${node.locator}`);
        locators.add(node.locator);
      }
      for(const key of ["parent","represents","candidate_same_transaction_as"]) {
        if(typeof node[key] === "string") refs.push(node[key]);
      }
    }
  }
  for(const ref of refs) assert.ok(locators.has(ref),`Dangling locator ${ref}`);
  for(const item of oracles.cases) {
    const indexCase = sourceIndex.cases.find(candidate=>candidate.id===item.id);
    assert.ok(indexCase?.expected && indexCase.forbidden);
    assert.equal(indexCase.state,"SPECIFIED_NOT_EXECUTED");
    assert.ok(item.split_group && typeof item.expected === "object");
    assert.ok(Array.isArray(item.forbidden) && item.forbidden.length);
    if(item.fixture_ids.some(fixtureId=>allNodes(findDoc(structures,fixtureId))
      .some(node=>typeof node.unit === "string"))) {
      assert.ok(item.unit_registry,`Missing unit registry in ${item.id}`);
    }
    if(item.unit_registry) {
      assert.ok(item.unit_registry === "base" || item.unit_registry === "joinery-v1");
      const registered = new Set([...registries.base,
        ...(item.unit_registry === "joinery-v1" ? registries["joinery-v1"] : [])]);
      for(const key of ["unit","scope_unit"]) {
        if(item.expected[key]) assert.ok(registered.has(item.expected[key]),
          `Unregistered ${key} in ${item.id}`);
      }
      for(const fixtureId of item.fixture_ids) {
        for(const node of allNodes(findDoc(structures,fixtureId))) {
          if(typeof node.unit === "string") assert.ok(registered.has(node.unit),
            `Unregistered source unit in ${item.id}`);
        }
      }
    }
    if(Number(item.id.slice(1))<=9) {
      assert.equal(item.provenance,"source_derived");
      assert.ok(item.fixture_ids.length && item.source_ids.length);
    }
    if(item.id==="T10") assert.equal(item.provenance,"synthetic_simulation");
    for(const fixtureId of item.fixture_ids) {
      assert.ok(docIds.has(fixtureId));
      assert.ok(item.source_ids.includes(findDoc(structures,fixtureId).source_id));
    }
    for(const sourceId of item.source_ids) {
      const prior=sourceSplitGroups.get(sourceId);
      if(prior) assert.equal(item.split_group,prior,`Split leakage for ${sourceId}`);
      else sourceSplitGroups.set(sourceId,item.split_group);
    }
  }
  const oracle = id => oracles.cases.find(item=>item.id===id).expected;
  const doc = id => findDoc(structures,id);
  const i04=doc("SF-I04").segments;
  assert.equal(i04.find(item=>item.role==="scope").value,oracle("T01").document_quantity);
  assert.equal(i04.find(item=>item.role==="dimension").raw,oracle("T01").dimension_raw);
  assert.equal(i04.find(item=>item.role==="color_code").raw,oracle("T01").color_code_raw);
  const first=doc("SF-I06").tables[0];
  const repeats=[doc("SF-I06").tables[1],doc("SF-I07").tables[0]];
  const sum=rows=>rows.reduce((total,row)=>total+asNumber(row.quantity),0n);
  assert.equal(sum(first.rows).toString(),oracle("T02").logical_form_quantity);
  for(const table of repeats) assert.equal(sum(table.rows),sum(first.rows));
  assert.deepEqual(first.rows.filter(row=>row.item_type==="WD-5")
    .map(row=>row.dimension),oracle("T03").wd5_dimensions);
  assert.equal(first.rows.find(row=>row.item_type==="WD-6").quantity,
    oracle("T03").wd6_quantity);
  const i05=doc("SF-I05");
  assert.equal(i05.metadata.filename_site_hint,oracle("T04").filename_site_hint);
  assert.equal(i05.segments.find(item=>item.role==="header_site_hint").raw,
    oracle("T04").header_site_hint);
  assert.equal(i05.segments.find(item=>item.role==="delivery_address_hint").raw,
    oracle("T04").delivery_address_hint);
  assert.equal(i05.segments.filter(item=>item.role==="delivery_form")[0].value,
    oracle("T05").document_quantity);
  assert.equal(i05.segments.filter(item=>item.role==="representation_copy").length,1);
  assert.equal(new Set(i05.segments.map(item=>item.locator.match(/\/page\/(\d+)\//)?.[1])
    .filter(Boolean)).size,oracle("T05").page_count);
  const i08=doc("SF-I08").rows;
  assert.equal(i08.find(item=>item.role==="scope").quantity,oracle("T06").scope_quantity);
  assert.deepEqual(i08.filter(item=>item.role==="labor").map(item=>item.days),
    oracle("T06").billing_days);
  assert.equal(i08.filter(item=>item.role==="labor")
    .reduce((sum,row)=>sum+asNumber(row.amount),0n).toString(),oracle("T06").total);
  assert.equal(i08.length,4);
  assert.equal(i08.find(item=>item.role==="summary_total").amount,
    oracle("T06").total);
  const i09=doc("SF-I09").rows;
  assert.equal(i09.filter(item=>item.role==="task").length,
    oracle("T07").task_count);
  assert.equal(i09.filter(item=>item.bundle_parent===true).length,1);
  assert.equal(i09.filter(item=>item.amount!==null).length,1);
  assert.equal(i09[0].amount,oracle("T07").amount);
  const i10=doc("SF-I10");
  assert.equal(i10.rows.length,oracle("T08").record_count);
  for(const [field,expected] of [["supply",oracle("T08").supply],
    ["vat",oracle("T08").vat],["gross",oracle("T08").gross]]) {
    assert.equal(i10.rows.reduce((sum,row)=>sum+asNumber(row[field]),0n).toString(),expected);
  }
  assert.equal(i10.blank_template.row_count,291);
  assert.equal(i10.rows[0].payment_raw,oracle("T09").payment_raw_example);
  const i12=doc("SF-I12");
  const s16=i12.events.find(item=>item.locator.endsWith("S16"));
  const s17=i12.events.find(item=>item.locator.endsWith("S17"));
  assert.equal(s16.known_at,i12.query_cutoff);
  assert.equal(s17.occurred_at,oracle("T10").s17_occurred_at);
  assert.equal(s17.recorded_at,oracle("T10").s17_recorded_at);
  assert.equal(s17.known_at,oracle("T10").s17_known_at);
  assert.ok(s17.occurred_at < i12.query_cutoff &&
    i12.query_cutoff < s17.known_at);
  assert.equal(i12.events.filter(item=>item.known_at<=i12.query_cutoff).length,1);
  assert.equal(i12.events.filter(item=>item.occurred_at<=i12.query_cutoff).length,2,
    "Occurrence-only filtering must fail the knowledge-cutoff oracle");
  return {structures,oracles,registries,sourceIndex,
    fixtureSha256:sha256(Buffer.concat([contents("structures"),contents("oracles")]))};
}
