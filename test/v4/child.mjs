import assert from 'node:assert/strict';
process.env.STG_SERVE = 'child';
process.env.STG_DB = 'sqlite';
const {startServer} = await import('../start.mjs');
const server = startServer(true);
const root = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const base = root + '/sap/opu/odata4/sap/ZSTG_DEMO_SRV';
try {
  let last;
  for (let i = 0; i < 600; i++) {
    try {
      const response = await fetch(base + '/$metadata');
      last = `${response.status}: ${await response.text()}`;
      if (response.status === 200) break;
    } catch (error) { last = String(error); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.match(last, /^200:.*Version="4.0"/s);
  const response = await fetch(base + '/TravelSet?$top=1&$count=true');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.value.length, 1);
  assert.equal(body['@odata.count'], 4);
  assert.equal(body.value[0].TravelId, 'T0001');
  const v2 = await fetch(root + '/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$top=1');
  assert.equal((await v2.json()).d.results[0].TravelId, 'T0001');
  console.log('PASS: V4 metadata/read/count and V2 read through the child host');
} finally {
  await server.close();
}
