import {expect} from "chai";
import {readFileSync} from "node:fs";
import {startServer} from "./start.mjs";
import {givenText, fill} from "../tools/osd-destination.mjs";

// The editor screen (backlog G.8, /sap/bc/osd/edit/): pick an object, change
// its source, check it, activate it -- in a browser, with no JavaScript.
//
// The seam under it has its own suite (`test/store-destination.mjs`). What
// is asserted here is what only a running screen can say, and the first of
// them is the defect that made the screen useless on its first run: a form
// posted to it arrived with **no form fields**, because the shim fills them
// from the query string alone, so every button silently answered the object
// list as though nobody had typed anything (ANORMALIES
// `posted-form-has-no-fields`). Nothing in the destination's tests could
// have caught that -- it happens before ABAP is reached.
const PORT = process.env.STG_PORT ?? 3030;
const BASE = `http://localhost:${PORT}/sap/bc/osd/edit/`;
const OBJECT = "ZCL_OSD_ST05";
const FILE = "src/webgui/zcl_osd_st05.clas.abap";

// HTML entities back to text, numeric ones included: the escaper on the
// screen writes `&#39;` for an apostrophe, and ABAP source is full of them.
// `&amp;` is undone LAST, or an entity that was in the source to begin with
// -- this screen's own code writes HTML -- gets unescaped twice, and the
// comparison fails on a difference the page does not have. Both were red
// once, in that order.
const unescape = (html) => html
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
  .replaceAll("&amp;", "&");

const post = (body) => fetch(BASE, {
  method: "POST",
  headers: {"content-type": "application/x-www-form-urlencoded"},
  body: new URLSearchParams(body).toString(),
});

describe("the editor", function () {
  this.timeout(180000);
  let server;
  before(() => {
    server = startServer(true);
  });
  after(() => server?.close());

  it("lists the objects of the tree, with the file each one lives in", async () => {
    const page = await (await fetch(`${BASE}?q=OSD_ST05`)).text();
    expect(page, "the screen").to.contain("Editor");
    expect(page, "the object").to.contain(OBJECT);
    expect(page, "and where it is, which is the answer to 'where does an edit land'")
      .to.contain(FILE);
    expect(page, "a count of what matched").to.match(/\d+ shown of \d+ objects/);
  });

  it("opens one object, shown before it is changed", async () => {
    // display first, change on a click -- the pair the original had
    const page = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}`)).text();
    expect(page, "the source, rendered").to.contain("CLASS");
    expect(page, "and the file it came from").to.contain(FILE);
    expect(page, "a way into the text area").to.contain("change=x");
    const box = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}&change=x`)).text();
    expect(box, "the text area").to.contain('<textarea name="src"');
    expect(box, "holding the source as it is on disk").to.contain("CLASS zcl_osd_st05 DEFINITION");
  });

  it("checks the source it was POSTED, which is the form-body gap this screen found", async () => {
    // the whole round trip: a body of 20-odd kilobytes reaches the screen,
    // the screen reaches the store, the store parses the system and answers
    const source = readFileSync(FILE, "utf8");
    const page = await (await post({type: "CLAS", name: OBJECT, do: "check", src: source})).text();
    expect(page, "the screen did not fall back to its object list, which is what an empty name does")
      .to.not.match(/\d+ shown of \d+ objects/);
    expect(page, "it holds").to.contain("the system still compiles");
  });

  it("names the line of a source that does not compile, and writes nothing", async () => {
    const before = readFileSync(FILE, "utf8");
    const broken = before.replace("METHOD esc.", "METHOD esc. DATA lv_x TYPE i. lv_x = no_such_method( ).");
    const page = await (await post({type: "CLAS", name: OBJECT, do: "check", src: broken})).text();
    expect(page, "the verdict").to.contain("issue(s)");
    expect(page, "the message, as the parser wrote it").to.contain("no_such_method");
    expect(page, "and the object it belongs to, because an activation is refused by a caller as often as by the object")
      .to.contain(OBJECT);
    expect(readFileSync(FILE, "utf8"), "a check does not write").to.equal(before);
  });

  it("keeps what the person typed after a save, rather than reading the file back", async () => {
    // a round trip that silently replaced the text would hide a write that
    // did not happen. The source here is the file's own, so the save is a
    // no-op on disk and the assertion is about the box.
    const source = readFileSync(FILE, "utf8");
    // the form carries change=x, so a save comes back in the text area with
    // what the person typed -- posting without it would test a form nobody
    // submits
    const page = await (await post({type: "CLAS", name: OBJECT, do: "save", change: "x", src: source})).text();
    expect(page, "saved").to.contain("Saved.");
    expect(page, "and the box still holds it").to.contain("CLASS zcl_osd_st05 DEFINITION");
    expect(readFileSync(FILE, "utf8"), "and the file is what it was").to.equal(source);
  });

  it("shows the source coloured by the keyword list, and the text is the text", async () => {
    // Display and change, the pair the original had. The colouring is done
    // in ABAP, by ZCL_OSD_ABAP_TOKENS: a character scanner over abapGit's
    // keyword list, so a keyword is a word in that list, wherever it stands.
    // It used to be the host's parser (STORE TOKENS), grammar-exact and
    // present only where the host had one; giving that up for the same
    // colours on every host was decided on purpose (host-tools review
    // 2026-09-25, S1).
    const page = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}`)).text();
    const pre = /<pre class="src">([\s\S]*?)<\/pre>/.exec(page)?.[1] ?? "";
    expect(pre, "the display is rendered").to.not.equal("");
    expect(pre, "a word in the keyword list").to.contain('<span class="tkeyword">CLASS</span>');
    expect(pre, "and a name that is not one").to.contain('<span class="tname">zcl_osd_st05</span>');
    expect(pre, "comments are comments").to.match(/class="tcomment"/);

    // **the text is the text**: strip the markup and the line numbers and
    // what is left must be the file, character for character. A display that
    // loses a character is worse than one that colours nothing
    // `&amp;` LAST: this screen's own source contains HTML entities, so
    // unescaping the ampersand first turns `&amp;quot;` into `"` and the
    // comparison fails on a difference the page does not have. The test was
    // red for exactly that before the order was fixed
    const text = unescape(pre.replace(/<span class="ln">\d+<\/span>/g, "").replace(/<[^>]+>/g, ""));
    const trim = (t) => t.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l, i, a) => i < a.length - 1 || l !== "");
    expect(trim(text)).to.deep.equal(trim(readFileSync(FILE, "utf8")));
  });

  it("and Change gives a plain text area, because a caret cannot be styled", async () => {
    const page = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}&change=x`)).text();
    expect(page).to.contain('<textarea name="src"');
    expect(page, "and the display is not shown twice").to.not.contain('<pre class="src">');
  });

  it("draws the buttons the host says it can do, and on Node that is all three", async () => {
    // Hosts advertise Check and Activate independently.
    const page = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}&change=x`)).text();
    const has = (v) => page.includes(`value="${v}">`);
    expect(has("save"), "Save is every host's").to.equal(true);
    if (globalThis.abap?.context?.RFCDestinations?.STORE !== undefined) {
      expect(page).to.contain('value="check">Check</button>');
      expect(page).to.contain('value="save">Save</button>');
      expect(page).to.contain('value="activate">Activate</button>');
    }
  });

  it("shows native Check without advertising Activate", async function () {
    const destinations = globalThis.abap?.context?.RFCDestinations;
    if (destinations?.STORE === undefined) this.skip();
    const real = destinations.STORE;
    destinations.STORE = {
      call: async (name, signature) => {
        if (givenText(signature, "IV_COMMAND") === "CAPABILITIES") {
          fill(signature, {EV_NOTE: "LIST READ WRITE CHECK"});
          return;
        }
        return real.call(name, signature);
      },
    };
    try {
      const page = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}&change=x`)).text();
      expect(page).to.contain('value="check">Check</button>');
      expect(page).to.not.contain('value="activate">');
      expect(page).to.contain("Activation requires rebuilding");
      expect(page).to.not.contain("not check or activate");
    } finally {
      destinations.STORE = real;
    }
  });

  it("a host with no store to call says so instead of dumping", async function () {
    // On a system there is no STORE destination: the call comes back as
    // COMMUNICATION_FAILURE, and the screen used to have no EXCEPTIONS for
    // it, which is a short dump there. Simulated here with a destination
    // that answers the way a missing one does on a system; only an inline
    // server has its runtime in this process to swap it in.
    const destinations = globalThis.abap?.context?.RFCDestinations;
    if (destinations?.STORE === undefined) this.skip();
    const real = destinations.STORE;
    // a classic exception, the way the runtime raises one: the transpiled
    // CALL FUNCTION maps its name to the EXCEPTIONS clause's sy-subrc
    destinations.STORE = {
      call: async () => {
        throw new globalThis.abap.ClassicError({classic: "COMMUNICATION_FAILURE"});
      },
    };
    try {
      const list = await fetch(`${BASE}?q=OSD_ST05`);
      expect(list.status, "an answer, not a dump").to.equal(200);
      const text = await list.text();
      expect(text).to.contain("The STORE destination did not answer");
      expect(text, "and no list pretending the system is empty").to.not.match(/\d+ shown of \d+ objects/);
      const box = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}&change=x`)).text();
      expect(box, "and no button that would only fail again").to.not.contain("<button type=\"submit\" name=\"do\"");
    } finally {
      destinations.STORE = real;
    }
  });

  it("ships no JavaScript, like the rest of these screens", async () => {
    const page = await (await fetch(`${BASE}?type=CLAS&name=${OBJECT}`)).text();
    expect(page.toLowerCase(), "a screen that is a form and a link needs none")
      .to.not.contain("<script");
    expect(page.toLowerCase(), "nor an inline handler").to.not.match(/\son\w+=/);
  });
});
