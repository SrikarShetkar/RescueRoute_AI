/**
 * aiDecisionLogger.js — Per-emergency AI decision audit trail.
 *
 * Every AI recommendation, re-evaluation, validation result and application
 * outcome is appended to a deterministic, append-only log attached to the
 * emergency. Dashboard(s) can fetch it; the format is deliberately human
 * readable (time, event, inputs, decision, reason, confidence, validation).
 */

let globalSerial = 1;

function createAiLogger() {
  const log = [];

  function normalizeConfidence(c) {
    if (c == null) return null;
    const n = Number(c);
    if (Number.isNaN(n)) return null;
    return Math.round(n * 100); // 0..100 for display
  }

  function entry(payload) {
    const e = {
      id: "AI-" + String(globalSerial++).padStart(3, "0"),
      at: new Date().toISOString(),
      event: payload.event || "ai:decision",
      inputs: payload.inputs || {},
      decision: payload.decision || {},
      reason: payload.reason || "",
      confidencePct: normalizeConfidence(payload.confidence ?? payload.decision?.confidence),
      validation: payload.validation || null,
      status: payload.status || "GENERATED",
      requiresHumanApproval: payload.requiresHumanApproval ?? false,
      appliedBy: payload.appliedBy || null,
    };
    log.push(e);
    return e;
  }

  return {
    log,
    add: entry,
    toArray: () => log.map((x) => ({ ...x, inputs: { ...x.inputs }, decision: { ...x.decision } })),
  };
}

module.exports = { createAiLogger };
