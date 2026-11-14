// The registry's update after a cold publication: sized like the prime it can
// at most be, and its timeout drops the compiler to be primed again instead
// of turning warm off for good. Before this, CI's adt-lifecycle hung until
// "Warm compiler did not become ready" on every runner where the update after
// the interface create (209 objects, 13-29 s measured on green runs) crossed
// 30 s x speed factor: warm was off, the status said "cold" forever, and the
// log said "re-prime" for a prime that never came (2026-11-14, 7 of 24 runs).
import {expect} from "chai";
import {OPERATION_MS, PRIME_MS_PER_FILE, REFERENCE_CALIBRATION_MS, warmDeadline} from "../tools/warm-deadline/warm-deadline.mjs";
import {warmOperation} from "../tools/osd-store-warm.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";

const at = ms => () => ms;
// the slowest update after the interface create on a green adt-lifecycle run
// (2026-11-14); the red runs cut it at 30.6-35.6 s
const SLOWEST_GREEN_UPDATE_MS = 29444;

function fakeStore(deadlineMs) {
  let drops = 0;
  const w = {on: true, compiler: {primed: true, unverified: new Set(), drop: async () => { drops++; w.compiler.primed = false; }}};
  return {store: {warmDeadlineMs: deadlineMs, warm: () => w}, w, drops: () => drops};
}
const hang = () => new Promise(() => {});

describe("warm update after a cold publication", () => {
  it("gets a deadline sized like the prime, not like one save", () => {
    const files = 6865;
    const update = warmDeadline({kind: "update", files, env: {}, measure: at(REFERENCE_CALIBRATION_MS)});
    expect(update.ms).to.equal(files * PRIME_MS_PER_FILE);
    expect(update.ms).to.be.greaterThan(3 * SLOWEST_GREEN_UPDATE_MS);
    // the bound it had: under 1.02x the slowest green update already
    const save = warmDeadline({kind: "operation", env: {}, measure: at(REFERENCE_CALIBRATION_MS * 1.14)});
    expect(save.ms).to.equal(Math.round(OPERATION_MS * 1.14));
    expect(update.ms).to.be.greaterThan(save.ms);
  });

  it("on a timeout drops the compiler and leaves warm on to re-prime", async () => {
    const {store, w, drops} = fakeStore(20);
    const error = await warmOperation(store, hang, {kind: "update", files: 10}).then(() => undefined, e => e);
    expect(error?.code).to.equal("WARM_UNAVAILABLE");
    expect(w.disabled, "an update timeout must not turn warm off").to.not.equal(true);
    expect(drops()).to.be.at.least(1);
    expect(w.reason).to.include("warm compiler exceeded");
    const status = ObjectStore.prototype.warmStatus.call({warm: () => w});
    expect(status).to.include({state: "cold", disabled: false});
  });

  it("still turns warm off when a save or the prime misses its deadline", async () => {
    for (const kind of ["operation", "prime"]) {
      const {store, w} = fakeStore(20);
      const error = await warmOperation(store, hang, {kind, files: 10}).then(() => undefined, e => e);
      expect(error?.code).to.equal("WARM_UNAVAILABLE");
      expect(w.disabled, kind).to.equal(true);
      // and says so, so a client waiting for "primed" stops instead of timing out
      const status = ObjectStore.prototype.warmStatus.call({warm: () => w});
      expect(status).to.include({state: "cold", disabled: true});
      expect(status.reason).to.include("warm compiler exceeded");
    }
  });
});
