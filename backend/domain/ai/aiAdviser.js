/**
 * aiAdviser.js — Bridge between the AI Orchestrator and the deterministic
 * engine. Runs the ADVISORY pipeline (triage + ambulance recommendation) after
 * an emergency is created and persists every decision into the engine's
 * append-only `aiDecisionLog`.
 *
 * The AI here is advisory-only: it NEVER calls engine actions or mutates the
 * authoritative state. Every entry it writes describes what was recommended,
 * why, and whether it came from Gemini or the deterministic fallback.
 */

const engine = require("../emergencyEngine");
const { createAiLogger } = require("./aiDecisionLogger");
const orchestrator = require("./emergencyOrchestrator");

// Per-emergency logger instances keep AI entry id sequences stable. The
// authoritative trail lives on the emergency (engine.logAiDecision).
const logs = new Map();

function getLog(emergencyId) {
  if (!logs.has(emergencyId)) logs.set(emergencyId, createAiLogger());
  return logs.get(emergencyId);
}

/** Persist one orchestrator log entry to the engine's audit trail. */
function persistEntry(emergencyId, entry) {
  if (!entry) return null;
  try {
    return engine.logAiDecision(emergencyId, entry);
  } catch (err) {
    console.warn("[aiAdviser] persistEntry skipped:", err.message);
    return null;
  }
}

/**
 * Fire-and-forget advisory pipeline: triage then ambulance recommendation.
 * Never blocks the caller; failures degrade to deterministic suggestions.
 * Returns the orchestrator results for callers that await it.
 */
async function runAdvisoryPipeline(emergency, context = {}) {
  const emergencyId = emergency?.emergencyId;
  if (!emergencyId) return {};

  const aiLog = getLog(emergencyId);
  const results = {};

  try {
    results.triage = await orchestrator.runTriage(emergency, aiLog, context);
    persistEntry(emergencyId, results.triage.logEntry);

    results.ambulance = await orchestrator.recommendAmbulance(
      emergency,
      aiLog,
      engine.listAmbulances(),
      { decision: results.triage.decision, ...context }
    );
    persistEntry(emergencyId, results.ambulance.logEntry);
  } catch (err) {
    console.warn("[aiAdviser] pipeline error:", err.message);
  }

  return results;
}

/** Re-evaluation entry point (plan degradation, ETA changes, resource loss). */
async function runReevaluation(emergency, ambulances, cause = {}) {
  const emergencyId = emergency?.emergencyId;
  if (!emergencyId) return {};

  const aiLog = getLog(emergencyId);
  const results = await orchestrator.reevaluate(emergency, aiLog, ambulances, cause);
  persistEntry(emergencyId, results.logEntry);
  return results;
}

/**
 * Record the current plan as the baseline for a future re-evaluation.
 * Call this after the ambulance accepts (ideal ETA) so a later ETA jump /
 * resource loss is measured against it. Returns the recorded baseline.
 */
function baselinePlan(emergency) {
  const emergencyId = emergency?.emergencyId;
  if (!emergencyId) return null;
  orchestrator.snapshotCurrentAsPlan(emergency);
  return emergencyId;
}

/** Clear per-emergency logger instances (used when demo state is reset). */
function resetAdvisers() {
  logs.clear();
  orchestrator.resetPlanners();
}

module.exports = {
  runAdvisoryPipeline,
  runReevaluation,
  baselinePlan,
  resetAdvisers,
  getLog,
};