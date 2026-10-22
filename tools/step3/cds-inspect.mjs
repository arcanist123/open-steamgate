// The upstream Tree API intentionally has no CDS nodes. Install the narrow
// extraction adapter into the exact .73 library; never alter generated files.
import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {runsAs} from "../osd-main.mjs";
const symbol = id => "z_" + id.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 12)
  + "_" + createHash("sha256").update(id).digest("hex").slice(0, 14);
export function installCDSInspector(lib) {
  const api = readFileSync(join(lib, "library.go"), "utf8");
  const hir = readFileSync(join(lib, "hir.go"), "utf8");
  const expected = "b7ccb0d37f8c02edbb6620b3ea6965032b64630b05a3905955eb3ac201c27d87";
  if (createHash("sha256").update(api).digest("hex") !== expected) throw new Error("CDS adapter requires abapiti 0a11cd3c, core 9f7f098c, --go-package abaplint");
  const types = {
    ExpressionNode: "src/abap/nodes/expression_node.ts.ExpressionNode",
    DataDefinition: "src/objects/data_definition.ts.DataDefinition",
    Table: "src/objects/table.ts.Table", View: "src/objects/view.ts.View",
    StructureType: "src/abap/types/basic/structure_type.ts.StructureType",
    AbstractType: "src/abap/types/basic/_abstract_type.ts.AbstractType",
    File: "src/files/_ifile.ts.IFile", Component: "src/abap/types/basic/structure_type.ts.IStructureComponent",
  };
  const template = readFileSync(new URL("./cds-inspect.go.txt", import.meta.url), "utf8");
  const output = template.replace(/@(\w+)@/g, (_, marker) => {
    if (marker === "package") return "abaplint";
    const name = symbol(types[marker] ? "ref." + types[marker] : "member." + marker);
    if (!hir.includes(name)) throw new Error(`missing pinned symbol ${marker}`);
    return name;
  });
  writeFileSync(join(lib, "osg_inspect.go"), output);
}
if (runsAs("cds-inspect.mjs")) installCDSInspector(process.argv[2]);
