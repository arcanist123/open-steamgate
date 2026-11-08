import assert from 'node:assert/strict';
import express from 'express';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runJS} from './js.mjs';
import {normalize} from './normalize.mjs';
import {xpath, assertResponse} from './assertions.mjs';
import {Session} from './session.mjs';
import {loadCases, classify, validateExpected, run, recordUnavailable} from './run.mjs';
import {mergeSquare} from './square.mjs';
import lockCases from './cases/locks.mjs';
import writeCases from './cases/writes.mjs';

describe('shared ADT conformance runner contracts', function () {
  this.timeout(180000);
  // The runner's policy for an all-gap target is tested against an all-gap
  // file, not against expected/osgo.json, whose entries turn to pass as osgo
  // implements cases.
  const allGaps = dir => {
    const expected = JSON.parse(readFileSync(new URL('./expected/osgo.json', import.meta.url), 'utf8'));
    const file = join(dir, 'all-gaps.json');
    writeFileSync(file, JSON.stringify(Object.fromEntries(Object.keys(expected)
      .map(id => [id, expected[id].startsWith('known-gap: ') ? expected[id] : 'known-gap: synthetic all-gap fixture']))));
    return file;
  };
  it('normalizes volatile identity without destroying protocol coordinates or handle lengths', () => {
    const json = normalize({userName: 'synthetic', client: '123', lockHandle: 'abc123', generation_id: 'abcdef', name: 'ZCL_FIX'});
    assert.deepEqual(json, {userName: '{username}', client: '{client}', lockHandle: '******', generation_id: '******', name: 'ZCL_FIX'});
    const xml = normalize('<LOCK_HANDLE>012345</LOCK_HANDLE><x href="http://example.invalid/a#start=2,6;end=2,28" etag="abcd" changedBy="synthetic"/>', {host: 'http://example.invalid'});
    assert.equal(normalize("<x session-id='abc123' client='123'><a:changedBy xmlns:a='urn:x'>synthetic</a:changedBy></x>"),
      "<x session-id='******' client='{client}'><a:changedBy xmlns:a='urn:x'>{changedby}</a:changedBy></x>");
    assert.equal(xml, '<LOCK_HANDLE>******</LOCK_HANDLE><x href="{host}/a#start=2,6;end=2,28" etag="****" changedBy="{changedby}"/>');
  });
  it('preserves systemID and matches complete volatile XML attribute names', () => {
    assert.notDeepEqual(normalize({systemID: 'ABC'}), normalize({systemID: 'XYZ'}));
    const xml = '<x systemID="ABC" objectclient="001" objectclientXYZ="002" clientXYZ="003" client="004" a:client="005"/>';
    assert.equal(normalize(xml), '<x systemID="ABC" objectclient="001" objectclientXYZ="002" clientXYZ="003" client="{client}" a:client="{client}"/>');
    assert.notEqual(normalize('<x objectclient="001"/>'), normalize('<x objectclient="999"/>'));
    assert.notEqual(normalize('<systemID>ABC</systemID>'), normalize('<systemID>XYZ</systemID>'));
  });
  it('retains a failed UNLOCK handle and releases it before reacquisition', async () => {
    const c = lockCases.find(c => c.point === 'L4');
    const handle = 'a'.repeat(40), otherHandle = 'b'.repeat(40), calls = [];
    let attempts = 0;
    const ctx = {session: {request: async req => {
      calls.push(req.query._action);
      if (req.query._action === 'LOCK') return {status: 200, body: `<LOCK_HANDLE>${handle}</LOCK_HANDLE>`};
      assert.equal(ctx.handle, handle);
      assert.equal(req.query.lockHandle, handle);
      return {status: ++attempts < 3 ? 500 : 200};
    }}, newSession: async () => {
      assert.equal(ctx.handle, undefined, 'release before opening the competing session');
      return {request: async req => {
        calls.push('other ' + req.query._action);
        return {status: 200, body: `<LOCK_HANDLE>${otherHandle}</LOCK_HANDLE>`};
      }};
    }};
    await c.setup(ctx);
    const failed = await ctx.session.request(c.request(ctx));
    await assert.rejects(c.after(ctx, failed), /cleanup UNLOCK/);
    assert.equal(ctx.handle, handle, 'failed cleanup retains the handle');
    await c.after(ctx, failed);
    assert.equal(ctx.handle, undefined);
    assert.deepEqual(calls, ['LOCK', 'UNLOCK', 'UNLOCK', 'UNLOCK', 'other LOCK', 'other UNLOCK']);
  });
  it('cleans up an L4 handle captured before a setup assertion failed', async () => {
    const c = lockCases.find(c => c.point === 'L4'), handle = 'c'.repeat(40), calls = [];
    const ctx = {session: {request: async req => {
      calls.push(req.query._action);
      return {status: req.query._action === 'LOCK' ? 500 : 200, body: `<LOCK_HANDLE>${handle}</LOCK_HANDLE>`};
    }}, newSession: async () => {
      assert.equal(ctx.handle, undefined);
      return {request: async req => {
        calls.push('other ' + req.query._action);
        return {status: 200, body: `<LOCK_HANDLE>${handle}</LOCK_HANDLE>`};
      }};
    }};
    await assert.rejects(c.setup(ctx), /setup LOCK/);
    assert.equal(ctx.handle, handle);
    await c.after(ctx, undefined);
    assert.deepEqual(calls, ['LOCK', 'UNLOCK', 'other LOCK', 'other UNLOCK']);
  });
  it('never deletes a pre-existing object or a clean duplicate refusal', async () => {
    const c = writeCases.find(c => c.point === 'W2');
    for (const existing of [true, false]) {
      const calls = [];
      const ctx = {writePackage: '$FIXTURE', session: {request: async req => {
        calls.push(req.method ?? 'GET');
        return {status: req.method === 'POST' ? 400 : existing ? 200 : 404, body: 'ExceptionResourceAlreadyExists'};
      }}};
      await assert.rejects(c.setup(ctx)); await c.after(ctx);
      assert.deepEqual(calls, existing ? ['GET'] : ['GET', 'POST']);
    }
  });
  it('reconciles lost CREATE responses and unexpected statuses after confirmed absence', async () => {
    const c = writeCases.find(c => c.point === 'W2'), handle = 'a'.repeat(40);
    for (const outcome of ['lost', '500', 'absent', 'unresolved']) {
      let reads = 0; const calls = [];
      const ctx = {writePackage: '$FIXTURE', session: {request: async req => {
        calls.push(req.method ?? 'GET');
        if (!req.method) return {status: ++reads === 1 || reads === 3 || outcome === 'absent' ? 404 : outcome === 'unresolved' ? 503 : 200};
        if (req.method === 'DELETE') {assert.equal(req.query.lockHandle, handle); return {status: 200};}
        if (req.query?._action === 'LOCK') return {status: 200, body: `<LOCK_HANDLE>${handle}</LOCK_HANDLE>`};
        if (outcome === '500') return {status: 500, body: ''};
        throw new Error('CREATE response lost');
      }}};
      await assert.rejects(c.setup(ctx));
      if (outcome === 'unresolved') await assert.rejects(c.after(ctx), e => e.cleanupFailure === true);
      else await c.after(ctx);
      assert.deepEqual(calls, outcome === 'absent' || outcome === 'unresolved' ? ['GET', 'POST', 'GET'] : ['GET', 'POST', 'GET', 'POST', 'DELETE', 'GET']);
    }
  });
  it('retains W4 ownership and its handle after a failed cleanup DELETE', async () => {
    const c = writeCases.find(c => c.point === 'W4'), handle = 'a'.repeat(40), calls = [];
    const ctx = {createAttempted: true, absentBeforeAttempt: true, attemptedPath: '/oo/classes/synthetic', path: '/oo/classes/synthetic', name: 'SYNTHETIC', session: {request: async req => {
      calls.push(req);
      if (!req.method) return {status: 200};
      if (req.method === 'POST') return {status: 400, body: 'ExceptionResourceAlreadyExists'};
      return {status: req.query?.lockHandle ? 500 : 423, body: 'ExceptionResourceInvalidLockHandle'};
    }}};
    await assert.rejects(c.after(ctx, {status: 200, body: `<LOCK_HANDLE>${handle}</LOCK_HANDLE>`}), error => {
      assert.equal(error.cleanupFailure, true); return /cleanup DELETE/.test(error.message);
    });
    assert.equal(ctx.handle, handle); assert.equal(ctx.path, '/oo/classes/synthetic');
    assert.equal(calls.at(-1).query.lockHandle, handle);
  });
  it('acquires a cleanup lock, deletes with it, and verifies absence', async () => {
    const c = writeCases.find(c => c.point === 'W2'), calls = [], handle = 'b'.repeat(40);
    let reads = 0;
    const ctx = {createAttempted: true, absentBeforeAttempt: true, attemptedPath: '/oo/classes/synthetic', path: '/oo/classes/synthetic', session: {request: async req => {
      calls.push(req);
      return req.method === 'POST' ? {status: 200, body: `<LOCK_HANDLE>${handle}</LOCK_HANDLE>`}
        : {status: req.method === 'DELETE' || ++reads === 1 ? 200 : 404};
    }}};
    await c.after(ctx);
    assert.deepEqual(calls.map(r => r.method ?? 'GET'), ['GET', 'POST', 'DELETE', 'GET']);
    assert.equal(calls[2].query.lockHandle, handle); assert.equal(ctx.path, undefined);
  });
  it('checks processed reports with arbitrary prefixes and allows warnings but rejects clean errors', async () => {
    const c = writeCases.find(c => c.point === 'W5'), path = '/oo/classes/synthetic';
    const xml = (status, messages) => `<q:checkRunReports xmlns:q="http://www.sap.com/adt/checkrun"><q:checkReport q:triggeringUri="/sap/bc/adt${path}" q:status="${status}"><q:checkMessageList>${messages}</q:checkMessageList></q:checkReport></q:checkRunReports>`;
    const message = type => `<q:checkMessage q:type="${type}" q:uri="/sap/bc/adt${path}/source/main#start=8,5"/>`;
    for (const [status, type, rejected] of [['processed', 'W', false], ['notProcessed', 'W', true], ['processed', 'E', true]]) {
      const ctx = {createAttempted: true, absentBeforeAttempt: true, attemptedPath: path, path, name: 'SYNTHETIC', handle: 'c'.repeat(40), session: {request: async req => ({
        status: req.method === 'DELETE' || req.method === 'PUT' || req.path === '/checkruns' ? 200 : 404,
        body: req.path === '/checkruns' ? xml(status, message(type)) : '',
      })}};
      const checked = c.after(ctx, {status: 200, body: xml('processed', message('E'))});
      if (rejected) await assert.rejects(checked, /CHECK processed|zero E messages/); else await checked;
      assert.equal(ctx.path, undefined, 'cleanup runs even after report failure');
    }
  });
  it('selects namespace-aware XML paths and rejects unsupported XPath', () => {
    const xml = '<q:root xmlns:q="urn:fixture"><q:item id="1">a&amp;b</q:item><q:item id="2">other</q:item></q:root>';
    assert.deepEqual(xpath(xml, '/p:root/p:item[@id="1"]/text()', {p: 'urn:fixture'}), ['a&b']);
    assert.deepEqual(xpath(xml, '//p:item/@id', {p: 'urn:fixture'}), ['1', '2']);
    assert.deepEqual(xpath('<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:content src="fixture"/></atom:entry></atom:feed>',
      '/atom:feed/atom:entry/atom:content/@src'), ['fixture']);
    assert.throws(() => xpath('<r xmlns:a="urn:x" xmlns:b="urn:x" a:id="1" b:id="2"/>', '/r'), /duplicate expanded attribute/);
    assert.throws(() => xpath('<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>', '/r'), /declarations/);
    assert.throws(() => xpath(xml, '//p:item[2]', {p: 'urn:fixture'}), /unsupported XPath/);
    assert.throws(() => assertResponse({status: 200, headers: new Headers(), body: xml, bytes: Buffer.from(xml)},
      {status: 200, xml: [{xpath: '//p:missing', value: 'x'}], namespaces: {p: 'urn:fixture'}}), /selected nothing/);
  });
  it('makes unexpected improvements fail and rejects stale/missing expected entries', async () => {
    assert.equal(classify(true, 'known-gap: route 404'), 'fail');
    assert.equal(classify(false, 'known-gap: route 404'), 'known-gap');
    assert.equal(classify(false), 'fail');
    assert.equal(classify(true, 'n/a: unsupported object kind'), 'not-applicable');
    const cases = await loadCases();
    validateExpected(JSON.parse(readFileSync(new URL('./expected/osgo.json', import.meta.url), 'utf8')), cases);
    assert.throws(() => validateExpected({}, cases), /missing expectation/);
    assert.throws(() => validateExpected({obsolete: 'pass'}, cases), /unknown expected case/);
  });
  it('keeps repeated cookies and refreshed cookie values across requests', async () => {
    const app = express();
    app.head('/sap/bc/adt/core/discovery', (req, res) => {
      res.setHeader('set-cookie', ['first=old; Path=/', 'second=two; Path=/']);
      res.setHeader('x-csrf-token', 'synthetic-token'); res.end();
    });
    app.get('/sap/bc/adt/probe', (req, res) => {
      assert.match(req.headers.cookie, /first=old/); assert.match(req.headers.cookie, /second=two/);
      assert.equal(req.headers['x-csrf-token'], 'synthetic-token');
      res.setHeader('set-cookie', 'first=new; Path=/'); res.end('ok');
    });
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    try {const session = await new Session(`http://127.0.0.1:${server.address().port}`).login();
      assert.equal((await session.request({path: '/probe'})).body, 'ok'); assert.equal(session.cookies.get('first'), 'new');}
    finally {await new Promise(resolve => server.close(resolve));}
  });
  it('observes a failed login answer for an expected osgo gap', async () => {
    const app = express(); app.use((req, res) => res.sendStatus(404));
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    const output = mkdtempSync(join(tmpdir(), 'adt-report-'));
    try {
      const result = await run({target: 'osgo', base: `http://127.0.0.1:${server.address().port}`,
        expectedFile: allGaps(output), only: ['C3-head'], output, say: () => {}});
      assert.equal(result.exitCode, 0); assert.equal(result.cases[0].status, 'known-gap');
      assert.equal(result.cases[0].observed, true); assert.equal(result.cases[0].actual.status, 404);
      assert.equal(result.targetAnswered, true); assert.equal(result.handshakeStatus, 404);
      assert.match(result.cases[0].detail, /login/);
      assert.equal(result.executedCases, 0); assert.equal(result.discoverySucceeded, false);
      const unavailable = await recordUnavailable({expectedFile: allGaps(output), output,
        reason: 'osgo: not mountable on this main'});
      assert.ok(unavailable.cases.every(c => c.observed === false && c.status === 'known-gap'));
    } finally {await new Promise(resolve => server.close(resolve)); rmSync(output, {recursive: true, force: true});}
  });
  it('observes an all-known-gap osgo run through a failed CSRF handshake', async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-answered-'));
    const app = express(); app.use((req, res) => res.sendStatus(501));
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    try {
      const result = await run({target: 'osgo', base: `http://127.0.0.1:${server.address().port}`,
        expectedFile: allGaps(output), output, say: () => {}});
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.summary['known-gap'], (await loadCases()).length); assert.equal(result.summary.fail, 0);
      assert.equal(result.targetAnswered, true); assert.equal(result.handshakeStatus, 501);
      assert.equal(result.discoverySucceeded, false); assert.equal(result.executedCases, 0);
      assert.ok(result.cases.every(c => c.observed && c.actual?.status === 501));
      assert.ok(result.cases.every(c => /CSRF handshake status/.test(c.detail)));
    } finally {await new Promise(resolve => server.close(resolve)); rmSync(output, {recursive: true, force: true});}
  });
  it('fails an observed failed handshake when an osgo case is expected to pass', async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-answered-pass-'));
    const expected = JSON.parse(readFileSync(new URL('./expected/osgo.json', import.meta.url), 'utf8'));
    expected['C3-head'] = 'pass';
    const expectedFile = join(output, 'expected.json'); writeFileSync(expectedFile, JSON.stringify(expected));
    const app = express(); app.use((req, res) => res.sendStatus(501));
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    try {
      const result = await run({target: 'osgo', base: `http://127.0.0.1:${server.address().port}`,
        expectedFile, only: ['C3-head'], output, say: () => {}});
      assert.equal(result.exitCode, 1); assert.equal(result.summary.fail, 1);
      assert.equal(result.targetAnswered, true); assert.equal(result.handshakeStatus, 501);
      assert.equal(result.cases[0].observed, true); assert.equal(result.cases[0].actual.status, 501);
    } finally {await new Promise(resolve => server.close(resolve)); rmSync(output, {recursive: true, force: true});}
  });
  it('keeps connection refusal an infrastructure failure', async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-refused-'));
    // A port that was just bound and released: the connect itself is refused
    // (port 1 would be rejected by fetch as a bad port before any networking).
    const closed = await new Promise(resolve => {const s = express().listen(0, '127.0.0.1', () => {const port = s.address().port; s.close(() => resolve(port));});});
    try {
      const result = await run({target: 'osgo', base: `http://127.0.0.1:${closed}`,
        expectedFile: new URL('./expected/osgo.json', import.meta.url), only: ['C3-head'], output, say: () => {}});
      assert.equal(result.exitCode, 1); assert.equal(result.summary.fail, 1);
      assert.equal(result.targetAnswered, false); assert.equal(result.handshakeStatus, undefined);
      assert.equal(result.cases[0].observed, false); assert.match(result.cases[0].detail, /login/);
      assert.equal(result.discoverySucceeded, false); assert.equal(result.executedCases, 0);
    } finally {rmSync(output, {recursive: true, force: true});}
  });
  it('requires the full JS handshake and fails a 501 answer', async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-js-answered-'));
    const app = express(); app.use((req, res) => res.sendStatus(501));
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    try {
      const result = await run({target: 'js', base: `http://127.0.0.1:${server.address().port}`,
        only: ['C3-head'], output, say: () => {}});
      assert.equal(result.exitCode, 1); assert.equal(result.summary.fail, 1);
      assert.equal(result.targetAnswered, true); assert.equal(result.handshakeStatus, 501);
      assert.equal(result.cases[0].observed, true); assert.equal(result.cases[0].actual.status, 501);
      assert.equal(result.discoverySucceeded, false); assert.equal(result.executedCases, 0);
    } finally {await new Promise(resolve => server.close(resolve)); rmSync(output, {recursive: true, force: true});}
  });
  it('fails all-n/a runs with zero observations, even without contacting a server', async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-empty-'));
    try {
      const expectedFile = join(output, 'expected.json');
      writeFileSync(expectedFile, JSON.stringify(Object.fromEntries((await loadCases()).map(c => [c.id, 'n/a: synthetic exclusion']))));
      const result = await run({target: 'osgo', base: 'http://127.0.0.1:0', expectedFile, output, say: () => {}});
      assert.equal(result.exitCode, 1); assert.equal(result.summary['not-applicable'], (await loadCases()).length);
      assert.equal(result.executedCases, 0); assert.equal(result.discoverySucceeded, false);
      assert.ok(result.cases.every(c => !c.observed));
      assert.deepEqual(result.runErrors, ['no executed cases', 'no successful discovery request']);
    } finally {rmSync(output, {recursive: true, force: true});}
  });
  it('requires GET discovery after a successful handshake and observes its failure', async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-discovery-'));
    const app = express();
    app.head('/sap/bc/adt/core/discovery', (req, res) => {
      res.setHeader('set-cookie', 'session=synthetic; Path=/');
      res.setHeader('x-csrf-token', 'synthetic-token'); res.end();
    });
    app.use((req, res) => res.sendStatus(req.path.endsWith('/logoff') ? 200 : 503));
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    try {
      const opts = {target: 'osgo', expectedFile: allGaps(output),
        only: ['C3-head'], output, say: () => {}};
      for (const base of ['http://127.0.0.1:0', `http://127.0.0.1:${server.address().port}`]) {
        const result = await run({...opts, base});
        assert.equal(result.exitCode, base.endsWith(':0') ? 1 : 0);
        assert.equal(result.summary.fail, base.endsWith(':0') ? 1 : 0);
        assert.equal(result.executedCases, 0); assert.equal(result.discoverySucceeded, false);
        assert.equal(result.targetAnswered, !base.endsWith(':0'));
        if (base.endsWith(':0')) assert.ok(result.cases.every(c => !c.observed));
        else assert.ok(result.cases.every(c => c.observed && c.actual.status === 503));
        assert.match(result.cases[0].detail, base.endsWith(':0') ? /login/ : /discovery/);
      }
    } finally {await new Promise(resolve => server.close(resolve)); rmSync(output, {recursive: true, force: true});}
  });
  it('fails zero-observation runs even when discovery succeeds and setup is a known gap', async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-no-observations-'));
    const app = express();
    app.head('/sap/bc/adt/core/discovery', (req, res) => {
      res.setHeader('set-cookie', 'session=synthetic; Path=/');
      res.setHeader('x-csrf-token', 'synthetic-token'); res.end();
    });
    app.get('/sap/bc/adt/core/discovery', (req, res) => res.end('<discovery/>'));
    app.use((req, res) => res.sendStatus(req.path.endsWith('/logoff') ? 200 : 403));
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    try {
      const result = await run({target: 'osgo', base: `http://127.0.0.1:${server.address().port}`,
        expectedFile: allGaps(output), only: ['L2-repeat-lock'], output, say: () => {}});
      assert.equal(result.summary['known-gap'], 1);
      assert.equal(result.discoverySucceeded, true); assert.equal(result.executedCases, 0);
      assert.equal(result.cases[0].observed, false); assert.equal(result.exitCode, 1);
      assert.deepEqual(result.runErrors, ['no executed cases']);
    } finally {await new Promise(resolve => server.close(resolve)); rmSync(output, {recursive: true, force: true});}
  });
  it("counts an assertion in a case's after() as case evidence, not cleanup", async () => {
    const output = mkdtempSync(join(tmpdir(), 'adt-after-assert-'));
    const app = express();
    app.head('/sap/bc/adt/core/discovery', (req, res) => {
      res.setHeader('set-cookie', 'session=synthetic; Path=/');
      res.setHeader('x-csrf-token', 'synthetic-token'); res.end();
    });
    app.get('/sap/bc/adt/core/discovery', (req, res) => res.end('<discovery/>'));
    // every LOCK succeeds, also from a second session: the lock does not
    // survive, so L5's after() assertion (403 expected) fails
    app.post('/sap/bc/adt/oo/classes/zcl_osd_adt_uri', (req, res) => {
      res.type('application/vnd.sap.as+xml');
      res.end(req.query._action === 'LOCK' ? `<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>${'a'.repeat(40)}</LOCK_HANDLE><IS_LOCAL>X</IS_LOCAL></DATA></asx:values></asx:abap>` : '');
    });
    app.get('/sap/bc/adt/oo/classes/zcl_osd_adt_uri/source/main', (req, res) => res.type('text/plain').end('CLASS zcl_osd_adt_uri DEFINITION.'));
    app.use((req, res) => res.sendStatus(req.path.endsWith('/logoff') ? 200 : 404));
    const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const gap = await run({target: 'osgo', base, expectedFile: allGaps(output), only: ['L5-stateless-read'], output, say: () => {}});
      assert.equal(gap.cases[0].status, 'known-gap'); assert.match(gap.cases[0].detail, /^after: lock survives stateless read/);
      const passFile = join(output, 'pass.json');
      writeFileSync(passFile, JSON.stringify({...JSON.parse(readFileSync(allGaps(output), 'utf8')), 'L5-stateless-read': 'pass'}));
      const pass = await run({target: 'osgo', base, expectedFile: passFile, only: ['L5-stateless-read'], output, say: () => {}});
      assert.equal(pass.cases[0].status, 'fail'); assert.equal(pass.exitCode, 1);
    } finally {await new Promise(resolve => server.close(resolve)); rmSync(output, {recursive: true, force: true});}
  });
  it('merges latest evidence without inventing A4H observations', () => {
    const cases = [{id: 'C1', point: 'C1', title: 'discovery'}];
    const report = (createdAt, status) => ({schema: 1, target: 'js', createdAt, cases: [{id: 'C1', status, observed: true}]});
    const square = mergeSquare(cases, [report('2026-01-02', 'pass'), report('2026-01-01', 'fail'), {target: 'irrelevant'}]);
    assert.equal(square[0].js.status, 'pass'); assert.equal(square[0].a4h.status, 'not-measured');
    assert.throws(() => mergeSquare(cases, [report('2026-01-02', 'pass'), report('2026-01-02', 'fail')]), /conflicting/);
  });
  it('runs every conformance case through the existing JS server helper', async () => {
    const result = await runJS();
    assert.equal(result.exitCode, 0, JSON.stringify(result.summary));
    assert.equal(result.executedCases, (await loadCases()).length); assert.equal(result.discoverySucceeded, true);
  });
});
