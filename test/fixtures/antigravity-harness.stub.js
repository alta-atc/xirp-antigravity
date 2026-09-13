// Minimal stub standing in for the real src/harness/antigravity-harness.js (built by the
// harness workstream). Exercises the same shape the patcher expects: a
// `registerAntigravity(rt, ot)` export that calls both injected functions.
export function registerAntigravity(rt, ot) {
  rt({ agentName: "antigravity", stub: true });
  ot({ agentName: "antigravity", stub: true });
}
