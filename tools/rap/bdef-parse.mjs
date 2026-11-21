#!/usr/bin/env node
import {readFileSync, readdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tokenize} from './tokenize.mjs';

class Parser {
  constructor(source) {
    this.source = source;
    this.tokens = tokenize(source);
    this.i = 0;
    this.model = {schemaVersion: 1, implementationType: null, implementationClass: null,
      strict: null, withDraft: false, options: [], authorizationContexts: [], entities: [], unparsed: []};
  }
  at(word) { return this.tokens[this.i]?.lower === word; }
  take(word) { if (this.at(word)) { return this.tokens[this.i++].value; } return null; }
  need(word) {
    if (!this.tokens[this.i]) throw new SyntaxError(`Expected ${word} at end of input`);
    if (!this.take(word)) throw new Error(`Expected ${word}`);
  }
  name() {
    const t = this.tokens[this.i];
    if (!t || !/^[A-Za-z_$%/][A-Za-z0-9_$%/]*$/.test(t.value)) throw new Error('Expected name');
    this.i++; return t.value;
  }
  span(start, end = this.i) {
    const a = this.tokens[start], b = this.tokens[end - 1] ?? a;
    return {line: a.line, endLine: b.line, raw: this.source.slice(a.start, b.end)};
  }
  // Recover one syntactic unit, respecting nested delimiters. Entity header
  // clauses have no semicolons; there recovery also stops at a new source line.
  recover(start, context, error, header = false) {
    this.i = start;
    const stack = [];
    const closing = {'(': ')', '[': ']', '{': '}'};
    while (this.i < this.tokens.length) {
      const t = this.tokens[this.i];
      if (!stack.length && (t.lower === '}' || (t.lower === 'define' && this.i > start) || (header && (t.lower === '{' || (this.i > start && t.line > this.tokens[this.i - 1].line))))) break;
      this.i++;
      if (closing[t.value]) stack.push(closing[t.value]);
      else if (t.value === stack.at(-1)) { stack.pop(); if (!stack.length && t.value === '}') { this.take(';'); break; } }
      if (!stack.length && t.value === ';') break;
    }
    if (stack.length) throw new SyntaxError(`Unterminated construct at line ${this.tokens[start].line}`);
    if (this.i === start && !this.at('}') && !this.at('define') && !this.at('{')) this.i++;
    if (this.i === start) throw new SyntaxError(`Cannot recover ${context} at line ${this.tokens[start].line}`);
    this.model.unparsed.push({...this.span(start), context, reason: error.message});
  }
  attempt(context, fn, header = false) {
    const start = this.i;
    try { fn(); } catch (error) {
      if (error instanceof SyntaxError) throw error;
      this.recover(start, context, error, header);
    }
  }
  list(end = ';') {
    const names = [this.name()];
    while (this.take(',')) names.push(this.name());
    if (!this.at(end)) throw new Error(`Expected ${end}`);
    return names;
  }
  options() {
    if (!this.take('(')) return [];
    const values = [];
    do {
      const name = this.name().toLowerCase();
      values.push({name, value: this.take(':') ? this.name().toLowerCase() : null});
    } while (this.take(','));
    this.need(')'); return values;
  }
  rawBlock() {
    const start = this.i;
    this.need('{');
    let depth = 1;
    while (this.i < this.tokens.length && depth) {
      if (this.take('{')) depth++;
      else if (this.take('}')) depth--;
      else this.i++;
    }
    if (depth) throw new SyntaxError(`Unterminated block at line ${this.tokens[start].line}`);
    return this.span(start);
  }
  implementation(target) {
    this.need('implementation'); this.need('in'); this.need('class');
    target.implementationClass = this.name(); target.unique = !!this.take('unique');
  }
  mode(target, key) {
    if (this.take('master')) {
      target[key] = {kind: 'master', options: this.options()};
      if (key === 'etag') target[key].field = this.name();
    } else {
      this.need('dependent'); target[key] = {kind: 'dependent', association: this.take('by') ? this.name() : null};
    }
  }
  withOption(target, use = false) {
    this.need(use ? 'use' : 'with');
    const collaborative = !!this.take('collaborative');
    if (this.take('draft')) { target.withDraft = true; target.collaborativeDraft = collaborative; }
    else if (this.take('side')) { this.need('effects'); target.options.push({kind: 'side effects', use}); }
    else if (this.take('privileged')) {
      this.need('mode'); target.options.push({kind: 'privileged mode', disabling: this.take('disabling') ? this.name() : null});
    } else {
      const kind = this.take('additional') ?? this.take('unmanaged');
      if (!kind) throw new Error('Unknown with clause');
      this.need('save');
      // R7: with additional|unmanaged save [with full data] [and cleanup]
      const option = {kind: `${kind.toLowerCase()} save`};
      if (this.at('with') && this.tokens[this.i + 1]?.lower === 'full') { this.i += 2; this.need('data'); option.fullData = true; }
      if (this.at('and') && this.tokens[this.i + 1]?.lower === 'cleanup') { this.i += 2; option.cleanup = true; }
      target.options.push(option);
    }
  }
  parse() {
    while (this.i < this.tokens.length) {
      this.attempt('definition', () => {
        if (this.take(';')) return;
        if (this.at('define') && ['behavior', 'abstract', 'root'].includes(this.tokens[this.i + 1]?.lower)) { this.entity(); return; }
        if (this.at('define')) {
          const start = this.i;
          this.need('define'); this.take('own'); this.need('authorization'); this.need('context');
          if (this.take('by')) { this.need('privileged'); this.need('mode'); this.need(';'); }
          else { this.name(); this.rawBlock(); this.take(';'); }
          this.model.authorizationContexts.push(this.span(start)); return;
        }
        const type = ['managed', 'unmanaged', 'projection', 'abstract', 'interface'].find(x => this.at(x));
        if (type) {
          this.i++; this.model.implementationType = type;
          if (this.at('implementation')) this.implementation(this.model);
          this.need(';'); return;
        }
        if (this.take('strict')) {
          this.model.strict = true;
          if (this.take('(')) { const t = this.tokens[this.i++]; if (!t || !/^\d+$/.test(t.value)) throw new Error('Expected strict level'); this.model.strict = Number(t.value); this.need(')'); }
          this.need(';'); return;
        }
        if (this.at('with') || this.at('use')) { this.withOption(this.model, this.at('use')); this.need(';'); return; }
        if (this.take('extensible')) {
          const option = {kind: 'extensible'};
          if (this.at('{')) option.block = this.rawBlock(); else this.need(';');
          this.model.options.push(option); return;
        }
        throw new Error('Unknown definition construct');
      });
    }
    return this.model;
  }
  entity() {
    const start = this.i;
    this.need('define'); const abstract = !!this.take('abstract'); const root = !!this.take('root');
    this.need('behavior'); this.need('for');
    const e = {entity: this.name(), alias: null, line: this.tokens[start].line,
      implementationClass: null, options: [], fields: [], operations: [], associations: [],
      actions: [], functions: [], determinations: [], validations: [], determineActions: [], sideEffects: [], mappings: []};
    if (abstract) { e.implementationType = 'abstract'; this.model.implementationType ??= 'abstract'; }
    if (root) e.root = true;
    if (this.take('alias')) e.alias = this.name();
    this.model.entities.push(e);
    while (this.i < this.tokens.length && !this.at('{') && !this.at('define')) {
      this.attempt(`header:${e.entity}`, () => this.header(e), true);
    }
    this.need('{');
    while (this.i < this.tokens.length && !this.at('}') && !this.at('define')) {
      this.attempt(`entity:${e.entity}`, () => this.statement(e));
    }
    this.need('}'); this.take(';');
  }
  header(e) {
    if (this.at('implementation')) { this.implementation(e); return; }
    if (this.take('persistent')) { this.need('table'); e.persistentTable = this.name(); return; }
    if (this.take('draft')) { this.need('table'); e.draftTable = this.name(); if (this.take('query')) e.draftQuery = this.name(); return; }
    if (this.take('lock')) { this.mode(e, 'lock'); return; }
    if (this.take('authorization')) { this.mode(e, 'authorization'); return; }
    if (this.take('etag')) { this.mode(e, 'etag'); return; }
    if (this.take('total')) { this.need('etag'); e.totalEtag = this.name(); return; }
    const numbering = this.take('early') ?? this.take('late');
    if (numbering) { this.need('numbering'); e.numbering = numbering.toLowerCase(); return; }
    if (this.at('with')) { this.withOption(e); return; }
    if (this.take('use')) { this.need('etag'); e.useEtag = true; return; }
    if (this.take('using')) { e.using = this.name(); return; }
    if (this.take('extensible')) { e.options.push({kind: 'extensible'}); return; }
    // R11: a pragma (`##DRAFT_OP_NOT_REQUIRED` on the carrier singleton)
    // silences a message of the system's syntax check; it is kept, it
    // changes nothing at runtime
    // (the tokenizer gives `#`, `#` and the name, adjacent on one line)
    const [h1, h2, word] = this.tokens.slice(this.i, this.i + 3);
    if (h1?.value === '#' && h2?.value === '#' && word && h2.end === h1.end + 1 && word.start === h2.end && /^\w+$/.test(word.value)) {
      (e.pragmas ??= []).push(`##${word.value.toUpperCase()}`); this.i += 3; return;
    }
    throw new Error('Unknown entity header clause');
  }
  cardinality() {
    if (!this.take('[')) return null;
    const part = () => { const t = this.tokens[this.i++]; if (!t || !/^(\d+|\*)$/.test(t.value)) throw new Error('Expected cardinality'); return t.value; };
    let value = part(); if (this.take('..')) value += `..${part()}`;
    this.need(']'); return value;
  }
  statement(e) {
    if (this.take(';')) return;
    const start = this.i;
    const use = !!this.take('use');
    if (this.take('field')) {
      const attributes = this.options(); if (!attributes.length) throw new Error('Expected field attributes');
      const fields = this.list(); this.need(';'); e.fields.push({attributes, fields, line: this.tokens[start].line}); return;
    }
    const operation = ['create', 'update', 'delete'].find(x => this.at(x));
    if (operation) { this.i++; const options = this.options(); this.need(';'); e.operations.push({kind: operation, use, options}); return; }
    if (this.take('association')) {
      const a = {name: this.name(), use, operations: [], withDraft: false};
      if (this.take('abbreviation')) a.abbreviation = this.name();
      if (!this.take(';')) {
        this.need('{');
        while (this.i < this.tokens.length && !this.at('}')) {
          this.attempt(`association:${a.name}`, () => {
            if (this.take('create')) { const options = this.options(); this.need(';'); a.operations.push({kind: 'create', options}); }
            else if (this.at('link') || this.at('unlink')) {
              const kind = this.tokens[this.i++].lower; this.need('action'); const name = this.name(); this.need(';'); a.operations.push({kind, action: name});
            } else { this.need('with'); this.need('draft'); this.need(';'); a.withDraft = true; }
          });
        }
        this.need('}'); this.take(';');
      }
      e.associations.push(a); return;
    }
    const modifiers = [];
    while (['static', 'factory', 'internal', 'draft'].some(x => this.at(x))) modifiers.push(this.tokens[this.i++].lower);
    const determine = !!this.take('determine');
    const kind = this.take('action') ?? this.take('function');
    if (kind) {
      const a = {name: null, use, modifiers, options: this.options(), line: this.tokens[start].line};
      a.name = this.name();
      a.cardinality = this.cardinality();
      if (this.at('parameter') || (this.at('deep') && this.tokens[this.i + 1]?.lower !== 'result')) {
        const deep = !!this.take('deep');
        const table = deep && !!this.take('table');
        this.need('parameter');
        a.parameter = {name: this.name(), deep, table};
      }
      const deepResult = !!this.take('deep');
      if (this.take('result')) {
        const options = this.options(); const cardinality = this.cardinality();
        a.result = {options, cardinality, deep: deepResult, type: this.name()};
      } else if (deepResult) throw new Error('Expected result after deep');
      if (this.take('optimized')) a.optimized = true;
      if (this.take('with')) { this.need('additional'); this.need('implementation'); a.additionalImplementation = true; }
      if (this.take('extensible')) a.extensible = true;
      if (determine) {
        a.triggers = this.at('{') ? this.triggers(true) : [];
      } else if (this.at('{')) {
        this.need('{'); this.need('default'); this.need('function'); a.defaultFunction = this.name(); this.need(';'); this.need('}');
      }
      if (!this.take(';') && this.tokens[this.i - 1]?.value !== '}') throw new Error('Expected action terminator');
      (determine ? e.determineActions : kind.toLowerCase() === 'action' ? e.actions : e.functions).push(a); return;
    }
    if (modifiers.length || determine || use) throw new Error('Unknown modified member');
    const triggerKind = this.take('determination') ?? this.take('validation');
    if (triggerKind) {
      const a = {name: this.name(), options: this.options()};
      this.need('on'); a.on = (this.take('modify') ?? this.take('save'))?.toLowerCase();
      if (!a.on) throw new Error('Expected modify or save');
      a.triggers = this.triggers(); this.take(';');
      (triggerKind.toLowerCase() === 'determination' ? e.determinations : e.validations).push(a); return;
    }
    if (this.take('side')) { this.need('effects'); e.sideEffects.push(this.rawBlock()); this.take(';'); return; }
    if (this.take('mapping')) {
      this.need('for'); const m = {table: this.name(), corresponding: !!this.take('corresponding'), extensible: !!this.take('extensible'), fields: []};
      if (this.take('control')) m.control = this.name();
      if (!this.take(';')) {
        this.need('{');
        while (this.i < this.tokens.length && !this.at('}')) {
          this.attempt(`mapping:${m.table}`, () => { const field = this.name(); this.need('='); const column = this.name(); this.need(';'); m.fields.push({field, column}); });
        }
        this.need('}'); this.take(';');
      }
      e.mappings.push(m); return;
    }
    throw new Error('Unknown entity member');
  }
  qualifiedName() { let name = this.name(); if (this.take('~')) name += `~${this.name()}`; return name; }
  triggers(determine = false) {
    this.need('{'); const triggers = [];
    while (this.i < this.tokens.length && !this.at('}')) {
      this.attempt('trigger', () => {
        const kind = this.name().toLowerCase();
        if (determine) {
          if (!['validation', 'determination'].includes(kind)) throw new Error('Unknown determine trigger');
          // R6: determination ( always ) d; runs whatever its triggers say
          const options = this.options();
          const name = this.qualifiedName(); this.need(';'); triggers.push({kind, name, options});
        } else if (kind === 'field') { const fields = this.list(); this.need(';'); triggers.push({kind, fields}); }
        else if (['create', 'update', 'delete'].includes(kind)) { this.need(';'); triggers.push({kind}); }
        else throw new Error('Unknown trigger');
      });
    }
    this.need('}'); return triggers;
  }
}

export function parseBdef(source) { return new Parser(source).parse(); }
export function corpusCounts(directory) {
  const counts = {files: 0, entities: 0, actions: 0, unparsed: 0};
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.bdef.asbdef')) {
        const model = parseBdef(readFileSync(path, 'utf8'));
        counts.files++; counts.entities += model.entities.length; counts.unparsed += model.unparsed.length;
        counts.actions += model.entities.reduce((n, e) => n + e.actions.length + e.determineActions.length, 0);
      }
    }
  };
  walk(directory); return counts;
}
export function main(args = process.argv.slice(2)) {
  const json = args.includes('--json');
  args = args.filter(x => x !== '--json');
  if (args.length === 2 && args[0] === '--corpus') {
    const counts = corpusCounts(args[1]);
    console.log(json ? JSON.stringify(counts, null, 2) : Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  } else if (args.length === 1 && !args[0].startsWith('-')) {
    console.log(JSON.stringify(parseBdef(readFileSync(args[0], 'utf8')), null, json ? 2 : 0));
  } else throw new Error('Usage: node tools/rap/bdef-parse.mjs <file.bdef.asbdef> [--json] | --corpus <dir> [--json]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
