/**
 * aiSchemas.js — Strict structured-output validation for the AI Emergency
 * Response Orchestrator.
 *
 * Every Gemini response is coerced into one of these validated shapes before
 * ANY of its content may influence a decision. Malformed / missing / low-
 * confidence / contradictory output is rejected, never trusted.
 *
 * The deterministic engine remains the source of truth; AI output only ever
 * becomes a *recommendation* after passing these checks.
 */

const SEVERITY_ORDER = { critical: 3, moderate: 2, minor: 1 };

const SEVERITY_LEVELS = ["CRITICAL", "HIGH", "MODERATE", "MINOR", "LOW"];
const RESPONSE_LEVELS = [
  "IMMEDIATE_AMBULANCE",
  "AMBULANCE",
  "HOSPITAL_TRANSPORT",
  "MEDICAL_ASSESSMENT",
  "MONITOR",
];
const ACTIONS = [
  "DISPATCH_AMBULANCE",
  "RECOMMEND_HOSPITAL",
  "REASSIGN_AMBULANCE",
  "ESCALATE_CONTROL_ROOM",
  "CONTINUE_MONITORING",
];

/**
 * Validate a generic object returned by the model. Throws a typed error with a
 * specific reason the caller can map into a graceful fallback.
 */
function validateStructured(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw Object.assign(new Error("AI response was not an object"), { code: "AI_MALFORMED" });
  }

  const severity = String(parsed.severity || "").toUpperCase();
  if (!SEVERITY_LEVELS.includes(severity)) {
    throw Object.assign(new Error("AI severity outside allowed set"), { code: "AI_MISSING_FIELD" });
  }

  const priorityScore = normalizeScore(parsed.priorityScore);
  if (priorityScore == null) {
    throw Object.assign(new Error("AI priorityScore missing/invalid"), { code: "AI_MISSING_FIELD" });
  }

  const confidence = normalizeConfidence(parsed.confidence);
  if (confidence == null) {
    throw Object.assign(new Error("AI confidence missing/invalid"), { code: "AI_MISSING_FIELD" });
  }

  const recommendedAction = String(parsed.recommendedAction || "").toUpperCase();
  if (!ACTIONS.includes(recommendedAction)) {
    throw Object.assign(new Error("AI recommendedAction outside allowed set"), { code: "AI_MISSING_FIELD" });
  }

  return {
    severity,
    priorityScore,
    confidence,
    recommendedAmbulanceId: sanitizeId(parsed.recommendedAmbulanceId),
    recommendedHospitalId: sanitizeId(parsed.recommendedHospitalId),
    reasoningSummary: toReasoningList(parsed.reasoningSummary),
    recommendedAction,
    requiresHumanApproval: parsed.requiresHumanApproval !== false,
  };
}

function sanitizeId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s || s.length > 40 || s === "null" || s === "undefined" || s === "none") return null;
  return s;
}

function toReasoningList(value) {
  if (Array.isArray(value)) {
    return value
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  const s = String(value || "").trim();
  return s ? [s] : [];
}

function normalizeScore(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeConfidence(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/**
 * Ask whether a recommendation is trustworthy enough to surface / (if permitted)
 * apply automatically. Low-confidence output is surfaced as an advisory only.
 */
function isConfidenceAcceptable(validated, minConfidence) {
  return validated.confidence >= (minConfidence ?? 0.6);
}

/**
 * The orchestrator's own deterministic fallback triage — used whenever Gemini
 * is unavailable, times out, or returns an invalid response. Mirrors the
 * existing SEVERITY_ORDER used by the engine so the deterministic path wins.
 */
function deterministicTriage(patient) {
  const sev = String(patient?.severity || "moderate").toLowerCase();
  const urgency = SEVERITY_ORDER[sev] ?? SEVERITY_ORDER.moderate;
  const condition = String(patient?.condition || "").toLowerCase();

  let severity = "MODERATE";
  let recommendedAction = "AMBULANCE";
  let priorityScore = 55;
  if (urgency >= 3 || /unconscious|not breathing|no breath|severe bleed|crash|cardiac|heart attack/i.test(condition)) {
    severity = "CRITICAL";
    recommendedAction = "DISPATCH_AMBULANCE";
    priorityScore = 90 + (urgency >= 3 ? 5 : 0);
  } else if (urgency === 2 || /fracture|bleed|chest pain|stroke|seizure/i.test(condition)) {
    severity = "HIGH";
    recommendedAction = "DISPATCH_AMBULANCE";
    priorityScore = 72;
  }

  return {
    severity,
    priorityScore: Math.min(100, priorityScore),
    confidence: 0.9,
    recommendedAmbulanceId: null,
    recommendedHospitalId: null,
    reasoningSummary: [`Deterministic triage: ${severity.toLowerCase()} priority based on reported severity and condition.`],
    recommendedAction,
    requiresHumanApproval: severity === "CRITICAL" || urgency >= 3,
    _source: "deterministic-fallback",
  };
}

module.exports = {
  SEVERITY_LEVELS,
  RESPONSE_LEVELS,
  ACTIONS,
  validateStructured,
  isConfidenceAcceptable,
  deterministicTriage,
};
