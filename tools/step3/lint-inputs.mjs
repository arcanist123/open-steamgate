#!/usr/bin/env node
// Build/test oracle only: export exact Node store/layer/config facts and rules.
import {resolve} from "node:path";
import {lintBuildSpec} from "../gogen/lint-engine.mjs";
console.log(JSON.stringify(await lintBuildSpec(resolve(process.argv[2] ?? "."))));
