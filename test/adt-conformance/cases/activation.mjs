import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {NS} from '../assertions.mjs';

// Activation and ABAP Unit (docs/osgo-adt-activation.md). X1 activates the
// unchanged $ZOSD_TEST fixture class, which every host answers with the plain
// success document. X2 activates a disposable class saved with a syntax
// error. X3/X4 run the fixture's two test methods one at a time: the pass
// and the deliberate failure. A clean activation of changed source is not a
// shared case: the JS host rebuilds its generation for it and osgo publishes
// with a rebuild warning, which go/adtactivate's tests cover.
const ns = {...NS, chkl: 'http://www.sap.com/abapxml/checklist'};
const fixture = '/sap/bc/adt/oo/classes/zcl_zosd_test_demo';
const activation = uri => ({method: 'POST', path: '/activation', query: {method: 'activate', preauditRequested: 'true'},
  headers: {'content-type': 'application/xml', accept: 'application/xml'},
  body: `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="${uri}" adtcore:name="${uri.split('/').pop().toUpperCase()}"/></adtcore:objectReferences>`});
// The first unit run after X1 re-reads the unit plan over the generation
// X1 published (measured: X3 10 s, X4 5 s right after X1; under load the
// 30 s default was missed), so the two unit cases get a bounded 120 s.
const unit = method => ({method: 'POST', path: '/abapunit/testruns', timeout: 120000,
  headers: {'content-type': 'application/vnd.sap.adt.abapunit.testruns.config.v4+xml', accept: 'application/vnd.sap.adt.abapunit.testruns.result.v2+xml'},
  body: `<?xml version="1.0" encoding="UTF-8"?><aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit"><external><coverage active="false"/></external><options><uriType value="semantic"/><testDeterminationStrategy sameProgram="true" assignedTests="false"/><testRiskLevels harmless="true" dangerous="true" critical="true"/><testDurations short="true" medium="true" long="true"/><withNavigationUri enabled="true"/></options><adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="${fixture}#testclass=ltcl_zosd_test_demo;testmethod=${method}"/></adtcore:objectReferences></objectSet></adtcore:objectSets></aunit:runConfiguration>`});

// X2's disposable class: created, locked, saved broken, deleted after.
const collection = '/oo/classes';
async function broken(ctx) {
  assert.match(ctx.writePackage ?? '', /^[A-Z0-9_$/]+$/, 'configure --write-package for write cases');
  ctx.name = `ZCL_ADT_X2_${randomBytes(8).toString('hex').toUpperCase()}`;
  ctx.path = `${collection}/${ctx.name.toLowerCase()}`;
  assert.equal((await ctx.session.request({path: ctx.path})).status, 404, 'setup GET confirms absence before CREATE');
  ctx.created = true;
  const made = await ctx.session.request({method: 'POST', path: collection,
    headers: {'content-type': 'application/vnd.sap.adt.oo.classes.v4+xml'},
    body: `<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${ctx.name}" adtcore:type="CLAS/OO"><adtcore:packageRef adtcore:name="${ctx.writePackage}"/></class:abapClass>`});
  assert.equal(made.status, 200, 'setup CREATE');
  const lock = await ctx.session.request({method: 'POST', path: ctx.path, query: {_action: 'LOCK', accessMode: 'MODIFY'},
    headers: {accept: 'application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result'}});
  ctx.handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(lock.body)?.[1];
  assert.equal(lock.status, 200, 'setup LOCK');
  const lower = ctx.name.toLowerCase();
  const source = `CLASS ${lower} DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS broken.\nENDCLASS.\n\nCLASS ${lower} IMPLEMENTATION.\n  METHOD broken.\n    lv_not_declared = 1.\n  ENDMETHOD.\nENDCLASS.\n`;
  const put = await ctx.session.request({method: 'PUT', path: `${ctx.path}/source/main`, query: {lockHandle: ctx.handle},
    headers: {'content-type': 'text/plain'}, body: source});
  assert.equal(put.status, 200, 'setup PUT broken source');
}
async function remove(ctx) {
  if (!ctx.created) return;
  try {
    const present = await ctx.session.request({path: ctx.path});
    if (present.status === 404) return;
    if (!ctx.handle) {
      const lock = await ctx.session.request({method: 'POST', path: ctx.path, query: {_action: 'LOCK', accessMode: 'MODIFY'},
        headers: {accept: 'application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result'}});
      ctx.handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(lock.body)?.[1];
    }
    const deleted = await ctx.session.request({method: 'DELETE', path: ctx.path, query: {lockHandle: ctx.handle}});
    assert.equal(deleted.status, 200, `cleanup DELETE HTTP ${deleted.status}`);
    assert.equal((await ctx.session.request({path: ctx.path})).status, 404, 'cleanup GET after DELETE');
  } catch (error) {error.cleanupFailure = true; throw error;}
}

const method = name => `//testClass[@adtcore:name="LTCL_ZOSD_TEST_DEMO"]/testMethods/testMethod[@adtcore:name="${name}"]`;

export default [
  {id: 'X1-activate-active', point: 'X1', title: 'Activating an unchanged class answers the plain success document',
    // a successful activation on the JS host builds its generation first (in
    // js.mjs's disposable view a full transpile), so X1 alone gets minutes
    request: {...activation(fixture), timeout: 300000},
    expect: {status: 200, namespaces: ns, xml: [
      {xpath: '/chkl:messages/chkl:properties/@checkExecuted', value: 'true'},
      {xpath: '/chkl:messages/chkl:properties/@activationExecuted', value: 'true'},
      {xpath: '/chkl:messages/chkl:properties/@generationExecuted', value: 'true'},
      {xpath: '/chkl:messages/msg', count: 0}]}},
  {id: 'X2-activate-syntax-error', point: 'X2', title: 'Activating a saved syntax error is cancelled with a located E message',
    setup: broken, request: ctx => activation(`/sap/bc/adt${ctx.path}`),
    expect: {status: 200, namespaces: ns, xml: [
      {xpath: '/chkl:messages/chkl:properties/@activationExecuted', value: 'false'},
      {xpath: '/chkl:messages/msg[@type="E"]/@href', regexp: /\/oo\/classes\/zcl_adt_x2_[0-9a-f]{16}\/source\/main#start=\d+,\d+$/},
      {xpath: '/chkl:messages/msg[@type="E"]/@objDescr', regexp: /^Class ZCL_ADT_X2_[0-9A-F]{16}$/}]},
    after: async (ctx, response) => {try {
      if (!ctx.path || !response) return;
      const inactive = await ctx.session.request({path: '/activation/inactiveobjects'});
      assert.equal(inactive.status, 200, 'GET inactive objects');
      assert.ok(inactive.body.includes(`adtcore:name="${ctx.name}"`), 'a cancelled activation leaves the object inactive');
    } finally {await remove(ctx);}}},
  {id: 'X3-unit-pass', point: 'X3', title: 'ABAP Unit runs one passing method of the fixture',
    request: unit('greeting_passes'),
    expect: {status: 200, contentType: /^application\/vnd\.sap\.adt\.abapunit\.testruns\.result\.v2\+xml/, namespaces: ns, xml: [
      {xpath: '/aunit:runResult/program/@adtcore:name', value: 'ZCL_ZOSD_TEST_DEMO'},
      {xpath: '//testMethod/@adtcore:name', value: 'GREETING_PASSES'},
      {xpath: '//alert', count: 0}]}},
  {id: 'X4-unit-failure', point: 'X4', title: 'ABAP Unit reports the deliberate failed assertion',
    request: unit('deliberate_failure'),
    expect: {status: 200, contentType: /^application\/vnd\.sap\.adt\.abapunit\.testruns\.result\.v2\+xml/, namespaces: ns, xml: [
      {xpath: '//testMethod/@adtcore:name', value: 'DELIBERATE_FAILURE'},
      {xpath: `${method('DELIBERATE_FAILURE')}/alerts/alert/@kind`, value: 'failedAssertion'},
      {xpath: `${method('DELIBERATE_FAILURE')}/alerts/alert/@severity`, value: 'critical'},
      {xpath: `${method('DELIBERATE_FAILURE')}/alerts/alert/title`, regexp: /^Critical Assertion Error: '.*fails on purpose'$/},
      {xpath: `${method('DELIBERATE_FAILURE')}/alerts/alert/details/detail/@text`, value: ['Different values', "Test 'LTCL_ZOSD_TEST_DEMO->DELIBERATE_FAILURE' in Main Program 'ZCL_ZOSD_TEST_DEMO============CP'"]},
      {xpath: `${method('DELIBERATE_FAILURE')}/alerts/alert/stack/stackEntry[@adtcore:name="ZCL_ZOSD_TEST_DEMO"]/@adtcore:uri`, regexp: /^\/sap\/bc\/adt\/oo\/classes\/zcl_zosd_test_demo\/includes\/testclasses#start=\d+,0$/}]}},
];
