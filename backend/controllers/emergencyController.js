const engine = require("../domain/emergencyEngine");
const bus = require("../domain/bus");

/**
 * POST /api/v1/emergencies
 * Reports a new emergency (self, bystander, crash alert). Single entry point
 * for ALL reporting paths.
 */
function createEmergency(req, res) {
  try {
    const { kind, reporter, patient, location } = req.body || {};
    if (!location || typeof location.lat === "undefined" || typeof location.lng === "undefined") {
      return res.status(400).json({ error: "A valid location (lat/lng) is required" });
    }
    const emergency = engine.createEmergency({ kind, reporter, patient, location });
    // Advisory AI pipeline (triage + ambulance recommendation). Fire-and-forget:
    // it must never block or fail an emergency report. Gemini absence degrades
    // to deterministic suggestions logged with a FALLBACK status.
    setImmediate(() => {
      require("../domain/ai/aiAdviser").runAdvisoryPipeline(emergency).catch(() => {});
    });
    res.status(201).json({ success: true, emergency });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/emergencies/:id/patient
 * Body: { patientId, identificationMethod, verified?, details? }
 * Attaches a server-resolved patient reference (e.g. from a bystander QR scan)
 * to an existing emergency. Only the non-sensitive reference is stored.
 */
function attachPatient(req, res) {
  try {
    const { patientId, identificationMethod, verified, details } = req.body || {};
    if (!identificationMethod && !patientId) {
      return res.status(400).json({ error: "patientId and/or identificationMethod are required" });
    }
    const emergency = engine.attachPatient(req.params.id, {
      patientId,
      identificationMethod,
      verified,
      details,
    });
    res.json({ success: true, emergency });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/emergencies/:id/ai
 * Returns the AI decision trail (append-only audit log) for an emergency.
 */
function aiTrail(req, res) {
  try {
    const emergency = engine.getEmergency(req.params.id);
    if (!emergency) return res.status(404).json({ error: "Emergency not found" });
    res.json({ success: true, aiDecisionLog: emergency.aiDecisionLog || [] });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/emergencies
 */
function listEmergencies(req, res) {
  try {
    const emergencies = engine.listEmergencies({
      status: req.query.status,
      activeOnly: req.query.activeOnly !== "false",
    });
    res.json({ count: emergencies.length, emergencies });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/emergencies/admission-requests?hospitalId=HOSP-005
 * Emergencies where this hospital currently has a WAITING admission request
 * (may not yet be the assigned destination — first-accept-wins).
 */
function listAdmissionRequests(req, res) {
  try {
    const { hospitalId } = req.query;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId is required" });
    const emergencies = engine.listAdmissionRequests(hospitalId);
    res.json({ count: emergencies.length, emergencies });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/emergencies/:id
 */
function getEmergency(req, res) {
  try {
    const emergency = engine.getEmergency(req.params.id);
    if (!emergency) return res.status(404).json({ error: "Emergency not found" });
    res.json({ success: true, emergency });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/emergencies/:id/actions
 * Body: { role, action, ambulanceId?, hospitalId?, actor? }
 * Ignores that a hospital can never accept an ambulance request — the engine
 * enforces it centrally.
 */
function applyAction(req, res) {
  try {
    const { role, action, ambulanceId, hospitalId, rejectReason, conditions, actor, resources, rating, ratingComment, ratingCategories } = req.body || {};
    if (!role || !action) {
      return res.status(400).json({ error: "role and action are required" });
    }
    const emergency = engine.applyAction(req.params.id, action, {
      role, ambulanceId, hospitalId, rejectReason, conditions, actor, resources, rating, ratingComment, ratingCategories,
    });
    res.json({ success: true, emergency });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/emergencies/:id/siren
 * Body: { role: 'ambulance', ambulanceId, on?: boolean }
 */
function toggleSiren(req, res) {
  try {
    const { role, ambulanceId, on } = req.body || {};
    if (role !== engine.ROLES.AMBULANCE) {
      return res.status(403).json({ error: "Only an ambulance driver can control the siren" });
    }
    if (!ambulanceId) return res.status(400).json({ error: "ambulanceId is required" });
    const payload = engine.toggleSiren({ ambulanceId, emergencyId: req.params.id, on });
    res.json({ success: true, payload });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/ambulances/:id/move
 * Body: { lat, lng }
 */
function moveAmbulance(req, res) {
  try {
    const { lat, lng } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat/lng (numbers) are required" });
    }
    const result = engine.moveAmbulance({ ambulanceId: req.params.id, lat, lng });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/ambulances
 */
function listAmbulances(req, res) {
  try {
    res.json({ count: 3, ambulances: engine.listAmbulances(), simulated: true });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/hospitals
 */
function listHospitals(req, res) {
  try {
    res.json({ count: 3, hospitals: engine.listHospitals(), simulated: true });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/status — control-room rollup
 */
function statusOverview(req, res) {
  try {
    const emergencies = engine.listEmergencies({ activeOnly: true });
    const ambulances = engine.listAmbulances();
    const hospitals = engine.listHospitals();

    const byPhase = emergencies.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    }, {});

    res.json({
      simulated: true,
      activeEmergencies: emergencies.length,
      recentEmergency: emergencies[0] || null,
      byPhase,
      ambulancesAvailable: ambulances.filter((a) => a.status === "AVAILABLE").length,
      ambulanceCount: ambulances.length,
      hospitalCapacity: hospitals.reduce((sum, h) => sum + h.availableBeds, 0),
      hospitals: hospitals.length,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    handleError(err, res);
  }
}

/*
 * Reset demo state (control room convenience).
 */
function resetDemo(req, res) {
  engine.reset();
  try {
    require("../domain/ai/aiAdviser").resetAdvisers();
  } catch (err) {
    /* advisory only */
  }
  res.json({ success: true, message: "Demo state reset. All systems standby." });
}

/**
 * GET /api/v1/metrics — live control-room metrics from the in-memory records.
 */
function metrics(req, res) {
  try {
    res.json({ simulated: true, ...engine.metrics() });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/emergencies/:id/recommendations — hospital recommendations for
 * an emergency, including explainability data for every candidate.
 */
function getRecommendations(req, res) {
  try {
    res.json({ success: true, recommendations: engine.getRecommendations(req.params.id) });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/green-corridor/:emergencyId — current corridor state.
 */
function getCorridor(req, res) {
  try {
    const corridor = engine.corridorForEmergency(req.params.emergencyId);
    res.json({ success: true, ...corridor });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /api/v1/scoring-config — expose the centralized weights so any UI can
 * display them (algorithm transparency).
 */
function scoringConfig(req, res) {
  res.json({ success: true, ...engine.getScoringConfig() });
}

/**
 * POST /api/v1/emergencies/:id/resources — hospital updates its own resource
 * data (refreshes the freshness timestamp used by the recommender).
 */
function updateResources(req, res) {
  try {
    const { role, hospitalId, resources } = req.body || {};
    const emergency = engine.applyAction(req.params.id, "update-resources", { role, hospitalId, resources });
    res.json({ success: true, emergency });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/demo/full-scenario — deterministic end-to-end demo.
 */
function fullDemoScenario(req, res) {
  try {
    const demo = require("../domain/demoMode");
    const emergency = demo.runFullScenario();
    res.json({ success: true, emergency, message: "Full demo scenario started. Watch the emergency flow on all dashboards." });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/demo/crash-scenario — crash detection demo.
 */
function crashDemoScenario(req, res) {
  try {
    const demo = require("../domain/demoMode");
    const emergency = demo.runCrashScenario();
    res.json({ success: true, emergency, message: "Crash detection demo started." });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/demo/adaptive-dispatch — the AI adaptive-dispatch demo.
 * A critical crash report → patient-ref QR identification → AI triage /
 * recommendation → traffic degrades the assigned unit's ETA → AI re-evaluation
 * flags REASSIGN_AMBULANCE → control room approves → deterministic reassignment
 * → rescue completed.
 */
function adaptiveDispatchDemoScenario(req, res) {
  try {
    const demo = require("../domain/demoMode");
    const emergency = demo.runAdaptiveDispatchScenario();
    res.json({
      success: true,
      emergency,
      message: "Adaptive dispatch demo started. Watch traffic trigger an AI re-plan.",
    });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/demo/unknown-qr — QR identification failure demo.
 * A scanned token does not resolve; control room receives
 * `patient:verification-failed` with no emergency created.
 */
function unknownQrDemoScenario(req, res) {
  try {
    const demo = require("../domain/demoMode");
    const result = demo.runUnknownQrScenario();
    res.json({ success: true, ...result, message: "QR identification failure simulated." });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/demo/ambulance-shortage — resource-failure demo.
 * Every unit declines; the engine degrades to NO_AMBULANCE_AVAILABLE and
 * escalates for manual coordination.
 */
function ambulanceShortageDemoScenario(req, res) {
  try {
    const demo = require("../domain/demoMode");
    const emergency = demo.runAmbulanceShortageScenario();
    res.json({
      success: true,
      emergency,
      message: "Ambulance shortage scenario started. All units will decline.",
    });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /api/v1/emergencies/:id/reevaluate — run an advisory re-evaluation for
 * an active emergency (plan degradation check). Fires ai:reevaluation +
 * ai:decision so control room hears it live.
 */
async function reevaluateEmergency(req, res) {
  try {
    const adviser = require("../domain/ai/aiAdviser");
    const emergency = engine.getEmergency(req.params.id);
    if (!emergency) return res.status(404).json({ error: "Emergency not found" });
    const cause = req.body?.cause || { requestedBy: "control-room" };
    const result = await adviser.runReevaluation(emergency, engine.listAmbulances(), cause);
    res.json({
      success: true,
      etaDelta: result.etaDelta,
      decision: result.decision,
      entry: result.logEntry,
    });
  } catch (err) {
    handleError(err, res);
  }
}

function handleError(err, res) {
  const status = { BAD_REQUEST: 400, NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATE: 409 }[err.code] || 500;
  console.error(` [api] ${err.message}`);
  res.status(status).json({
    error: err.message,
    code: err.code || "SERVER_ERROR",
    currentStatus: err.currentStatus,
  });
}

module.exports = {
  createEmergency,
  attachPatient,
  aiTrail,
  listEmergencies,
  listAdmissionRequests,
  getEmergency,
  applyAction,
  toggleSiren,
  moveAmbulance,
  listAmbulances,
  listHospitals,
  statusOverview,
  resetDemo,
  metrics,
  getRecommendations,
  getCorridor,
  scoringConfig,
  updateResources,
  fullDemoScenario,
  crashDemoScenario,
  adaptiveDispatchDemoScenario,
  unknownQrDemoScenario,
  ambulanceShortageDemoScenario,
  reevaluateEmergency,
};