/**
 * emergencyOrchestrator.js — AI Emergency Response Orchestrator (bounded
 * decision-support layer).
 *
 * The deterministic engine (emergencyEngine.js) stays authoritative. This
 * module provides four bounded capabilities:
 *
 *   1. Emergency Triage          — classify severity + recommended response
 *   2. Resource Matching         — recommend best ambulance FOR VALIDATION
 *   3. Hospital Recommendation   — explain/prioritise the deterministic
 *                                  recommender's eligible results (never
 *                                  replaces hard constraints)
 *   4. Adaptive Re-evaluation    — detect when the current plan degrades
 *
 * SAFETY MODEL
 *   AI  -> structured output -> schema validation -> deterministic eligibility
 *          checks -> (human approval where required) -> engine action
 *
 * The AI NEVER calls engine actions directly. Every decision below is turned
 * into a recommendation; a human operator applies it through the existing
 * role-gated engine actions. Only safe, information-only events are published
 * automatically (e.g. `ai:recommendation` streamed to dashboards).
 *
 * When Gemini is unavailable / times out / returns malformed or low-confidence
 * output, every function falls back to the deterministic pipeline so the
 * system keeps working without it.
 */

const { GenerativeModel, GoogleGenerativeAI } = require('@google/generative-ai');
const schemas = require("./aiSchemas");
const { createAiLogger } = require("./aiDecisionLogger");

const API_KEY = process.env.GEMINI_API_KEY || process.env.REACT_APP_GEMINI_API_KEY || "";
let genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

/** Deterministic fallback recommendation used when AI can't produce a valid one. */
function deterministicAmbulanceRecommendation(emergency, ambulances, patient) {
  const requiredUnit = patient?.severity === "critical" ? "ALS" : "BLS";
  const candidates = (ambulances || [])
    .filter((a) => a.status === "AVAILABLE")
    .map((a) => ({
      id: a.id,
      driver: a.driver,
      type: a.type,
      distance: dist(emergency, a),
      eta: eta(a, emergency),
      status: a.status,
      hasRequiredCapability: a.type === requiredUnit,
    }))
    .sort((x, y) => {
      // capabiliy first, then distance
      if (x.hasRequiredCapability !== y.hasRequiredCapability) return x.hasRequiredCapability ? -1 : 1;
      if (x.distance !== y.distance) return x.distance - y.distance;
      if (x.eta !== y.eta) return x.eta - y.eta;
      return 0;
    });

  const top = candidates[0];
  if (!top) return null;

  return {
    recommendedAmbulanceId: top.id,
    reason: `${top.id} (${top.type}) has the best validated response profile${top.hasRequiredCapability ? " with the required capability" : ""}.`,
    candidates: candidates.slice(0, 4).map((c) => ({
      id: c.id,
      distance: c.distance,
      eta: c.eta,
      status: c.status,
      capability: c.type,
    })),
  };
}

function dist(emergency, a) {
  if (!emergency?.location || !a?.location) return 0;
  const R = 6371;
  const dLat = ((a.location.lat - emergency.location.lat) * Math.PI) / 180;
  const dLng = ((a.location.lng - emergency.location.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((emergency.location.lat * Math.PI) / 180) *
      Math.cos((a.location.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)) * 100) / 100;
}

function eta(a, emergency) {
  const d = dist(emergency, a);
  const speed = 40; // km/h
  const minutes = (d / speed) * 60;
  return Math.round(minutes * 10) / 10;
}

/**
 * Build a compact, grounding-safe prompt for triage and recommendation, using
 * ONLY structured values that already exist inside the engine (no raw PII).
 */
function buildTriagePrompt(emergency, context = {}) {
  const p = emergency.patient || {};
  return {
    emergencyId: emergency.emergencyId,
    kind: emergency.kind,
    symptoms: p.condition || "Not specified",
    consciousness: context.consciousness || "Unknown",
    breathing: context.breathing || "Unknown",
    bleeding: context.bleeding || "Unknown",
    injuryType: context.injuryType || "Unknown",
    crashConfidence: emergency.crashConfidence != null ? emergency.crashConfidence + "%" : null,
    patientAge: p.age != null ? p.age : "Unknown",
    knownConditions: p.condition ? [p.condition] : [],
    criticalConditions: context.criticalConditions || [],
    locationContext: emergency.location?.label || "Unknown",
  };
}

const TRIAGE_SYSTEM_PROMPT = `You are an emergency medical triage assistant inside a deterministic response orchestrator.
You only ever output ONE JSON object with EXACTLY these keys:
{
  "severity": "CRITICAL" | "HIGH" | "MODERATE" | "MINOR",
  "priorityScore": <0-100>,
  "confidence": <0-1>,
  "recommendedAction": "DISPATCH_AMBULANCE" | "AMBULANCE" | "HOSPITAL_TRANSPORT" | "ESCALATE_CONTROL_ROOM",
  "reasoningSummary": [<2-4 short strings>],
  "requiresHumanApproval": <boolean>
}
Do not add other keys, markdown, or prose. Keep reasoning concise and factual.
Treat known critical conditions and crash/cardiac/respiratory clues with high urgency.
If a patient is unconscious or has abnormal breathing, "severity" MUST be CRITICAL and
"requiresHumanApproval" MUST be true.`;

const REEVAL_SYSTEM_PROMPT = `You are an adaptive response planner inside a deterministic emergency orchestrator.
You receive a JSON input describing the CURRENT plan (ambulance ETA, hospital ETA, alternatives).
You only ever output ONE JSON object with EXACTLY these keys:
{
  "planOptimal": <boolean>,
  "recommendedAction": "REASSIGN_AMBULANCE" | "CONTINUE_MONITORING" | "ESCALATE_CONTROL_ROOM",
  "recommendedAmbulanceId": <string|null>,
  "reasoningSummary": [<1-3 short strings>],
  "requiresHumanApproval": <boolean>
}
If traffic/capacity changes meaningfully degrade the plan, recommend REASSIGN_AMBULANCE and a concrete
alternative ambulance id ONLY if one is clearly better. Otherwise recommend CONTINUE_MONITORING.`;

function parseModelJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Strip markdown fences and surrounding prose as a best-effort recovery.
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

async function callGemini(prompt, systemPrompt) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 512 },
    });
    const res = await model.generateContent(systemPrompt + "\n\nInput:\n" + JSON.stringify(prompt));
    const text = res?.response?.text?.() || "";
    return parseModelJson(text);
  } catch (err) {
    console.warn("[aiOrchestrator] Gemini call failed:", err.message);
    return null;
  }
}

/* Shallow status tracker per emergency so re-evaluations know the previous plan. */
const planTrackers = new Map();

function snapshotPlan(emergency) {
  return {
    emergencyId: emergency.emergencyId,
    status: emergency.status,
    ambulanceId: emergency.ambulanceId,
    ambulanceEta: emergency.etaToPatient != null ? emergency.etaToPatient : null,
    etaToPatient: emergency.etaToPatient != null ? emergency.etaToPatient : null,
    etaToHospital: emergency.etaToHospital != null ? emergency.etaToHospital : null,
    hospitalId: emergency.hospitalId,
    hospitalName: emergency.hospital?.name || null,
    severity: emergency.patient?.severity || "moderate",
  };
}

/**
 * Initial triage. Returns a validated recommendation + appends a decision log
 * entry. Falls back to deterministic triage on any AI failure.
 */
async function runTriage(emergency, aiLog, context = {}) {
  const prompt = buildTriagePrompt(emergency, context);

  const validated = await safeDecision(async () => {
    const parsed = await callGemini(prompt, TRIAGE_SYSTEM_PROMPT);
    if (!parsed) return null;
    const v = schemas.validateStructured(parsed);
    if (!schemas.isConfidenceAcceptable(v, 0.5)) {
      throw Object.assign(new Error("AI triage confidence too low"), { code: "AI_LOW_CONFIDENCE" });
    }
    return v;
  }, () => schemas.deterministicTriage(emergency.patient || {}));

  const decision = validated;
  const entry = aiLog.add({
    event: "ai:triage",
    inputs: prompt,
    decision,
    reason: decision.reasoningSummary?.[0] || "Triage completed",
    confidence: decision.confidence,
    status: validated._source === "deterministic-fallback" ? "FALLBACK" : "GENERATED",
    requiresHumanApproval: decision.requiresHumanApproval,
  });

  return { decision, logEntry: entry, fallback: validated._source === "deterministic-fallback" };
}

/**
 * Determine the best available ambulance. Uses the existing available fleet
 * data; output is validated against eligibility. Returns a recommendation.
 */
async function recommendAmbulance(emergency, aiLog, ambulances, context = {}) {
  const patient = emergency.patient || {};
  const requiredUnit = patient.severity === "critical" ? "ALS" : "BLS";
  const available = (ambulances || []).filter((a) => a.status === "AVAILABLE");

  // Deterministic grounding (always present).
  const deterministic = deterministicAmbulanceRecommendation(emergency, available, patient);

  const prompt = {
    emergencyId: emergency.emergencyId,
    severity: context.decision?.severity || severityLabelOf(patient.severity),
    requiredCapability: requiredUnit,
    patientCondition: patient.condition || "Not specified",
    ambulances: (available || []).slice(0, 6).map((a) => ({
      id: a.id,
      distanceKm: dist(emergency, a),
      etaMin: eta(a, emergency),
      status: a.status,
      capability: a.type,
      driver: a.driver,
    })),
  };

  const selected = await safeDecision(
    async () => {
      const parsed = await callGemini({ ...prompt, task: "ambulance-selection" },
        `You recommend the best ambulance for an emergency. Output ONLY JSON with keys:
{"recommendedAmbulanceId": <string>, "reasoningSummary": [<2-3 strings>]}.
Prefer the ambulance with the best combination of required capability and lowest validated ETA.`);
      if (!parsed?.recommendedAmbulanceId) return null;
      const recommended = available.find((a) => a.id === parsed.recommendedAmbulanceId);
      // Eligibility re-check: the deterministic layer validates the pick.
      if (!recommended) {
        throw Object.assign(new Error("AI recommended an unavailable ambulance"), { code: "AI_INVALID_AMBULANCE" });
      }
      if (requiredUnit && recommended.type !== requiredUnit && deterministic?.recommendedAmbulanceId !== recommended.id) {
        throw Object.assign(new Error("AI recommended an ambulance without required capability"), { code: "AI_CAPABILITY_MISMATCH" });
      }
      return {
        recommendedAmbulanceId: recommended.id,
        reasoningSummary: Array.isArray(parsed.reasoningSummary) ? parsed.reasoningSummary : [],
        candidates: prompt.ambulances,
      };
    },
    () => deterministic
  );

  if (!selected) return { recommendation: null, logEntry: null, fallback: true };

  const entry = aiLog.add({
    event: "ai:recommendation",
    inputs: { emergencyId: emergency.emergencyId, candidates: prompt.ambulances },
    decision: selected,
    reason: selected.reasoningSummary?.[0] || `Recommended ${selected.recommendedAmbulanceId}`,
    confidence: 0.9,
    status: selected._source === "deterministic-fallback" ? "FALLBACK" : "GENERATED",
    requiresHumanApproval: false,
  });

  return { recommendation: selected, logEntry: entry, fallback: selected._source === "deterministic-fallback" };
}

/**
 * Hospital recommendation uses the EXISTING deterministic recommender as the
 * ground truth; the AI only prioritises/explains among already-eligible
 * hospitals. Returns both the deterministic list and the AI explanation.
 */
async function explainHospitals(emergency, aiLog, recommendationList) {
  const eligible = (recommendationList?.recommendations || [])
    .filter((r) => r.eligible)
    .slice(0, 4)
    .map((r) => ({
      id: r.hospital.id,
      name: r.hospital.name,
      score: r.score,
      eta: r.eta,
      distance: r.distance,
      traumaCapability: r.hospital.specialties?.includes("Trauma"),
      icuAvailable: r.hospital.icuBeds > 0,
      bedsAvailable: r.hospital.emergencyBeds > 0,
    }));

  const prompt = {
    emergencyId: emergency.emergencyId,
    patientSeverity: emergency.patient?.severity || "moderate",
    condition: emergency.patient?.condition || "Not specified",
    hospitals: eligible,
  };

  const explanation = await safeDecision(
    async () => {
      const parsed = await callGemini({ ...prompt, task: "hospital-explanation" },
        `Prioritise these ALREADY validated hospitals. Output ONLY JSON with keys:
{"recommendedHospitalId": <string>, "reasoningSummary": [<2-3 strings>]}.
Reference only facts present in the hospital records below.`);
      if (parsed?.recommendedHospitalId) {
        const exists = eligible.some((h) => h.id === parsed.recommendedHospitalId);
        if (!exists) throw Object.assign(new Error("AI recommended a hospital outside eligible set"), { code: "AI_INVALID_HOSPITAL" });
      }
      return parsed && { recommendedHospitalId: parsed.recommendedHospitalId, reasoningSummary: parsed.reasoningSummary || [] } || null;
    },
    () => {
      const top = eligible[0];
      return top
        ? { recommendedHospitalId: top.id, reasoningSummary: ["Deterministic ranking selected " + top.id + "."] }
        : null;
    }
  );

  const entry = aiLog.add({
    event: "ai:recommendation",
    inputs: { emergencyId: emergency.emergencyId, eligible: eligible.map((h) => h.id) },
    decision: explanation,
    reason: explanation?.reasoningSummary?.[0] || "No eligible hospital",
    confidence: 0.9,
    status: explanation?._source === "deterministic-fallback" ? "FALLBACK" : "GENERATED",
    requiresHumanApproval: false,
  });

  return { explanation, logEntry: entry, eligible, fallback: explanation?._source === "deterministic-fallback" };
}

function severityLabelOf(severity) {
  if (!severity) return "MODERATE";
  const s = String(severity).toLowerCase();
  if (s === "critical") return "CRITICAL";
  if (s === "high" || s === "moderate") return s.toUpperCase();
  return "MINOR";
}

/**
 * Normalize a humanized ETA ("14 minutes", "Less than 1 minute", "Unknown") or
 * a raw number into numeric minutes so plan deltas can be compared. Returns
 * null when the ETA cannot be quantified.
 */
function etaMinutes(eta) {
  if (typeof eta === "number") return eta;
  if (typeof eta !== "string") return null;
  const m = eta.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return /hour/i.test(eta) ? n * 60 : n;
}

/**
 * Adaptive re-evaluation. Called after events that can degrade the plan
 * (ETA changes, traffic, hospital rejection, ambulance failure). Detects
 * meaningful plan degradation and surfaces a recommendation. Requires the
 * prior plan; defaults to safe deterministic handling.
 */
async function reevaluate(emergency, aiLog, ambulances, cause = {}) {
  const prior = planTrackers.get(emergency.emergencyId) || snapshotPlan(emergency);
  const current = snapshotPlan(emergency);
  planTrackers.set(emergency.emergencyId, current);

  const priorMin = etaMinutes(prior.etaToPatient);
  const currentMin = etaMinutes(current.etaToPatient);
  const etaDelta = priorMin != null && currentMin != null
    ? Math.round((currentMin - priorMin) * 10) / 10
    : 0;

  const degraded = etaDelta > 3 || cause.ambulanceUnavailable || cause.hospitalUnavailable;

  // Deterministic: find an alternative if degraded.
  const alternatives = degraded
    ? deterministicAmbulanceRecommendation(emergency, (ambulances || []).filter((a) => a.status === "AVAILABLE"), emergency.patient || {})
    : null;
  const alternativeId = alternatives?.recommendedAmbulanceId || null;

  const prompt = {
    emergencyId: emergency.emergencyId,
    currentAmbulanceId: current.ambulanceId,
    currentAmbulanceEtaMin: currentMin,
    priorAmbulanceEtaMin: priorMin,
    etaDeltaMin: etaDelta,
    currentHospitalId: current.hospitalId,
    currentHospitalEtaMin: etaMinutes(current.etaToHospital),
    severity: String(emergency.patient?.severity || "moderate").toUpperCase(),
    alternatives: alternatives?.candidates || [],
    cause,
  };

  const decision = await safeDecision(
    async () => {
      if (!degraded) {
        return {
          planOptimal: true,
          recommendedAction: "CONTINUE_MONITORING",
          recommendedAmbulanceId: null,
          reasoningSummary: ["Plan is still optimal — no re-planning required."],
          requiresHumanApproval: false,
        };
      }
      const parsed = await callGemini(prompt, REEVAL_SYSTEM_PROMPT);
      if (parsed && (parsed.planOptimal === true || parsed.recommendedAction === "CONTINUE_MONITORING")) {
        return {
          planOptimal: true,
          recommendedAction: "CONTINUE_MONITORING",
          recommendedAmbulanceId: null,
          reasoningSummary: ["No meaningful improvement found among current alternatives."],
          requiresHumanApproval: false,
        };
      }
      const v = schemas.validateStructured(parsed);
      return {
        planOptimal: false,
        recommendedAction: "REASSIGN_AMBULANCE",
        recommendedAmbulanceId: v.recommendedAmbulanceId || alternativeId,
        reasoningSummary: v.reasoningSummary,
        requiresHumanApproval: true,
      };
    },
    () => ({
      planOptimal: !degraded,
      recommendedAction: degraded ? "REASSIGN_AMBULANCE" : "CONTINUE_MONITORING",
      recommendedAmbulanceId: alternativeId,
      reasoningSummary: degraded
        ? [`ETA degraded by ${etaDelta} min — deterministic alternative ${alternativeId || "none"}.`]
        : ["Plan is still optimal."],
      requiresHumanApproval: degraded,
    })
  );

  const entry = aiLog.add({
    event: "ai:reevaluation",
    inputs: prompt,
    decision,
    reason: decision.reasoningSummary?.[0] || "Re-evaluation completed",
    confidence: 0.9,
    status: decision._source === "deterministic-fallback" ? "FALLBACK" : "GENERATED",
    requiresHumanApproval: decision.requiresHumanApproval,
    cause,
  });

  return { decision, logEntry: entry, etaDelta, prior, current, fallback: decision._source === "deterministic-fallback" };
}

/** Wrap an AI operation so any AI failure yields null/false + deterministic fallback. */
async function safeDecision(aiFn, fallbackFn) {
  let decided;
  try {
    decided = (await aiFn()) || null;
  } catch (err) {
    console.warn("[aiOrchestrator] safeDecision fallback:", err.message);
    decided = null;
  }
  if (!decided) {
    const d = fallbackFn ? fallbackFn() : null;
    if (d && typeof d === "object") d._source = "deterministic-fallback";
    return d;
  }
  return decided;
}

/** Clear per-emergency planner state (used by reset). */
function resetPlanners() {
  planTrackers.clear();
}

/** Drop stored plan so next evaluation treats current as baseline. Retain after reset? No. */
function snapshotCurrentAsPlan(emergency) {
  planTrackers.set(emergency.emergencyId, snapshotPlan(emergency));
}

module.exports = {
  runTriage,
  recommendAmbulance,
  explainHospitals,
  reevaluate,
  resetPlanners,
  snapshotCurrentAsPlan,
  deterministicAmbulanceRecommendation,
  severityLabelOf,
  isConfigured: () => !!genAI,
};