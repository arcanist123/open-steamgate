"use strict";

const desktopLib = require("./lib.js");

function sqlNotebookSerializer(vscode, bytes, lib = desktopLib) {
  return {
    deserializeNotebook(content) {
      const text = new TextDecoder().decode(content);
      const cells = lib.notebookFromJson(text).map((cell) => new vscode.NotebookCellData(
        cell.kind === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
        cell.value,
        cell.language,
      ));
      return new vscode.NotebookData(cells);
    },
    serializeNotebook(data) {
      const cells = data.cells.map((cell) => ({
        kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
        language: cell.languageId,
        value: cell.value,
      }));
      return bytes(lib.notebookToJson(cells));
    },
  };
}

async function newSqlNotebook(vscode, notebookType, statement, lib = desktopLib) {
  const data = new vscode.NotebookData(lib.sqlNotebookStarter(statement).map((cell) => new vscode.NotebookCellData(
    cell.kind === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
    cell.value, cell.language)));
  const document = await vscode.workspace.openNotebookDocument(notebookType, data);
  await vscode.window.showNotebookDocument(document);
}

function sqlNotebookController(vscode, {output, client, isCellAvailable = () => true, lib = desktopLib}) {
  const controller = vscode.notebooks.createNotebookController("osd-sql-kernel", "osd-sql-notebook", "osd notebook");
  controller.supportedLanguages = ["sql", "abap", "sqlscript"];
  controller.supportsExecutionOrder = true;
  let executionOrder = 0;
  controller.executeHandler = (cells) => {
    for (const cell of cells) runNotebookCell(controller, cell, ++executionOrder);
  };
  return controller;

  async function runNotebookCell(controller, cell, executionOrder) {
    const execution = controller.createNotebookCellExecution(cell);
    execution.executionOrder = executionOrder;
    execution.start(Date.now());
    const language = cell.document.languageId;
    try {
      const available = language === "sql" ? true : await isCellAvailable(language);
      if (available !== true) {
        throw new Error(`${language} notebook cells are not available in the browser`);
      }
      const source = cell.document.getText();
      if (language === "abap") {
        const result = await client().notebookAbap(lib.notebookAbapSource(source));
        await execution.replaceOutput([new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(result.text ?? "", "text/plain"),
        ])]);
        execution.end(result.ok === true, Date.now());
      } else {
        let result;
        if (language === "sqlscript") {
          result = await client().amdpCell(source);
          if (result.error !== undefined) throw new Error(result.error);
        } else {
          const rowLimit = vscode.workspace.getConfiguration("osd").get("notebook.rowLimit", 100);
          result = await client().freestyle(source, rowLimit);
        }
        const html = `${result.engine ? `<p>${lib.htmlEscape(result.engine)}</p>` : ""}${lib.freestyleTableHtml(result.columns, result.rows, {ms: result.ms, generation: result.generation})}`;
        await execution.replaceOutput([
          new vscode.NotebookCellOutput(lib.freestyleOutputItems(html).map(({mime, value}) =>
            vscode.NotebookCellOutputItem.text(value, mime))),
        ]);
        execution.end(true, Date.now());
      }
    } catch (error) {
      const message = String(error.message ?? error);
      output.appendLine(`osd ${language}: ${message}`);
      await execution.replaceOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({name: "osd", message})]),
      ]);
      execution.end(false, Date.now());
    }
  }
}

module.exports = {newSqlNotebook, sqlNotebookController, sqlNotebookSerializer};
