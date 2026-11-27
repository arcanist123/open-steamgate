// Everything the page needs, in the page: her effects, her handler, and a
// WebSocket that reaches the handler instead of a network.
// "open-abap-apc" is an alias in webpack.config.cjs (OPEN_ABAP_APC, else the
// sibling checkout ../open-abap-apc)
import {install} from "open-abap-apc/web/apc-socket.mjs";

// installed synchronously, before the page's own script can call it, and
// told to wait for the boot rather than race it
const ready = (async () => {
  const {initializeABAP} = await import("../output/init.mjs");
  await initializeABAP();
  return globalThis.abap;
})();

install({handler: "ZCL_O4D_APC_HANDLER", ready});

ready.then(() => {
  console.log("vivid: the runtime is up, " + Object.keys(globalThis.abap.Classes).length + " classes");
}, (error) => {
  console.error("vivid: the runtime did not come up", error);
});
