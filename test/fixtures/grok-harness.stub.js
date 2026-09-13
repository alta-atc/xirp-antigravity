// Minimal stub standing in for the real src/harness/grok-harness.js (built by WS2).
// Exercises the same shape the patcher expects: a `registerGrok(rt, ot)` export
// that calls both injected functions.
export function registerGrok(rt, ot) {
  rt({ agentName: "grok", stub: true });
  ot({ agentName: "grok", stub: true });
}
