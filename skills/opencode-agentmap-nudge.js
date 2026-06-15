// SPDX-License-Identifier: MIT
// OpenCode plugin — logs a reminder when bash/grep looks like a structural search.
// Always-on guidance lives in AGENTS.md (installed by --install-skill).
// Non-blocking: uses client.app.log when available.

const DEP_RE =
  /\b(import|require\s*\(|imported\s+by|depends|dependents?|dependency)\b|from\s+["']|(^|\|)\s*export\b/i;
const INTENT_RE =
  /\bwhere\s+is\b|\bwho\s+(imports|uses|renders)\b|\breuse\b|\b(existing|shared)\s+(util|component|hook|helper)\b/i;
const SYMBOL_RE = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;

function shouldNudge(tool, args) {
  const pattern = String(args?.pattern || args?.query || "");
  const cmd = String(args?.command || "");
  if (tool === "grep" && pattern) return DEP_RE.test(pattern) || INTENT_RE.test(pattern);
  if (tool === "bash" && cmd) {
    if (!/(^|[;&]\s*)(rg|ripgrep|grep|egrep|fgrep|ag|ack)\b/.test(cmd)) return false;
    return DEP_RE.test(cmd) || INTENT_RE.test(cmd) || SYMBOL_RE.test(cmd);
  }
  return false;
}

export const AgentmapNudge = async ({ client }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (!shouldNudge(input.tool, output.args)) return;
      const message =
        "Structural search: prefer agentmap --any <query>, --relates <path>, or --find <symbol> before serial grep.";
      try {
        await client?.app?.log?.({
          body: { service: "agentmap", level: "info", message },
        });
      } catch {
        // advisory only
      }
    },
  };
};
