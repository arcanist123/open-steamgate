// Opt-in loader for the existing protocol suites. Codec imports stay original.
import {registerHooks} from "node:module";
const adapter = new URL("./native-test-adapter.mjs", import.meta.url).href;
registerHooks({resolve(specifier, context, next) {
  if (context.parentURL?.includes("/test/protocol-") && /\/protocols\/(rfc-server|diag-server|server)\.mjs$/.test(specifier)) {
    return {url: adapter, shortCircuit: true};
  }
  return next(specifier, context);
}});
