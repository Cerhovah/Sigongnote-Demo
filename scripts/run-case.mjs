import { verifyFixtureCatalog } from "./fixture-catalog.mjs";

try {
  const {oracles,fixtureSha256} = verifyFixtureCatalog();
  const selected=process.argv.slice(2);
  if(selected.length===1 && selected[0]==="--verify-fixtures") {
    console.log("PASS");
  } else if(selected.length===1 && selected[0]==="--list") {
    for(const item of oracles.cases) console.log(`${item.id} NOT_RUN ${item.provenance}`);
  } else {
    if(!selected.length || selected.some(id=>!/^T(?:0[1-9]|[12][0-9]|30)$/.test(id))) {
      throw new Error("Specify one or more T01–T30 IDs, --list or --verify-fixtures");
    }
    const unique=[...new Set(selected)];
    for(const id of unique) {
      const item=oracles.cases.find(value=>value.id===id);
      if(!item) throw new Error(`Unknown case ${id}`);
      console.log(JSON.stringify({case_id:id,spec_version:"v2.0",
        fixture_version:oracles.fixture_version,fixture_sha256:fixtureSha256,
        expected:item.expected,actual:null,status:"NOT_RUN",
        remaining_boundary:"No executable case adapter is implemented for this acceptance case."}));
    }
    process.exitCode=2;
  }
} catch(error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : "fixture verification"}`);
  process.exitCode=1;
}
