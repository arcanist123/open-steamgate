#!/usr/bin/env node
// Structural fallback: export exact Node store/layer/config facts, no checking.
import {resolve} from "node:path";
import {lintBuildSpec} from "../gogen/lint-engine.mjs";
console.log(JSON.stringify(await lintBuildSpec(resolve(process.argv[2] ?? "."))));
