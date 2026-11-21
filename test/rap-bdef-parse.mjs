import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseBdef, corpusCounts} from '../tools/rap/bdef-parse.mjs';
import {tokenize} from '../tools/rap/tokenize.mjs';

// Original grammar fixtures, independent of the public corpus.
const wrap = body => `managed; define behavior for ZI_NOTE alias Note { ${body} }`;
const entity = body => {
  const m = parseBdef(wrap(body));
  assert.deepEqual(m.unparsed, []);
  return m.entities[0];
};

describe('RAP BDEF parser (R0)', () => {
  it('reads implementation kinds, class, uniqueness, strict and draft flags', () => {
    for (const type of ['managed', 'unmanaged', 'projection', 'abstract', 'interface']) {
      const m = parseBdef(`${type} implementation in class ZBP_NOTE unique; strict(2); with draft;
        define behavior for ZI_NOTE alias Note { }`);
      assert.equal(m.schemaVersion, 1);
      assert.equal(m.implementationType, type);
      assert.equal(m.implementationClass, 'ZBP_NOTE');
      assert.equal(m.unique, true);
      assert.equal(m.strict, 2);
      assert.equal(m.withDraft, true);
      assert.deepEqual(m.unparsed, []);
    }
    assert.equal(parseBdef('strict;').strict, true);
    assert.equal(parseBdef('define abstract behavior for ZA_NOTE {}').implementationType, 'abstract');
  });

  it('reads multiple entity headers independently and preserves spelling', () => {
    const m = parseBdef(`Unmanaged; define behavior for /ACME/I_Note alias Note
      implementation in class /ACME/BP_Note unique
      persistent table znote draft table znote_d query ZI_Draft
      lock master total etag ChangedAt authorization master (global, instance)
      etag master LocalChangedAt early numbering with additional save
      { create; }
      define behavior for ZI_ITEM alias Item
      lock dependent by _Note authorization dependent by _Note etag dependent by _Note
      late numbering with unmanaged save { update; }`);
    assert.deepEqual(m.unparsed, []);
    assert.equal(m.entities.length, 2);
    const [a, b] = m.entities;
    assert.equal(a.entity, '/ACME/I_Note');
    assert.equal(a.alias, 'Note');
    assert.equal(a.implementationClass, '/ACME/BP_Note');
    assert.equal(a.persistentTable, 'znote');
    assert.equal(a.draftTable, 'znote_d');
    assert.equal(a.draftQuery, 'ZI_Draft');
    assert.equal(a.lock.kind, 'master');
    assert.deepEqual(a.authorization.options, [{name: 'global', value: null}, {name: 'instance', value: null}]);
    assert.equal(a.etag.field, 'LocalChangedAt');
    assert.equal(a.totalEtag, 'ChangedAt');
    assert.equal(a.numbering, 'early');
    assert.deepEqual(a.options, [{kind: 'additional save'}]);
    for (const key of ['lock', 'authorization', 'etag']) assert.deepEqual(b[key], {kind: 'dependent', association: '_Note'});
    assert.equal(b.numbering, 'late');
    assert.deepEqual(b.options, [{kind: 'unmanaged save'}]);
  });

  it('preserves every field attribute and its field list', () => {
    const e = entity(`field (readonly) Id, ChangedAt;
      field (mandatory : create, readonly : update) Title;
      field (numbering:managed, features:instance) Key;`);
    assert.deepEqual(e.fields.map(x => [x.attributes, x.fields]), [
      [[{name: 'readonly', value: null}], ['Id', 'ChangedAt']],
      [[{name: 'mandatory', value: 'create'}, {name: 'readonly', value: 'update'}], ['Title']],
      [[{name: 'numbering', value: 'managed'}, {name: 'features', value: 'instance'}], ['Key']],
    ]);
  });

  it('reads CRUD options and projection use declarations', () => {
    const e = entity('create (features:instance, precheck); update; delete (features:global); use update;');
    assert.deepEqual(e.operations, [
      {kind: 'create', use: false, options: [{name: 'features', value: 'instance'}, {name: 'precheck', value: null}]},
      {kind: 'update', use: false, options: []},
      {kind: 'delete', use: false, options: [{name: 'features', value: 'global'}]},
      {kind: 'update', use: true, options: []},
    ]);
    const p = parseBdef('projection; use draft; use side effects; define behavior for ZC_NOTE use etag { use create; }');
    assert.deepEqual(p.unparsed, []);
    assert.equal(p.entities[0].useEtag, true);
    assert.equal(p.withDraft, true);
  });

  it('reads association operations, features, draft and shorthand forms', () => {
    const e = entity(`association _Items { create (features:instance); with draft; }
      use association _Owner; association _Empty {} association _Root abbreviation Root;
      association _Tree { link action attach; unlink action detach; }`);
    assert.deepEqual(e.associations[0], {name: '_Items', use: false, withDraft: true,
      operations: [{kind: 'create', options: [{name: 'features', value: 'instance'}]}]});
    assert.equal(e.associations[1].use, true);
    assert.deepEqual(e.associations[2].operations, []);
    assert.equal(e.associations[3].abbreviation, 'Root');
    assert.deepEqual(e.associations[4].operations, [{kind: 'link', action: 'attach'}, {kind: 'unlink', action: 'detach'}]);
  });

  it('reads actions/functions, modifiers, parameters and cardinality', () => {
    const e = entity(`static action (features:global) Approve parameter ZA_Input result [1] $self;
      factory action Clone [1]; internal action Reprice;
      static function Search parameter ZA_Query result [0..*] ZI_NOTE;
      function Current result [1] $self;
      use action Approve; use function Current;
      action Change parameter ZA_Input result [1] $self { default function Defaults; }
      draft action Activate optimized; draft action Resume with additional implementation;`);
    assert.deepEqual(e.actions[0], {name: 'Approve', use: false, modifiers: ['static'],
      options: [{name: 'features', value: 'global'}], line: 1, cardinality: null, parameter: {name: 'ZA_Input', deep: false, table: false},
      result: {options: [], cardinality: '1', deep: false, type: '$self'}});
    assert.deepEqual(e.actions[1].modifiers, ['factory']);
    assert.equal(e.actions[1].cardinality, '1');
    assert.deepEqual(e.actions[2].modifiers, ['internal']);
    assert.deepEqual(e.functions[0].result, {options: [], cardinality: '0..*', deep: false, type: 'ZI_NOTE'});
    assert.deepEqual(e.functions[0].parameter, {name: 'ZA_Query', deep: false, table: false});
    assert.equal(e.functions[1].result.type, '$self');
    assert.equal(e.functions[2].use, true);
    assert.equal(e.actions[3].use, true);
    assert.equal(e.actions[4].defaultFunction, 'Defaults');
    assert.equal(e.actions[5].optimized, true);
    assert.equal(e.actions[6].additionalImplementation, true);
  });

  it('distinguishes plain, deep structure and deep table parameters', () => {
    for (const kind of ['action', 'function']) {
      const declarations = ['parameter', 'deep parameter', 'deep table parameter'];
      const models = declarations.map(clause => parseBdef(wrap(`${kind} Submit ${clause} ZA_Payload;`)));
      const callables = models.map(m => {
        assert.deepEqual(m.unparsed, []);
        return m.entities[0][kind === 'action' ? 'actions' : 'functions'][0];
      });
      assert.deepEqual(callables.map(a => a.parameter), [
        {name: 'ZA_Payload', deep: false, table: false},
        {name: 'ZA_Payload', deep: true, table: false},
        {name: 'ZA_Payload', deep: true, table: true},
      ]);
      assert.notDeepEqual(models[1], models[2]);
      for (const a of callables) {
        assert.equal(Object.hasOwn(a, 'deepParameter'), false);
        assert.equal(Object.hasOwn(a, 'result'), false);
      }
    }
  });

  it('preserves result depth independently of parameter depth', () => {
    for (const kind of ['action', 'function']) {
      for (const cardinality of ['1', '0..*']) {
        for (const deep of [false, true]) {
          for (const input of ['', 'parameter ZA_Input', 'deep parameter ZA_Input', 'deep table parameter ZA_Input']) {
            const e = entity(`${kind} Read ${input} ${deep ? 'deep ' : ''}result (instance) [${cardinality}] ZA_Output;`);
            const a = e[kind === 'action' ? 'actions' : 'functions'][0];
            assert.deepEqual(a.result, {options: [{name: 'instance', value: null}], cardinality, deep, type: 'ZA_Output'});
            assert.equal(Object.hasOwn(a, 'deepParameter'), false);
            if (input) {
              assert.deepEqual(a.parameter, {name: 'ZA_Input', deep: input.startsWith('deep'), table: input.includes('table')});
            } else {
              assert.equal(Object.hasOwn(a, 'parameter'), false);
            }
          }
        }
      }
    }
  });

  it('retains incomplete or misplaced deep modifiers in unparsed', () => {
    for (const clause of ['deep', 'deep table', 'deep table result [1] ZA_Output', 'table parameter ZA_Input', 'parameter ZA_Input deep']) {
      const m = parseBdef(wrap(`action Broken ${clause}; update;`));
      assert.equal(m.unparsed.length, 1, clause);
      assert.equal(m.unparsed[0].raw, `action Broken ${clause};`);
      assert.deepEqual(m.entities[0].actions, []);
      assert.equal(m.entities[0].operations[0].kind, 'update');
    }
  });

  it('reads determinations and validations with event and field triggers', () => {
    const e = entity(`determination Fill on modify { create; update; field Amount, Unit; }
      determination Number on save { create; }
      validation Positive on save { create; update; delete; field Amount; }`);
    assert.deepEqual(e.determinations[0], {name: 'Fill', options: [], on: 'modify', triggers: [
      {kind: 'create'}, {kind: 'update'}, {kind: 'field', fields: ['Amount', 'Unit']},
    ]});
    assert.equal(e.determinations[1].on, 'save');
    assert.deepEqual(e.validations[0].triggers, [
      {kind: 'create'}, {kind: 'update'}, {kind: 'delete'}, {kind: 'field', fields: ['Amount']},
    ]);
  });

  it('reads determine actions including qualified trigger references', () => {
    const e = entity(`determine action (authorization:update) Check { validation Positive; determination Fill; }
      draft determine action Prepare extensible { validation Items~Positive; }
      draft determine action Empty;`);
    assert.deepEqual(e.determineActions[0].triggers, [{kind: 'validation', name: 'Positive', options: []}, {kind: 'determination', name: 'Fill', options: []}]);
    assert.equal(e.determineActions[0].options[0].value, 'update');
    assert.equal(e.determineActions[1].extensible, true);
    assert.deepEqual(e.determineActions[1].modifiers, ['draft']);
    assert.equal(e.determineActions[1].triggers[0].name, 'Items~Positive');
    assert.deepEqual(e.determineActions[2].triggers, []);
  });

  it('reads the ( always ) option of a determine action member (R6)', () => {
    const e = entity(`determine action Check { determination ( always ) Fill; validation Positive; }`);
    assert.deepEqual(e.determineActions[0].triggers, [
      {kind: 'determination', name: 'Fill', options: [{name: 'always', value: null}]},
      {kind: 'validation', name: 'Positive', options: []},
    ]);
  });

  it('retains side effects as a located raw block with nested delimiters', () => {
    const e = entity(`\nside effects { field Amount affects field Total; /* } */ nested { x; } }\nupdate;`);
    assert.equal(e.sideEffects[0].line, 2);
    assert.match(e.sideEffects[0].raw, /nested \{ x; \}/);
    assert.equal(e.operations[0].kind, 'update');
  });

  it('reads explicit/corresponding mappings and unmanaged control types', () => {
    const e = entity(`mapping for znote corresponding { Title = title_text; Key = note_id; }
      mapping for zitem corresponding;
      mapping for zcontrol control zs_flags { Enabled = enabled; }`);
    assert.deepEqual(e.mappings[0], {table: 'znote', corresponding: true, extensible: false,
      fields: [{field: 'Title', column: 'title_text'}, {field: 'Key', column: 'note_id'}]});
    assert.deepEqual(e.mappings[1].fields, []);
    assert.equal(e.mappings[2].control, 'zs_flags');
  });

  it('preserves draft collaboration and known raw authorization/extensibility blocks', () => {
    const m = parseBdef(`managed; with collaborative draft; with privileged mode disabling Safe;
      define authorization context Safe { 'TEST''VALUE'; }
      define own authorization context by privileged mode;
      extensible { with additional save; }
      define behavior for ZI_NOTE extensible { }`);
    assert.deepEqual(m.unparsed, []);
    assert.equal(m.collaborativeDraft, true);
    assert.equal(m.authorizationContexts.length, 2);
    assert.match(m.authorizationContexts[0].raw, /TEST''VALUE/);
    assert.equal(m.options[0].disabling, 'Safe');
    assert.match(m.options[1].block.raw, /additional save/);
  });

  it('records unknown members/blocks with exact lines and resumes after them', () => {
    const m = parseBdef(`managed;\ndefine behavior for ZI_NOTE {\n future (foo) { inner { x; } }\n update;\n surprise value;\n delete;\n}`);
    assert.deepEqual(m.unparsed.map(x => [x.line, x.endLine, x.raw]), [
      [3, 3, 'future (foo) { inner { x; } }'], [5, 5, 'surprise value;'],
    ]);
    assert.deepEqual(m.entities[0].operations.map(x => x.kind), ['update', 'delete']);
  });

  it('records unknown header clauses and top-level definitions', () => {
    const m = parseBdef(`managed;\nfuture mode;\ndefine strange object { x; }\ndefine behavior for ZI_NOTE\n unknown property\n persistent table znote\n { create; }`);
    assert.deepEqual(m.unparsed.map(x => x.line), [2, 3, 5]);
    assert.equal(m.entities[0].persistentTable, 'znote');
    assert.equal(m.entities[0].operations[0].kind, 'create');
  });

  it('recovers unknown constructs inside associations, triggers and mappings', () => {
    const m = parseBdef(wrap(`association _Items { future thing; with draft; }
      determination Fill on modify { nonsense; create; }
      mapping for znote { invalid; Key = note_id; }`));
    assert.equal(m.unparsed.length, 3);
    assert.equal(m.entities[0].associations[0].withDraft, true);
    assert.deepEqual(m.entities[0].determinations[0].triggers, [{kind: 'create'}]);
    assert.deepEqual(m.entities[0].mappings[0].fields, [{field: 'Key', column: 'note_id'}]);
  });

  it('keeps unsupported trailing syntax visible', () => {
    const m = parseBdef(wrap('action A result [1] $self mystery; update;'));
    assert.equal(m.unparsed.length, 1);
    assert.match(m.unparsed[0].raw, /mystery/);
    assert.equal(m.entities[0].actions.length, 0);
    assert.equal(m.entities[0].operations[0].kind, 'update');
  });

  it('tokenizes comments, CRLF, escaped strings, namespaces and adjacency', () => {
    const ts = tokenize("// skip\r\nmanaged;/* multi\n line */ /ACME/I_Note 'a''//b' [0..*] // eof");
    assert.deepEqual(ts.map(x => x.value), ['managed', ';', '/ACME/I_Note', "'a''//b'", '[', '0', '..', '*', ']']);
    assert.equal(ts[0].line, 2);
    assert.equal(ts[0].column, 1);
    assert.equal(ts[2].line, 3);
    assert.equal(ts[2].token.getStr(), '/ACME/I_Note');
    assert.equal(ts[2].token.getStart().getRow(), 3);
    assert.equal(parseBdef('/* hi */ MaNaGeD; // eof').implementationType, 'managed');
    assert.equal(parseBdef('managed/*adjacent*/;strict//comment\n(2);').strict, 2);
  });

  it('fails explicitly for unterminated lexical and structural input', () => {
    assert.throws(() => tokenize("'broken"), /Unterminated string at line 1/);
    assert.throws(() => tokenize('/* broken'), /Unterminated comment at line 1/);
    assert.throws(() => parseBdef('managed; define behavior for ZI_NOTE { update;'), /Cannot recover|Expected|line/);
  });

  it('runs file/corpus CLI modes, counts recursively, and rejects invalid usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rap-parser-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'one.bdef.asbdef'), wrap('action Go; determine action Check; function Read result [1] $self;'));
      writeFileSync(join(dir, 'nested', 'two.bdef.asbdef'), wrap('future thing;'));
      writeFileSync(join(dir, 'ignored.txt'), 'not BDEF');
      const expected = {files: 2, entities: 2, actions: 2, unparsed: 1};
      assert.deepEqual(corpusCounts(dir), expected);
      const cli = (...args) => spawnSync(process.execPath, [resolve('tools/rap/bdef-parse.mjs'), ...args], {encoding: 'utf8'});
      const result = cli('--corpus', dir, '--json');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
      assert.match(cli('--corpus', dir).stdout, /files: 2, entities: 2, actions: 2, unparsed: 1/);
      const file = cli(join(dir, 'one.bdef.asbdef'), '--json');
      assert.equal(file.status, 0, file.stderr);
      assert.equal(JSON.parse(file.stdout).entities[0].actions[0].name, 'Go');
      assert.equal(cli().status, 1);
      assert.match(cli('--bad').stderr, /Usage:/);
      writeFileSync(join(dir, 'broken.bdef.asbdef'), '/* broken');
      assert.equal(cli('--corpus', dir).status, 1);
      assert.equal(cli(join(dir, 'missing.bdef.asbdef')).status, 1);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
});
