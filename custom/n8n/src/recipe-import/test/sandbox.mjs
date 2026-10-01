// Runs Code node bodies the way the n8n 2.x JS task runner does (@n8n/task-runner js-task-runner.js):
// a fresh vm context that only has the runner's globals (no URL, URLSearchParams, fetch, AbortSignal, structuredClone,
// process), require refuses built-in modules (NODE_FUNCTION_ALLOW_BUILTIN is unset on audibox), and helpers are RPC
// calls whose arguments and results cross a JSON boundary, where only top-level Buffers are revived.
import vm from "node:vm";

const PRELUDE = [
  "globalThis.global = globalThis",
  "var module = { exports: {} }",
  "Object.getPrototypeOf = () => ({})",
  "Reflect.getPrototypeOf = () => ({})",
  "Object.setPrototypeOf = () => false",
  "Reflect.setPrototypeOf = () => false",
  "Object.defineProperty = () => ({})",
  "Object.defineProperties = () => ({})",
].join("; ");

const isSerializedBuffer = (v) => v !== null && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data);
const revive = (v) => (isSerializedBuffer(v) ? Buffer.from(v.data) : v);
const overJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One helper call over the runner websocket: params and the answer are JSON, an error arrives as its JSON form.
const rpc = (fn) => async (...args) => {
  let result;
  try { result = await fn(...overJson(args).map(revive)); } catch (e) {
    throw typeof e === "string" ? new Error(e) : overJson(e && typeof e.toJSON === "function" ? e : { message: e && e.message });
  }
  return revive(overJson(result));
};

function context(extra, helpers) {
  const require = (name) => { throw new Error(`Module '${name}' is disallowed`); };
  const rpcHelpers = Object.fromEntries(Object.entries(helpers || {}).map(([k, fn]) => [k, rpc(fn)]));
  return vm.createContext({ __isExecutionContext: true, require, console, Buffer, setTimeout, setInterval, setImmediate,
    clearTimeout, clearInterval, clearImmediate, btoa, atob, TextDecoder, TextDecoderStream, TextEncoder, TextEncoderStream,
    FormData, ...extra, helpers: rpcHelpers });
}

// Runs one Code node body; returns the items as n8n stores them (JSON).
export async function runInSandbox(code, { $input, $, helpers }) {
  const ctx = context({ $input, $ }, helpers);
  const wrapped = PRELUDE + "; module.exports = async function VmCodeWrapper() {" + code + "\n}()";
  return overJson(await vm.runInContext(wrapped, ctx, { timeout: 300000 }));
}

// Evaluates library sources in the sandbox and returns the named functions; their results come back as JSON.
export function libInSandbox(code, names) {
  const ctx = context({}, {});
  const lib = vm.runInContext(PRELUDE + "; (function () {" + code + "\nreturn { " + names.join(", ") + " }; })()", ctx);
  return Object.fromEntries(names.map((n) => [n, (...args) => {
    const out = lib[n](...overJson(args));
    return out && typeof out.then === "function" ? out.then(overJson) : overJson(out);
  }]));
}
