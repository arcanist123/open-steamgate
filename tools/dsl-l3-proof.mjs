// A set proof is a projection of the compiled L2 examples, never a second fixture.
import {evaluate, pieces} from './dsl-l2.mjs';
import {continuationNodes, literalNodes} from './dsl-l2-assignments.mjs';
import {enrichTrace} from './dsl-trace.mjs';
const STRG = {built_in: 'STRG'};
const plain = row => Object.fromEntries(row.fields.map(f => [f.column, f.value]));
const texts = values => [...new Set(values)].sort();

export function compileProof(spec, model, all, {line, fail}) {
  const at = line('proof');
  if (spec !== 'generated' && (!spec || typeof spec !== 'object' || Array.isArray(spec)
    || Object.keys(spec).join() !== 'class' || typeof spec.class !== 'string')) {
    fail(at, 'proof is generated or {class: zcl_..._proof}');
  }
  const name = (spec === 'generated' ? `zcl_l3_${model.set}_proof` : spec.class).toLowerCase();
  if (!/^z[a-z0-9_]{1,29}$/.test(name)) fail(at, 'proof.class is a Z name of at most 30 characters');
  const usedClasses = [model.class, model.ports_class, model.exception, model.settings?.class,
    ...model.ports.flatMap(p => p.variants.map(v => v.class)), ...all.map(r => r.compiled.class)];
  if (usedClasses.includes(name)) fail(at, `proof.class ${name} collides with another set object`);
  const root = {'@id': `${model['@id']}/proof`, set_line: at, class: name};
  const methods = new Set(['setup', 'teardown', 'clean', 'prove', 'assert_result']);
  const tableNames = new Set(model.sources.map(s => s.table));
  root.rules = all.filter(r => r.enabled).map(r => {
    const c = r.compiled;
    let method = c.rule.replace(/[^a-z0-9_]/g, '_').slice(0, 30);
    if (methods.has(method)) method = `${method.slice(0, 26)}_${model.rules.find(x => x.name === c.rule).index}`;
    methods.add(method);
    const node = {'@id': `${root['@id']}/rule/${c.rule}`, set_line: r.at,
      rule_file: r.recorded, rule_line: c.rule_line, method, name: c.rule,
      index: model.rules.find(x => x.name === c.rule).index, tables: c.tables,
      example_origins: c.examples.map(e => ({file: r.recorded, node: e['@id'], line: e.rule_line}))};
    const reasons = [];
    const missing = c.tables.filter(t => !tableNames.has(t.table));
    if (missing.length) reasons.push(`source ports do not read ${missing.map(t => t.table).join(', ')}`);
    if (model.sources.some(s => !s.variants.some(v => v.is_table))) reasons.push('a source has no generated table variant');
    if (['log', 'dummy', 'capture'].some(v => !model.sink.variants.some(x => x.generated && x.name === v))) {
      reasons.push('sink needs generated log, dummy and capture variants');
    }
    if (model.staged || model.governor || model.simulate || model.remote) reasons.push('stages or execution overlays cannot isolate these examples in mode S');
    if (c.examples.some(e => e.range_args?.length)) reasons.push('example ranges cannot be passed through the set runner');
    if (c.examples.some(e => e.param_args?.length)) reasons.push('example parameter overrides cannot be shared by one date run');
    if ((model.params ?? []).some(p => c.params?.some(q => p.name === q.name && p.default !== q.default))) {
      reasons.push('set parameter defaults differ from the rule defaults');
    }
    const dates = [...new Set(c.examples.map(e => e.date.value))];
    node.dates = dates.map(date => {
      const examples = c.examples.filter(e => e.date.value === date);
      const tables = c.tables.map(t => {
        const byKey = new Map();
        for (const e of examples) for (const row of e.tables.find(x => x.table === t.table)?.rows ?? []) {
          const values = plain(row), ddic = c.ddic[t.table];
          const key = JSON.stringify(ddic.keys.map(k => values[k] ?? ''));
          const old = byKey.get(key);
          if (old && JSON.stringify(Object.entries(plain(old)).sort()) !== JSON.stringify(Object.entries(values).sort())) {
            reasons.push(`conflicting example rows in ${t.table} on ${date}`);
          }
          byKey.set(key, {...row, set_line: r.at, rule_file: r.recorded});
        }
        return {...t, client: c.ddic[t.table].client, rows: [...byKey.values()]};
      });
      const expected = texts(examples.flatMap(e => e.expect.map(x => x.value)));
      const rows = Object.fromEntries(tables.map(t => [t.table, t.rows.map(plain)]));
      if (!reasons.length && JSON.stringify(texts(evaluate(c, rows, {date}))) !== JSON.stringify(expected)) {
        reasons.push(`combined examples change expected alerts on ${date}`);
      }
      return {'@id': `${node['@id']}/date/${date}`, set_line: r.at, date,
        'date@type': {built_in: 'DATS', length: 8}, examples, tables,
        expect: expected.map(value => {
          const e = examples.find(e => e.expect.some(x => x.value === value));
          return {...e.expect.find(x => x.value === value),
            rule_file: r.recorded, set_line: r.at};
        })};
    });
    if (reasons.length) {
      node.skip = `SKIP: ${[...new Set(reasons)].join('; ')}`;
      node['skip@type'] = STRG;
      delete node.dates;
    }
    return node;
  });
  return root;
}

export async function renderProof(model, {renderRecipe, sidecar, classXml}) {
  if (!model.proof) return {};
  const proof = model.proof;
  const root = continuationNodes(literalNodes({...proof, source: model.source, runner: model.class,
    sources: model.sources, rule_count: String(model.rules.length), set: model.set, 'set@type': {built_in: 'CHAR', length: 16},
    sink: model.sink, capture: model.sink.variants.find(v => v.is_capture)?.class,
    bindings: ['log', 'dummy', 'capture'].filter(v => model.sink.variants.some(x => x.generated && x.name === v)).map(variant => ({variant, log: variant === 'log', capture_variant: variant === 'capture',
      value: [...model.sources.map(s => `${s.name}=table`), `${model.sink.name}=${variant}`].join(','), 'value@type': STRG})),
  }, pieces));
  // Each reused L2 node retains its rule origin as well as the set entry.
  const annotate = (value, file, at) => {
    if (!value || typeof value !== 'object') return;
    file = value.rule_file ?? file; at = value.set_line ?? at;
    if (value['@id']) { value.set_line ??= at; if (value.rule_line) value.rule_file ??= file; }
    for (const v of Object.values(value)) annotate(v, file, at);
  };
  annotate(root, undefined, proof.set_line);
  const files = {};
  for (const [suffix, template] of [['abap', 'class'], ['testclasses.abap', 'testclasses']]) {
    const path = `recipes/l3-proof/${template}.tpl`;
    const result = await renderRecipe(root, path, {profile: 'abap'});
    const errors = result.findings.filter(f => f.severity === 'E');
    if (errors.length) throw new Error(`generated proof: ${JSON.stringify(errors)}`);
    const name = `${proof.class}.clas.${suffix}`;
    files[name] = result.text;
    const origins = enrichTrace(root, result.trace).map(e => {
      let current = root, nearest = root, setNode = root;
      for (const part of (e.path ?? '').split('/').filter(Boolean)) {
        current = Array.isArray(current) ? current[Number(part) - 1] : current?.[part];
        if (current?.['@id']) nearest = current;
        if (current?.example_origins) setNode = current;
      }
      return {...e, sources: [
        {file: model.source, node: setNode['@id'], selector: '/'},
        ...(nearest.rule_file ? [{file: nearest.rule_file, node: nearest['@id'], selector: '/'}] : []),
        ...(nearest.example_origins ?? []).map(o => ({file: o.file, node: o.node, selector: '/'})),
      ]};
    });
    const trace = JSON.parse(sidecar(root, path, {...result, trace: origins}));
    trace.examples = proof.rules.flatMap(r => r.example_origins);
    trace.skips = proof.rules.filter(r => r.skip).map(r => ({rule: r.name, reason: r.skip, set_line: r.set_line, rule_file: r.rule_file, rule_line: r.rule_line}));
    // Keep separate sidecars for the global class and ABAP Unit include.
    files[`${proof.class}.clas.${suffix === 'abap' ? '' : 'testclasses.'}trace.json`] = JSON.stringify(trace) + '\n';
  }
  files[`${proof.class}.clas.xml`] = classXml(model, proof.class, `Generated proof of ${model.set}`).replace('<CLSCCINCL>X</CLSCCINCL>', '<CLSCCINCL>X</CLSCCINCL><WITH_UNIT_TESTS>X</WITH_UNIT_TESTS>');
  return files;
}
