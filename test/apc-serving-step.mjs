import {expect} from 'chai';
import {connect} from 'node:net';
import {once} from 'node:events';
import {zipInProcess} from '../tools/osd-abapgit-zip.mjs';
import {userLayersOf} from '../tools/osd-source-layers.mjs';
import {withSystem} from '../tools/osd-store-destination.mjs';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {runtimeRootFixture} from './helpers/runtime-root.mjs';
import {ServingRuntime} from '../tools/osd-runtime.mjs';
import {ObjectStore} from '../tools/osd-store.mjs';
import {StoreDestination} from '../tools/osd-store-destination.mjs';
import {ActivationJournal} from '../tools/osd-activation-journal.mjs';
import {WarmCompilerProcess} from '../tools/osd-warm-process.mjs';
import {closeWarm} from '../tools/osd-store-warm.mjs';
import {frame, unframe} from '../tools/osd-apc.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  // 150 s, not 60: the recycle waits cover a publish whose cold build is a
  // full transpile, and CI runners measured 68.9 s for the whole test while
  // GREEN (H5a's run of 2026-11-12) -- one slow runner over 60 s and the
  // journal's pending entry is read as a hang (the suites (5) reds of this
  // round's run, serving stack byte-identical to main). until() returns as
  // soon as the predicate holds, so the wider deadline costs nothing but the
  // wait of a genuine hang; mocha's own 180 s bound still ends the test.
  const deadline = Date.now() + 150000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  expect(predicate(), 'condition did not complete').to.equal(true);
}
async function channel(runtime) {
  const socket = connect(new URL(runtime.url).port, '127.0.0.1');
  const messages = [];
  let buffer = Buffer.alloc(0), upgraded = false;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      expect(buffer.subarray(0, end).toString()).to.include('101 Switching Protocols');
      buffer = buffer.subarray(end + 4); upgraded = true;
    }
    for (;;) {
      const parsed = unframe(buffer);
      if (!parsed) break;
      buffer = parsed.rest;
      if (parsed.opcode === 1) messages.push(parsed.payload.toString());
    }
  });
  await once(socket, 'connect');
  socket.write('GET /store-step HTTP/1.1\r\nHost: probe\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  await until(() => messages.length === 1);
  expect(messages).to.deep.equal(['ready']);
  return {socket, messages, send(text) {
    const bytes = frame(text), mask = randomBytes(4), body = Buffer.from(bytes.subarray(2));
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    socket.write(Buffer.concat([Buffer.from([bytes[0], bytes[1] | 128]), mask, body]));
  }};
}

describe('APC publication in a real ServingRuntime', function () {
  this.timeout(180000);
  const fixture = runtimeRootFixture();
  let store, runtime, client, release, priorLayers;
  const source = value => `CLASS zcl_apc_store_target DEFINITION PUBLIC CREATE PUBLIC.
PUBLIC SECTION. CLASS-METHODS answer RETURNING VALUE(rv) TYPE i. ENDCLASS.
CLASS zcl_apc_store_target IMPLEMENTATION. METHOD answer. rv = ${value}. ENDMETHOD. ENDCLASS.\n`;
  before(async () => {
    const root = fixture.root;
    priorLayers = process.env.OSD_LAYERS;
    const repository = join(root, 'zip-fixture'); mkdirSync(join(repository, 'src'), {recursive: true});
    writeFileSync(join(repository, '.abapgit.xml'), '<STARTING_FOLDER>/src/</STARTING_FOLDER><FOLDER_LOGIC>FULL</FOLDER_LOGIC>');
    writeFileSync(join(repository, 'src/package.devc.xml'), '<DEVC><DEVCLASS>$ZAPCTEST</DEVCLASS><CTEXT>APC fixture</CTEXT></DEVC>');
    writeFileSync(join(repository, 'src/zcl_apc_store_target.clas.abap'), source(1));
    const archive = join(root, 'fixture.zip'); writeFileSync(archive, zipInProcess(repository));
    process.env.OSD_LAYERS = archive;
    writeFileSync(join(root, 'src/zstore_step.sapc.xml'), '<SAPC><APPLICATION_ID>ZSTORE_STEP</APPLICATION_ID><PATH>/store-step</PATH><CLASS_NAME>ZCL_OSD_APC_STORE_PROBE</CLASS_NAME><STATEFUL>X</STATEFUL></SAPC>');
    store = new ObjectStore({root});
    store.activationJournal = new ActivationJournal(root, {host: 'serving-apc-probe'});
    store.warmState = {on: false};
    expect((await store.publish()).ok).to.equal(true);
  });
  after(() => {
    if (priorLayers === undefined) delete process.env.OSD_LAYERS; else process.env.OSD_LAYERS = priorLayers;
  });
  it('first ZIP STORE WRITE + ACTIVATE stays warm and an open APC session survives', async () => {
    const root = fixture.root, layers = userLayersOf(root);
    runtime = new ServingRuntime({root, env: {STG_DB: 'sqlite', STG_DB_PATH: '', OSD_ADT_ONE_RUNTIME: '1', OSD_WARM: '0'}});
    const destination = runtime.storeDestination = new StoreDestination({store});
    await runtime.start(); store.served = runtime;
    store.warmState = {on: true, compiler: new WarmCompilerProcess({root,
      overlay: set => store.overlay(set), keyOf: file => store.objectKeyOf(file), inactiveSources: set => store.inactiveSources(set)})};
    expect(await store.warmUp(), store.warmState.reason).not.to.equal(undefined);
    const epoch = runtime.epoch;
    client = await channel(runtime);
    const execute = command => withSystem(() => {}, () => destination.execute({IV_COMMAND: command,
      IV_TYPE: 'CLAS', IV_NAME: 'ZCL_APC_STORE_TARGET', IV_SOURCE: source(7)}), {store});
    expect((await execute('WRITE')).EV_ERROR ?? '').to.equal('');
    const publication = store.publish.bind(store); let result;
    store.publish = async options => {result = await publication(options); return result;};
    try {
      const operation = JSON.parse((await execute('ACTIVATE')).EV_JSON);
      expect(operation).to.include({state: 'published', active: true, live: true});
      expect(result).to.include({ok: true, hot: true, recycled: false});
      expect(result.transpile.warm).to.equal(true);
      await store.warmState.verifying;
      expect(store.activationJournal.lookup(operation.op_id).verified).to.equal(true);
      expect(runtime.epoch).to.equal(epoch); expect(client.socket.destroyed).to.equal(false);
      client.send('lookup:' + operation.op_id);
      await until(() => client.messages.length === 2);
      expect(JSON.parse(client.messages[1])).to.include({op_id: operation.op_id, state: 'published'});
      expect(readFileSync(join(root, layers[0].path, 'zcl_apc_store_target.clas.abap'), 'utf8')).to.equal(source(1));
      expect(store.read('CLAS', 'ZCL_APC_STORE_TARGET', 'main', 'active').source).to.equal(source(7));
    } finally {store.publish = publication;}
  });
  afterEach(async () => {
    release?.(); release = undefined;
    client?.socket.destroy(); client = undefined;
    await closeWarm(store); await store.warmState?.verifying;
    await runtime?.stop(); runtime = undefined; store.served = undefined;
  });
  for (const fallback of [false, true]) {
    it(`${fallback ? 'refused warm swap' : 'cold build'} recycles after transport closure and exposes the committed journal on reconnect`, async () => {
      runtime = new ServingRuntime({root: fixture.root, env: {STG_DB: 'sqlite', STG_DB_PATH: '', OSD_ADT_ONE_RUNTIME: '1', OSD_WARM: '0'}});
      runtime.storeDestination = new StoreDestination({store});
      await runtime.start(); store.served = runtime;
      const epoch = runtime.epoch;
      let refused = 0;
      if (fallback) {
        store.warmState = {on: true, compiler: new WarmCompilerProcess({root: fixture.root,
          overlay: set => store.overlay(set), keyOf: file => store.objectKeyOf(file), inactiveSources: set => store.inactiveSources(set)})};
        expect(await store.warmUp()).not.to.equal(undefined);
        runtime.hot = async () => { refused++; throw new Error('regression: warm swap refused'); };
      } else store.warmState = {on: false};
      await store.write('CLAS', 'ZCL_APC_STORE_TARGET', source(fallback ? 3 : 2));
      let enter;
      const entered = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const publish = store.publish.bind(store);
      store.publish = async options => { enter(); await gate; return publish(options); };
      try {
        client = await channel(runtime);
        client.send('activate'); client.send('activate');
        await entered;
        const operation = Object.values(store.activationJournal.entries).at(-1);
        expect(operation.state).to.equal('pending');
        const count = Object.keys(store.activationJournal.entries).length;
        const disconnected = once(client.socket, 'close');
        client.socket.destroy(); await disconnected;
        // Let the child observe transport closure before releasing publication.
        await pause(50); release();
        await until(() => store.activationJournal.lookup(operation.op_id).state !== 'pending');
        const published = store.activationJournal.lookup(operation.op_id);
        expect(published).to.include({state: 'published', active: true, live: true});
        expect(runtime.epoch).to.equal(epoch + 1);
        expect(refused).to.equal(fallback ? 1 : 0);
        expect(Object.keys(store.activationJournal.entries)).to.have.length(count);
        client = await channel(runtime);
        client.send('lookup:' + operation.op_id);
        await until(() => client.messages.length === 2);
        expect(JSON.parse(client.messages[1])).to.deep.equal(published);
      } finally { release(); store.publish = publish; }
    });
  }
});
