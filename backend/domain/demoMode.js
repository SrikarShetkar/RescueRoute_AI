/**
 * demoMode.js — Deterministic end-to-end demo scenarios for the jury.
 *
 * runFullScenario(): the complete rescue sequence (report → ambulance →
 * pickup → hospital recommendation → rejection → reroute → accept → corridor →
 * arrival → complete).
 *
 * runCrashScenario(): crash-detection flow — a potential crash is simulated
 * and the verification countdown begins; the Reporter screen's "Are you okay?"
 * prompts drive the confirmation.
 *
 * These are demo conveniences only — they drive the exact same engine actions
 * a human operator would trigger, so what the jury sees is the real flow.
 */

const engine = require("./emergencyEngine");
const bus = require("./bus");
const aiAdviser = require("./ai/aiAdviser");
const patientRegistry = require("./patientRegistry");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let demoEmergencyId = null;

function demoPatient(severity = "critical", condition = "Crash injury, suspected internal bleeding") {
  return {
    name: "Demo Patient",
    age: 34,
    bloodGroup: "B+",
    allergies: "None",
    condition,
    severity,
  };
}

function demoLocation(label = "Hitech City, Hyderabad") {
  return { lat: 17.4016, lng: 78.4055, label };
}

function runFullScenario() {
  const em = engine.createEmergency({
    kind: "ACCIDENT_REPORT",
    reporter: { name: "Demo Reporter", via: "bystander" },
    patient: demoPatient("critical", "Crash injury, suspected internal bleeding"),
    location: demoLocation(),
  });
  demoEmergencyId = em.emergencyId;
  // Drive the ambulance the engine actually assigned (preference isn't a
  // guarantee — see the seeded dispatcher rules), so the demo never assumes.
  const ambulanceId = em.ambulance ? em.ambulance.id : em.ambulanceId;
  fireAndForget(runFullSequence(demoEmergencyId, ambulanceId));
  return em;
}

async function runFullSequence(emergencyId, ambulanceId) {
  try {
    await delay(1500);
    engine.applyAction(emergencyId, "accept", { role: engine.ROLES.AMBULANCE, ambulanceId });

    await moveAmbulanceAlong(emergencyId, ambulanceId, { lat: 17.385, lng: 78.4867 }, { lat: 17.4016, lng: 78.4055 }, STEPS.PATIENT);

    await delay(1200);
    engine.applyAction(emergencyId, "at-patient", { role: engine.ROLES.AMBULANCE, ambulanceId });
    await delay(1200);
    engine.applyAction(emergencyId, "pickup", { role: engine.ROLES.AMBULANCE, ambulanceId });

    // Hospital A (top recommendation) rejects with a legitimate reason →
    // the engine reroutes and control room sees the rejection live.
    await delay(1500);
    const snapshotA = engine.getEmergency(emergencyId);
    if (snapshotA?.hospitalId) {
      engine.applyAction(emergencyId, "reject-patient", {
        role: engine.ROLES.HOSPITAL,
        hospitalId: snapshotA.hospitalId,
        rejectReason: "NO_EMERGENCY_BED",
      });
    }

    // Accept whatever the engine now recommends (Hospital B) — ambulance
    // travels along from its current position to the hospital.
    await delay(1500);
    const snapshotB = engine.getEmergency(emergencyId);
    if (snapshotB?.hospitalId) {
      engine.applyAction(emergencyId, "accept-patient", {
        role: engine.ROLES.HOSPITAL,
        hospitalId: snapshotB.hospitalId,
      });
      await moveAmbulanceAlong(
        emergencyId,
        ambulanceId,
        snapshotB.ambulance.liveLocation,
        snapshotB.hospital.liveLocation,
        STEPS.HOSPITAL
      );
    }

    await delay(800);
    engine.applyAction(emergencyId, "arrived-hospital", { role: engine.ROLES.AMBULANCE, ambulanceId });
    await delay(1200);
    // Hand the patient over — the case stays LIVE (IN_TREATMENT) until the
    // hospital discharges the patient, so the demo shows the hospital screen.
    engine.applyAction(emergencyId, "handover", { role: engine.ROLES.AMBULANCE, ambulanceId });
    await delay(1500);
    engine.applyAction(emergencyId, "discharge", { role: engine.ROLES.HOSPITAL, hospitalId: engine.getEmergency(emergencyId).hospitalId });
    engine.applyAction(emergencyId, "rate-hospital", {
      role: engine.ROLES.REPORTER,
      rating: 5,
      ratingComment: "Timely response and clean facility",
      ratingCategories: { care: 5, response: 4, facilities: 5 },
    });
  } catch (err) {
    console.error("[demoMode] full-scenario error:", err.message);
  }
}

const STEPS = {
  PATIENT: 14,
  HOSPITAL: 16,
};

async function moveAmbulanceAlong(emergencyId, ambulanceId, from, to, steps) {
  try {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const lat = from.lat + (to.lat - from.lat) * t;
      const lng = from.lng + (to.lng - from.lng) * t;
      engine.moveAmbulance({ ambulanceId, lat, lng });
      await delay(180);
    }
  } catch (err) {
    console.error("[demoMode] move error:", err.message);
  }
}

function runCrashScenario() {
  const em = engine.createEmergency({
    kind: "CRASH_DETECTION",
    reporter: { name: "Demo Citizen", via: "crash" },
    patient: { name: "Demo Citizen", severity: "critical", condition: "Crash detection — unresponsive" },
    location: demoLocation(),
    confidence: 87,
  });
  demoEmergencyId = em.emergencyId;
  return em;
}

/* ------------------------------------------------------------------ */
/* Adaptive dispatch — "Critical Crash — Adaptive Dispatch"             */
/*                                                                      */
/* A critical crash is reported, the victim is identified via a         */
/* patient-reference QR, and the AI advisory pipeline scores the        */
/* triage + ambulance plan. Heavy traffic makes the assigned (far)      */
/* unit's ETA jump; the AI re-evaluation detects the degradation and    */
/* recommends REASSIGN_AMBULANCE (requires human approval). The         */
/* control-room operator approves, and the deterministic engine          */
/* reassigns the closest available unit and completes the rescue.       */
/* ------------------------------------------------------------------ */

function runAdaptiveDispatchScenario() {
  // Resolve the victim from a real patient-reference QR (deterministic id).
  const victim = patientRegistry.lookupByPatientReference("PT-B7D6D7") || {};
  const em = engine.createEmergency({
    kind: "ACCIDENT_REPORT",
    reporter: { name: "Demo Bystander", via: "bystander" },
    patient: {
      name: victim.name || "Demo Patient",
      age: victim.age || 52,
      bloodGroup: victim.bloodGroup || "B+",
      allergies: victim.allergies || "None",
      severity: "critical",
      condition: "Crash injury, suspected internal bleeding",
    },
    location: demoLocation(),
  });
  demoEmergencyId = em.emergencyId;
  const ambulanceId = em.ambulance ? em.ambulance.id : em.ambulanceId;
  fireAndForget(runAdaptiveDispatchSequence(demoEmergencyId, ambulanceId));
  return em;
}

async function runAdaptiveDispatchSequence(emergencyId, ambulanceId) {
  try {
    // Advisory pipeline (triage + recommendation) — asynchronous, non-blocking.
    const snapshotAtCreate = engine.getEmergency(emergencyId);
    fireAndForget(aiAdviser.runAdvisoryPipeline(snapshotAtCreate));

    await delay(1500);
    engine.attachPatient(emergencyId, {
      patientId: "PT-B7D6D7",
      identificationMethod: "QR",
      verified: true,
      details: { source: "qr-scan", device: "demo-bystander" },
    });

    await delay(6000);
    engine.applyAction(emergencyId, "accept", { role: engine.ROLES.AMBULANCE, ambulanceId });
    // Baseline the plan AFTER acceptance so the traffic ETA jump is measured
    // against a healthy plan.
    aiAdviser.baselinePlan(engine.getEmergency(emergencyId));

    await delay(2500);
    // Heavy traffic / roadblock: the assigned unit is stuck and its ETA
    // degrades as it detours back away from the patient.
    engine.moveAmbulance({ ambulanceId, lat: 17.352, lng: 78.511 });
    console.log("[demoMode] adaptive-dispatch: simulation of heavy traffic congestion");

    await delay(900);
    await aiAdviser.runReevaluation(engine.getEmergency(emergencyId), engine.listAmbulances(), {
      scenario: "traffic",
      description: "Roadblock on the primary route — unit ETA degraded by congestion.",
    });

    await delay(2500);
    // Control-room operator (dispatch role) approves the AI re-plan.
    engine.applyAction(emergencyId, "reassign-ambulance", {
      role: engine.ROLES.DISPATCH,
      actor: "Control Room",
    });
    const afterReassign = engine.getEmergency(emergencyId);
    const newAmbulanceId = afterReassign.ambulanceId;
    // Complete the audit trail: the approved recommendation was applied.
    engine.logAiDecision(emergencyId, {
      event: "ai:decision",
      decision: {
        planOptimal: false,
        recommendedAction: "REASSIGN_AMBULANCE",
        recommendedAmbulanceId: newAmbulanceId,
        reasoningSummary: [`Control room approved adaptive re-plan → ${newAmbulanceId}.`],
        requiresHumanApproval: false,
      },
      reason: `Approved re-plan applied — reassigned to ${newAmbulanceId}`,
      confidence: 0.9,
      status: "GENERATED",
      requiresHumanApproval: false,
      cause: { scenario: "traffic" },
      approval: { approvedBy: "control-room-demo", appliedAction: "reassign-ambulance" },
    });

    await delay(3000);
    engine.applyAction(emergencyId, "accept", { role: engine.ROLES.AMBULANCE, ambulanceId: newAmbulanceId });
    await moveAmbulanceAlong(emergencyId, newAmbulanceId, afterReassign.ambulance.liveLocation, afterReassign.location, STEPS.PATIENT);

    await delay(1200);
    engine.applyAction(emergencyId, "at-patient", { role: engine.ROLES.AMBULANCE, ambulanceId: newAmbulanceId });
    await delay(1200);
    engine.applyAction(emergencyId, "pickup", { role: engine.ROLES.AMBULANCE, ambulanceId: newAmbulanceId });

    await delay(1200);
    const snap = engine.getEmergency(emergencyId);
    engine.applyAction(emergencyId, "accept-patient", { role: engine.ROLES.HOSPITAL, hospitalId: snap.hospitalId });
    engine.applyAction(emergencyId, "navigate", { role: engine.ROLES.AMBULANCE, ambulanceId: newAmbulanceId, hospitalId: snap.hospitalId });
    await moveAmbulanceAlong(emergencyId, newAmbulanceId, snap.ambulance.liveLocation, snap.hospital.liveLocation, STEPS.HOSPITAL);

    await delay(800);
    engine.applyAction(emergencyId, "arrived-hospital", { role: engine.ROLES.AMBULANCE, ambulanceId: newAmbulanceId });
    await delay(1200);
    engine.applyAction(emergencyId, "handover", { role: engine.ROLES.AMBULANCE, ambulanceId: newAmbulanceId });
    await delay(1500);
    engine.applyAction(emergencyId, "discharge", { role: engine.ROLES.HOSPITAL, hospitalId: engine.getEmergency(emergencyId).hospitalId });
    engine.applyAction(emergencyId, "rate-hospital", {
      role: engine.ROLES.REPORTER,
      rating: 5,
      ratingComment: "Adaptive dispatch re-plan kept things fast",
      ratingCategories: { care: 5, response: 5, facilities: 4 },
    });
  } catch (err) {
    console.error("[demoMode] adaptive-dispatch error:", err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Failure demos                                                       */
/* ------------------------------------------------------------------ */

/**
 * runUnknownQrScenario() — QR identification failure path. A scanned token
 * does not resolve to a patient record; the control room is notified via
 * `patient:verification-failed` without creating an emergency.
 */
function runUnknownQrScenario() {
  const token = "RESCUEROUTE:PATIENT:PT-UNKNOWN";
  const ref = patientRegistry.normalizePatientReference(token) || "INVALID_REFERENCE";
  const match = patientRegistry.lookupByPatientReference(ref);
  const reason = match ? "NO_MATCH" : ref === "INVALID_REFERENCE" ? "INVALID_REFERENCE" : "UNKNOWN_PATIENT_REFERENCE";
  bus.emit("patient:verification-failed", {
    token,
    ref,
    reason,
    message: reason === "INVALID_REFERENCE"
      ? "QR token did not match a valid patient reference."
      : "QR token did not resolve to a patient record.",
    at: new Date().toISOString(),
  });
  return { success: true, token, ref, reason };
}

/**
 * runAmbulanceShortageScenario() — resource-failure path. Every available
 * unit declines the case; the engine escalates to NO_AMBULANCE_AVAILABLE and
 * the control room is escalated for manual coordination. Demonstrates the
 * deterministic engine's resilience when the AI layer has nothing to plan.
 */
function runAmbulanceShortageScenario() {
  const em = engine.createEmergency({
    kind: "ACCIDENT_REPORT",
    reporter: { name: "Demo Citizen", via: "crash" },
    patient: demoPatient("critical", "Chest pain, possible cardiac event"),
    location: demoLocation(),
  });
  demoEmergencyId = em.emergencyId;
  fireAndForget(runShortageSequence(demoEmergencyId));
  return em;
}

async function runShortageSequence(emergencyId) {
  try {
    let snap = engine.getEmergency(emergencyId);
    // Every unit declines in sequence — the engine re-plans each time and
    // eventually reports no available unit.
    let guard = 0;
    while (snap.status === engine.STATUS.AMBULANCE_OFFERED && snap.ambulanceId && guard < 10) {
      await delay(1200);
      engine.applyAction(emergencyId, "reject", { role: engine.ROLES.AMBULANCE, ambulanceId: snap.ambulanceId });
      snap = engine.getEmergency(emergencyId);
      guard += 1;
    }
    // Escalation for manual coordination once the fleet is exhausted.
    if (snap.status === engine.STATUS.NO_AMBULANCE_AVAILABLE) {
      await delay(1200);
      engine.applyAction(emergencyId, "escalate", { role: engine.ROLES.DISPATCH, actor: "Control Room" });
    }
  } catch (err) {
    console.error("[demoMode] ambulance-shortage error:", err.message);
  }
}

function fireAndForget(promise) {
  promise.catch((err) => console.error("[demoMode]", err));
}

module.exports = {
  runFullScenario,
  runCrashScenario,
  runAdaptiveDispatchScenario,
  runUnknownQrScenario,
  runAmbulanceShortageScenario,
  getDemoEmergencyId: () => demoEmergencyId,
  demoPatient,
  demoLocation,
};