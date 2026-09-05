/**
 * emergencyEngine.js — The single source of truth for an emergency's lifecycle.
 *
 * This is the "brain" (Person 1 in the plan):
 *   - Every emergency has an immutable lifecycle. Status can only change
 *     through a role-gated action defined here — never by a screen guessing.
 *   - A hospital cannot mark a patient arrived before the ambulance has even
 *     accepted the case. A hospital cannot accept an ambulance request.
 *   - If a hospital declines a patient (with a legitimate operational reason),
 *     the engine records the rejection, removes/deprioritises the hospital,
 *     recalculates recommendations and offers the next-best hospital. After a
 *     configurable number of rejections it escalates to the control room.
 *   - Hospital requests support three responses: ACCEPT, CONDITIONAL ACCEPT
 *     (with a stated limitation) and REJECT (reason-gated, never free text).
 *   - Hospital recommendations come from a transparent two-stage engine
 *     (hard-constraint eligibility filter, then weighted scoring) — the final
 *     destination is still chosen by an authorised human operator.
 *   - Crash detection enters the same state machine via POTENTIAL_CRASH →
 *     USER_CONFIRMATION → CONFIRMED_EMERGENCY | CANCELLED.
 *   - Every transition produces a SOUND PLAN. Sounds are never played because
 *     of a click or a page load — only because a real domain event happened.
 *
 * Pure Node module: no MongoDB required, works fully in-memory for the demo.
 */

const { calculateDistance, calculateETA } = require("../utils/etaCalculator");
const recommender = require("./hospitalRecommender");
const corridor = require("./greenCorridor");
const config = require("../config/scoringConfig");
const bus = require("./bus");

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

const STATUS = {
  REPORTED: "REPORTED",
  AMBULANCE_OFFERED: "AMBULANCE_OFFERED",
  AMBULANCE_ACCEPTED: "AMBULANCE_ACCEPTED",
  AT_PATIENT: "AT_PATIENT",
  PICKED_UP: "PICKED_UP",
  HOSPITAL_OFFERED: "HOSPITAL_OFFERED",
  HOSPITAL_ACCEPTED: "HOSPITAL_ACCEPTED",
  TO_HOSPITAL: "TO_HOSPITAL",
  ARRIVED_AT_HOSPITAL: "ARRIVED_AT_HOSPITAL",
  IN_TREATMENT: "IN_TREATMENT",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",

  POTENTIAL_CRASH: "POTENTIAL_CRASH",
  USER_CONFIRMATION: "USER_CONFIRMATION",
  CONFIRMED_EMERGENCY: "CONFIRMED_EMERGENCY",
  USER_CONFIRMED_SAFE: "USER_CONFIRMED_SAFE",
  CONTROL_ROOM_ESCALATION: "CONTROL_ROOM_ESCALATION",
  NO_HOSPITAL_AVAILABLE: "NO_HOSPITAL_AVAILABLE",
  NO_AMBULANCE_AVAILABLE: "NO_AMBULANCE_AVAILABLE",
};

const ROLES = {
  REPORTER: "reporter",
  AMBULANCE: "ambulance",
  HOSPITAL: "hospital",
  DISPATCH: "dispatch",
  DRIVER: "driver",
  CITIZEN: "citizen",
};

const SOUND = {
  QUIET: "quiet",
  CONFIRM: "confirm",
  ATTENTION: "attention",
  SIREN: "siren",
};

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

const TRANSITIONS = {
  accept: {
    from: [STATUS.AMBULANCE_OFFERED],
    roles: [ROLES.AMBULANCE],
    label: "Ambulance accepted the case",
    to: STATUS.AMBULANCE_ACCEPTED,
  },
  reject: {
    from: [STATUS.AMBULANCE_OFFERED],
    roles: [ROLES.AMBULANCE],
    label: "Ambulance declined the case",
    reassignAmbulance: true,
  },
  "reassign-ambulance": {
    from: [STATUS.AMBULANCE_OFFERED, STATUS.AMBULANCE_ACCEPTED],
    roles: [ROLES.DISPATCH],
    label: "Control room reassigned a closer ambulance",
    reassignAmbulance: true,
  },
  "at-patient": {
    from: [STATUS.AMBULANCE_ACCEPTED],
    roles: [ROLES.AMBULANCE],
    label: "Ambulance arrived at the patient",
    to: STATUS.AT_PATIENT,
  },
  pickup: {
    from: [STATUS.AT_PATIENT],
    roles: [ROLES.AMBULANCE],
    label: "Patient picked up by ambulance",
    assignHospital: true,
  },
  "request-hospital": {
    from: [
      STATUS.PICKED_UP,
      STATUS.HOSPITAL_OFFERED,
      STATUS.TO_HOSPITAL,
      STATUS.CONTROL_ROOM_ESCALATION,
    ],
    roles: [ROLES.AMBULANCE, ROLES.DISPATCH],
    label: "Hospital requested by authorized operator",
    requestHospital: true,
  },
  "accept-patient": {
    from: [STATUS.HOSPITAL_OFFERED, STATUS.HOSPITAL_ACCEPTED],
    roles: [ROLES.HOSPITAL],
    label: "Hospital accepted the patient",
    hospitalResponse: "accept",
    acceptPatient: true,
    to: STATUS.HOSPITAL_ACCEPTED,
  },
  "conditional-accept": {
    from: [STATUS.HOSPITAL_OFFERED, STATUS.HOSPITAL_ACCEPTED],
    roles: [ROLES.HOSPITAL],
    label: "Hospital conditionally accepted the patient",
    hospitalResponse: "conditional-accept",
    acceptPatient: true,
    to: STATUS.HOSPITAL_ACCEPTED,
  },
  "navigate": {
    from: [STATUS.HOSPITAL_OFFERED, STATUS.HOSPITAL_ACCEPTED],
    roles: [ROLES.AMBULANCE, ROLES.DISPATCH],
    label: "Driver selected the hospital and started navigation",
    navigate: true,
    to: STATUS.TO_HOSPITAL,
  },
  "cancel-accept": {
    from: [STATUS.HOSPITAL_ACCEPTED],
    roles: [ROLES.HOSPITAL, ROLES.DISPATCH],
    label: "Hospital cancelled its acceptance — rerouting patient",
    cancelAccept: true,
  },
  "confirm-patient-received": {
    from: [STATUS.ARRIVED_AT_HOSPITAL],
    roles: [ROLES.HOSPITAL, ROLES.DISPATCH],
    label: "Hospital confirmed patient received — treatment begins",
    to: STATUS.IN_TREATMENT,
    handover: true,
    endCorridor: true,
  },
  "send-hospital-requests": {
    from: [STATUS.PICKED_UP, STATUS.HOSPITAL_OFFERED, STATUS.HOSPITAL_ACCEPTED, STATUS.TO_HOSPITAL],
    roles: [ROLES.AMBULANCE, ROLES.DISPATCH],
    label: "Admission requests sent to suitable hospitals in parallel",
    sendHospitalRequests: true,
  },
  "reject-patient": {
    from: [STATUS.HOSPITAL_OFFERED, STATUS.HOSPITAL_ACCEPTED],
    roles: [ROLES.HOSPITAL],
    label: "Hospital declined — rerouting patient",
    hospitalResponse: "reject",
    reassignHospital: true,
  },
  "update-resources": {
    from: [
      STATUS.REPORTED,
      STATUS.AMBULANCE_OFFERED,
      STATUS.AMBULANCE_ACCEPTED,
      STATUS.HOSPITAL_OFFERED,
      STATUS.TO_HOSPITAL,
    ],
    roles: [ROLES.HOSPITAL],
    label: "Hospital resources updated",
    updateResources: true,
  },
  "arrived-hospital": {
    from: [STATUS.TO_HOSPITAL],
    roles: [ROLES.AMBULANCE],
    label: "Ambulance arrived at hospital",
    to: STATUS.ARRIVED_AT_HOSPITAL,
  },
  complete: {
    from: [STATUS.ARRIVED_AT_HOSPITAL],
    roles: [ROLES.AMBULANCE, ROLES.HOSPITAL, ROLES.DISPATCH],
    label: "Patient handed over — case resolved",
    to: STATUS.COMPLETED,
    terminal: true,
    endCorridor: true,
  },
  handover: {
    from: [STATUS.ARRIVED_AT_HOSPITAL],
    roles: [ROLES.AMBULANCE, ROLES.HOSPITAL, ROLES.DISPATCH],
    label: "Patient handed over — admitted for treatment",
    to: STATUS.IN_TREATMENT,
    handover: true,
    endCorridor: true,
  },
  discharge: {
    from: [STATUS.IN_TREATMENT],
    roles: [ROLES.HOSPITAL, ROLES.DISPATCH],
    label: "Patient discharged — case fully resolved",
    to: STATUS.COMPLETED,
    terminal: true,
    discharge: true,
  },
  "rate-hospital": {
    from: [STATUS.IN_TREATMENT, STATUS.COMPLETED],
    roles: [ROLES.REPORTER, ROLES.DRIVER],
    label: "Reporter rated the hospital",
    rateHospital: true,
  },
  cancel: {
    from: [
      STATUS.REPORTED,
      STATUS.AMBULANCE_OFFERED,
      STATUS.AMBULANCE_ACCEPTED,
      STATUS.AT_PATIENT,
      STATUS.PICKED_UP,
      STATUS.HOSPITAL_OFFERED,
      STATUS.TO_HOSPITAL,
      STATUS.USER_CONFIRMATION,
    ],
    roles: [ROLES.DISPATCH, ROLES.REPORTER],
    label: "Emergency cancelled",
    to: STATUS.CANCELLED,
    terminal: true,
  },
  "false-alarm": {
    from: [
      STATUS.REPORTED,
      STATUS.AMBULANCE_OFFERED,
      STATUS.AMBULANCE_ACCEPTED,
      STATUS.AT_PATIENT,
      STATUS.PICKED_UP,
      STATUS.HOSPITAL_OFFERED,
      STATUS.TO_HOSPITAL,
    ],
    roles: [ROLES.DISPATCH],
    label: "Marked as a false alarm",
    to: STATUS.CANCELLED,
    terminal: true,
  },

  /* ---- crash-detection state machine ---- */
  "crash-detect": {
    from: [],
    roles: [ROLES.REPORTER, ROLES.CITIZEN],
    label: "Potential crash detected",
    to: STATUS.POTENTIAL_CRASH,
    crashDetect: true,
  },
  "crash-confirm-safe": {
    from: [STATUS.POTENTIAL_CRASH, STATUS.USER_CONFIRMATION],
    roles: [ROLES.REPORTER, ROLES.CITIZEN, ROLES.DISPATCH],
    label: "User confirmed safe — emergency cancelled",
    to: STATUS.USER_CONFIRMED_SAFE,
    terminal: true,
  },
  "crash-confirm-emergency": {
    from: [STATUS.POTENTIAL_CRASH, STATUS.USER_CONFIRMATION, STATUS.CONFIRMED_EMERGENCY],
    roles: [ROLES.REPORTER, ROLES.CITIZEN],
    label: "Crash confirmed — creating emergency",
    crashConfirm: true,
  },

  /* ---- escalation / override ---- */
  escalate: {
    from: [
      STATUS.HOSPITAL_OFFERED,
      STATUS.HOSPITAL_ACCEPTED,
      STATUS.PICKED_UP,
      STATUS.TO_HOSPITAL,
      STATUS.CONTROL_ROOM_ESCALATION,
    ],
    roles: [ROLES.DISPATCH],
    label: "Escalated to control room — manual coordination",
    to: STATUS.CONTROL_ROOM_ESCALATION,
  },
  "dispatch-override": {
    from: [STATUS.CONTROL_ROOM_ESCALATION, STATUS.HOSPITAL_OFFERED, STATUS.HOSPITAL_ACCEPTED, STATUS.PICKED_UP],
    roles: [ROLES.DISPATCH],
    label: "Control room selected a hospital",
    dispatchOverride: true,
  },
  "expand-radius": {
    from: [
      STATUS.PICKED_UP,
      STATUS.HOSPITAL_OFFERED,
      STATUS.TO_HOSPITAL,
      STATUS.CONTROL_ROOM_ESCALATION,
      STATUS.NO_HOSPITAL_AVAILABLE,
    ],
    roles: [ROLES.DISPATCH],
    label: "Control room expanded the search radius",
    expandRadius: true,
  },
};

/* ------------------------------------------------------------------ */
/* Demo assets (clearly labelled as simulated in the UI)               */
/* ------------------------------------------------------------------ */

const ambulances = [
  {
    id: "AMB-001",
    driver: "Rajesh Kumar",
    contact: "+91 90000 01001",
    vehicleNumber: "TS-09-AB-1234",
    location: { lat: 17.385, lng: 78.4867 },
    status: "AVAILABLE",
    type: "ALS",
    preferred: true,
  },
  {
    id: "AMB-002",
    driver: "Priya Sharma",
    contact: "+91 90000 01002",
    vehicleNumber: "TS-09-CD-5678",
    location: { lat: 17.44, lng: 78.35 },
    status: "AVAILABLE",
    type: "BLS",
  },
  {
    id: "AMB-003",
    driver: "Imran Khan",
    contact: "+91 90000 01003",
    vehicleNumber: "TS-09-EF-9101",
    location: { lat: 17.4034, lng: 78.4392 },
    status: "AVAILABLE",
    type: "BLS",
  },
];

const hospitals = [
  {
    id: "HOSP-001",
    name: "Apollo Emergency Center",
    emergencyContact: "+91 90000 02001",
    location: { lat: 17.4326, lng: 78.4071 },
    availableBeds: 15,
    dedicatedBeds: 6,
    emergencyBeds: 4,
    icuBeds: 6,
    emergencyCapacity: "HIGH",
    currentLoad: 62,
    acceptanceStatus: "OPEN",
    specialties: ["Cardiology", "Neurology", "Trauma"],
    specialists: ["Cardiologist", "Neurologist", "Trauma Surgeon"],
    specialistsSoon: [],
    equipment: ["Cardiac Monitor", "Defibrillator", "Ventilator", "CT Scanner", "Trauma Kit", "Blood Bank", "Oxygen Supply"],
    resourceLastUpdated: new Date().toISOString(),
  },
  {
    id: "HOSP-002",
    name: "CityCare Hospital",
    emergencyContact: "+91 90000 02002",
    location: { lat: 17.4239, lng: 78.4738 },
    availableBeds: 8,
    dedicatedBeds: 3,
    emergencyBeds: 3,
    icuBeds: 3,
    emergencyCapacity: "MEDIUM",
    currentLoad: 40,
    acceptanceStatus: "OPEN",
    specialties: ["Trauma", "Orthopedics"],
    specialists: ["Trauma Surgeon", "Orthopedic Surgeon"],
    specialistsSoon: [],
    equipment: ["Trauma Kit", "Ventilator", "X-Ray", "Oxygen Supply"],
    resourceLastUpdated: new Date().toISOString(),
  },
  {
    id: "HOSP-003",
    name: "Gandhi General Hospital",
    emergencyContact: "+91 90000 02003",
    location: { lat: 17.4484, lng: 78.4954 },
    availableBeds: 20,
    dedicatedBeds: 10,
    emergencyBeds: 6,
    icuBeds: 10,
    emergencyCapacity: "HIGH",
    currentLoad: 28,
    acceptanceStatus: "OPEN",
    specialties: ["General", "Emergency"],
    specialists: ["Emergency Physician", "General Surgeon"],
    specialistsSoon: ["Cardiologist"],
    equipment: ["Trauma Kit", "Ventilator", "CT Scanner", "Blood Bank", "Oxygen Supply", "Defibrillator"],
    resourceLastUpdated: new Date().toISOString(),
  },
  {
    id: "HOSP-004",
    name: "Sunrise Neuro Center",
    emergencyContact: "+91 90000 02004",
    location: { lat: 17.3951, lng: 78.4405 },
    availableBeds: 5,
    dedicatedBeds: 3,
    emergencyBeds: 2,
    icuBeds: 2,
    emergencyCapacity: "MEDIUM",
    currentLoad: 78,
    acceptanceStatus: "BYPASS",
    specialties: ["Neurology"],
    specialists: ["Neurologist", "Neuro Surgeon"],
    specialistsSoon: [],
    equipment: ["CT Scanner", "MRI", "Defibrillator"],
    resourceLastUpdated: new Date(Date.now() - 8 * 60000).toISOString(),
  },
  {
    id: "HOSP-005",
    name: "Greenfield Multispecialty",
    emergencyContact: "+91 90000 02005",
    location: { lat: 17.47, lng: 78.37 },
    availableBeds: 18,
    dedicatedBeds: 8,
    emergencyBeds: 5,
    icuBeds: 8,
    emergencyCapacity: "HIGH",
    currentLoad: 35,
    acceptanceStatus: "OPEN",
    specialties: ["Cardiology", "General", "Trauma"],
    specialists: ["Cardiologist", "General Surgeon", "Trauma Surgeon"],
    specialistsSoon: [],
    equipment: ["Cardiac Monitor", "Defibrillator", "Ventilator", "Trauma Kit", "Blood Bank", "CT Scanner"],
    resourceLastUpdated: new Date(Date.now() - 25 * 60000).toISOString(),
  },
];

/* ------------------------------------------------------------------ */
/* Demo citizen devices (in-memory registry, labelled SIMULATED)      */
/* ------------------------------------------------------------------ */

function seedCitizenDevices() {
  const devices = [];
  const anchors = [
    { lat: 17.428, lng: 78.42 },
    { lat: 17.435, lng: 78.44 },
    { lat: 17.445, lng: 78.47 },
    { lat: 17.415, lng: 78.46 },
    { lat: 17.45, lng: 78.43 },
  ];
  anchors.forEach((anchor, ai) => {
    for (let i = 0; i < 320; i++) {
      const lat = anchor.lat + (Math.random() - 0.5) * 0.05;
      const lng = anchor.lng + (Math.random() - 0.5) * 0.05;
      devices.push({
        id: `DEV-${ai}-${i}`,
        location: { lat, lng },
        simulated: true,
        notificationsEnabled: i % 4 !== 0,
      });
    }
  });
  return devices;
}

const SEVERITY_ORDER = { critical: 3, moderate: 2, minor: 1 };

const SEVERITY_TO_UNIT = { critical: "ALS", moderate: "BLS", minor: "BLS" };
const UNIT_TYPE_PENALTY = 2.5;
const PREFERRED_UNIT_BONUS = 1.2;
const BED_WEIGHT = 0.08;
const DEDICATED_BED_WEIGHT = 0.15;
const NEARLY_FULL_PENALTY = 4;

let CRASH_COUNTDOWN_MS = config.CRASH_DETECTION.countdownSeconds * 1000;
let AUTO_CANCEL_MS = 15000;

/* ---- configurable hospital request / acceptance windows ---- */
let HOSPITAL_REQUEST_MS = config.TIMEOUTS.hospitalRequestMs;
let ACCEPTANCE_WINDOW_MS = config.TIMEOUTS.acceptanceWindowMs;
let HOSPITAL_REQ_MIN = config.CRASH_DETECTION.countdownSeconds; // unused, kept for clarity
let FAKE_CANCEL_THRESHOLD = config.TIMEOUTS.cancelHistoryThreshold;
let FAKE_MIN_REPORT_INTERVAL_MS = config.TIMEOUTS.minReportIntervalMs;

/* ------------------------------------------------------------------ */
/* In-memory state                                                    */
/* ------------------------------------------------------------------ */

const state = {
  emergencies: new Map(),
  ambulances,
  hospitals,
  citizenDevices: seedCitizenDevices(),
  serial: 1,
  autoCancelTimers: new Map(),
  crashTimers: new Map(),
  hospitalTimers: new Map(),
  falseAlarms: new Map(),
  reporterStats: new Map(),
};

/* ------------------------------------------------------------------ */
/* Sound plans                                                        */
/* ------------------------------------------------------------------ */

function soundPlan(action, em) {
  const base = {
    click: false,
    source: "server",
    reason: TRANSITIONS[action] ? TRANSITIONS[action].label : action,
    emergencyId: em.emergencyId,
  };

  switch (action) {
    case "create":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER], reason: "Emergency registered" },
        { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.DISPATCH], reason: "New emergency reported" },
        em.ambulanceId
          ? { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.AMBULANCE], reason: "New ambulance request", detail: `Assigned ${em.ambulance.name}` }
          : null,
      ].filter(Boolean);

    case "accept":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH], reason: "Ambulance accepted the case" },
      ];

    case "reject":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH], reason: "Ambulance declined — case reassigned" },
      ];

    case "at-patient":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH], reason: "Ambulance has arrived at the patient" },
      ];

    case "pickup":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH, ROLES.HOSPITAL], reason: "Patient picked up — hospital offered" },
      ];

    case "request-hospital":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.AMBULANCE, ROLES.DISPATCH], reason: "Destination confirmed by operator" },
      ];

    case "accept-patient":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.AMBULANCE, ROLES.REPORTER, ROLES.DISPATCH], reason: "Hospital accepted the patient" },
      ];

    case "conditional-accept":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.AMBULANCE, ROLES.REPORTER, ROLES.DISPATCH], reason: "Hospital accepted with conditions" },
      ];

    case "reject-patient":
      return [
        { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.AMBULANCE], reason: "Hospital unavailable — rerouting patient" },
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH, ROLES.HOSPITAL], reason: "Hospital reassigned to next-best" },
      ];

    case "escalate":
      return [
        { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.DISPATCH], reason: "Control room intervention required" },
        { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.AMBULANCE], reason: "No accepting hospital found — control room notified" },
      ];

    case "dispatch-override":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.AMBULANCE, ROLES.DISPATCH, ROLES.HOSPITAL], reason: "Control room selected a destination" },
      ];

    case "arrived-hospital":
      return [
        { ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH, ROLES.HOSPITAL], reason: "Patient has arrived at the hospital" },
      ];

    case "complete":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: ["all"], reason: "Emergency resolved" }];

    case "handover":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH, ROLES.HOSPITAL], reason: "Patient handed over — admitted for treatment" }];

    case "confirm-patient-received":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH, ROLES.AMBULANCE], reason: "Hospital confirmed patient received" }];

    case "send-hospital-requests":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.AMBULANCE, ROLES.DISPATCH, ROLES.HOSPITAL], reason: "Admission requests sent to suitable hospitals" }];

    case "cancel-accept":
      return [{ ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.AMBULANCE, ROLES.DISPATCH, ROLES.HOSPITAL], reason: "Hospital cancelled acceptance — rerouting patient" }];

    case "discharge":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: ["all"], reason: "Patient discharged — case fully resolved" }];

    case "rate-hospital":
      return [{ ...base, sound: SOUND.QUIET, forRoles: [ROLES.REPORTER, ROLES.HOSPITAL, ROLES.DISPATCH], reason: "Hospital rated by patient/reporter" }];

    case "cancel":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: ["all"], reason: "Emergency cancelled" }];

    case "false-alarm":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: ["all"], reason: "False alarm — case cancelled" }];

    case "crash-detect":
      return [
        { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.REPORTER, ROLES.DISPATCH], reason: `Potential crash detected (confidence ${em.crashConfidence ?? 0}%)` },
      ];

    case "crash-confirm-safe":
      return [{ ...base, sound: SOUND.CONFIRM, forRoles: [ROLES.REPORTER, ROLES.DISPATCH], reason: "User OK — alert dismissed" }];

    case "crash-confirm-emergency":
      return [
        { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.DISPATCH], reason: "Unresponsive — emergency created" },
        em.ambulanceId
          ? { ...base, sound: SOUND.ATTENTION, forRoles: [ROLES.AMBULANCE], reason: "New ambulance request (crash detection)" }
          : null,
      ].filter(Boolean);

    default:
      return [{ ...base, sound: SOUND.QUIET, forRoles: ["all"] }];
  }
}

/* ------------------------------------------------------------------ */
/* Assignment helpers                                                  */
/* ------------------------------------------------------------------ */

function seedHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function trafficMultiplier(emergencyId, ambulanceId) {
  return 1 + (seedHash(emergencyId + ambulanceId) % 50) / 100;
}

function requiredUnit(em) {
  return SEVERITY_TO_UNIT[em.patient?.severity] || "BLS";
}

function ambulanceScore(em, a, distance) {
  const traffic = trafficMultiplier(em.emergencyId, a.id);
  let score = distance * traffic;
  if (a.type !== requiredUnit(em)) score += UNIT_TYPE_PENALTY;
  if (a.preferred) score -= PREFERRED_UNIT_BONUS;
  return { score, traffic };
}

function assignAmbulance(em, opts = {}) {
  const declined = em.declinedAmbulanceIds || [];
  const available = state.ambulances
    .filter((a) => a.status === "AVAILABLE" && !declined.includes(a.id))
    .map((a) => {
      const distance = calculateDistance(em.location.lat, em.location.lng, a.location.lat, a.location.lng);
      return { ambulance: a, distance, ...ambulanceScore(em, a, distance) };
    })
    .sort((x, y) => x.score - y.score);

  if (available.length === 0) {
    em.status = STATUS.NO_AMBULANCE_AVAILABLE;
    return false;
  }

  const { ambulance, distance, traffic } = available[0];
  em.ambulanceId = ambulance.id;
  em.ambulance = {
    id: ambulance.id,
    name: ambulance.driver,
    contact: ambulance.contact || null,
    vehicleNumber: ambulance.vehicleNumber,
    type: ambulance.type,
    liveLocation: { ...ambulance.location },
  };
  em.etaToPatient = calculateETA(distance);
  em.dispatchNote = `Unit ${ambulance.id} (${ambulance.type}) • ${distance.toFixed(1)}km × ${traffic.toFixed(2)} traffic • severity ${em.patient?.severity || "moderate"}`;
  ambulance.status = "DISPATCHED";
  ambulance.assignedEmergency = em.emergencyId;
  if (!opts.keepStatus) em.status = STATUS.AMBULANCE_OFFERED;
  return true;
}

/* ------------------------------------------------------------------ */
/* Hospital recommendations + assignment                              */
/* ------------------------------------------------------------------ */

function generateRecommendations(em) {
  const result = recommender.recommend(em, state.hospitals);
  em.hospitalRecommendations = result.recommendations;
  em.requiredSpecialty = result.requiredSpecialty;
  em.requiredEquipment = result.requiredEquipment;
  return result;
}

function assignHospital(em) {
  const result = generateRecommendations(em);
  const top = result.top;
  if (!top) {
    em.hospitalId = null;
    em.hospital = null;
    em.status = STATUS.NO_HOSPITAL_AVAILABLE;
    pushTimeline(em, ROLES.DISPATCH, "no-hospital", "No eligible hospital available within the current search radius");
    bus.emit("hospital:state", { emergencyId: em.emergencyId, noHospitalAvailable: true });
    return false;
  }

  const hospital = top.hospital;
  em.hospitalId = hospital.id;
  em.hospital = {
    id: hospital.id,
    name: hospital.name,
    emergencyContact: hospital.emergencyContact || null,
    specialties: hospital.specialties,
    specialists: hospital.specialists,
    availableBeds: hospital.availableBeds,
    emergencyBeds: hospital.emergencyBeds,
    icuBeds: hospital.icuBeds,
    emergencyCapacity: hospital.emergencyCapacity,
    currentLoad: hospital.currentLoad,
    liveLocation: { ...hospital.location },
    resourceLastUpdated: hospital.resourceLastUpdated,
  };
  em.etaToHospital = calculateETA(top.distance);
  em.recommendation = top;
  em.hospitalRequest = recordHospitalRequest(em, hospital.id, top, null);

  if (em.status !== STATUS.TO_HOSPITAL) {
    em.status = STATUS.HOSPITAL_OFFERED;
  }
  return true;
}

function recordHospitalRequest(em, hospitalId, recommendation, condition, opts = {}) {
  const req = {
    hospitalId,
    requestedAt: new Date().toISOString(),
    respondedAt: null,
    response: null,
    state: opts.state || "waiting", // waiting | accepted | rejected | expired | cancelled
    deadlineAt: opts.deadlineAt || null,
    conditions: condition || null,
    score: recommendation ? recommendation.score : null,
    scoreBreakdown: recommendation ? recommendation.scoreBreakdown : null,
    reasons: recommendation ? recommendation.reasons : [],
    eta: recommendation ? recommendation.eta : null,
    distance: recommendation ? recommendation.distance : null,
  };
  if (!em.hospitalRequests) em.hospitalRequests = [];
  em.hospitalRequests.push(req);
  return req;
}

/* -------------------- rejection + rerouting handling -------------------- */

function countRejections(em) {
  return (em.hospitalRequests || []).filter((r) => r.response === "reject").length;
}

function handleReroute(em, previousHospitalId, reasonData) {
  if (!em.rejectedHospitalIds) em.rejectedHospitalIds = [];
  if (previousHospitalId && !em.rejectedHospitalIds.includes(previousHospitalId)) {
    em.rejectedHospitalIds.push(previousHospitalId);
  }
  if (!em.offeredHospitalIds.includes(previousHospitalId)) {
    em.offeredHospitalIds.push(previousHospitalId);
  }

  const reasonLabel = reasonData?.reason ? reasonLabelFor(reasonData.reason) : "Operational reason";
  const detail = previousHospitalId
    ? `Hospital rejected — ${reasonLabel}`
    : "Hospital rejected — rerouting";

  const moved = assignHospital(em);
  const rejections = countRejections(em);

  if (moved && em.hospital) {
    pushTimeline(em, ROLES.HOSPITAL, "hospital-reassign", `Rerouting to next recommendation: ${em.hospital.name}`, { rejectReason: reasonData?.reason, rejectionCount: rejections }, { allowDuplicate: true });
    if (reasonData?.reason) {
      pushTimeline(em, ROLES.HOSPITAL, "hospital-reject", `Hospital unavailable — ${reasonLabel}`, {}, { allowDuplicate: true });
    }
  } else {
    em.status = STATUS.NO_HOSPITAL_AVAILABLE;
    pushTimeline(em, ROLES.DISPATCH, "no-hospital", "No eligible hospital available — control room escalation", { rejectionCount: rejections }, { allowDuplicate: true });
  }

  if (rejections >= config.HARD_CONSTRAINTS.maxRejectionsBeforeEscalation) {
    if (em.status !== STATUS.CONTROL_ROOM_ESCALATION) {
      em.status = STATUS.CONTROL_ROOM_ESCALATION;
      em.controlRoomEscalation = {
        triggeredAt: new Date().toISOString(),
        reason: `No suitable accepting hospital found within current search radius (${rejections} rejections)`,
        hospitalId: previousHospitalId,
      };
      pushTimeline(em, ROLES.DISPATCH, "escalate", "Control Room intervention required — no suitable accepting hospital found within current search radius", { rejectionCount: rejections });
      bus.emit("escalation:triggered", {
        emergencyId: em.emergencyId,
        emergency: snapshot(em),
        message: "No suitable accepting hospital found within current search radius",
      });
    }
  }

  return moved;
}

function reasonLabelFor(id) {
  const r = config.REJECT_REASONS.find((x) => x.id === id);
  return r ? r.label : "Operational reason";
}

/* -------------------- green corridor lifecycle -------------------- */

function activateGreenCorridor(em) {
  const users = state.citizenDevices.filter((d) => d.notificationsEnabled !== false);
  const current = corridor.computeCorridor(em, users, config.CORRIDOR_CONFIG.defaultWidthKm);
  if (!current) return null;
  em.greenCorridor = current;
  pushTimeline(em, "system", "corridor-activate", `Green corridor activated — ${current.notifiedUsers} nearby users notified`, {}, { allowDuplicate: true });
  bus.emit("corridor:updated", { emergencyId: em.emergencyId, corridor: current });
  bus.emit("green-corridor:alert", {
    corridor: current,
    notificationText: current.notificationText,
    emergency: snapshot(em),
  });
  return current;
}

function endGreenCorridor(em) {
  if (em.greenCorridor?.active) {
    em.greenCorridor = corridor.endCorridor();
    pushTimeline(em, "system", "corridor-end", "Green corridor ended", {}, { allowDuplicate: true });
    bus.emit("corridor:updated", { emergencyId: em.emergencyId, corridor: em.greenCorridor });
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function createEmergency({ kind, reporter, patient, location, confidence }) {
  if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
    throw Object.assign(new Error("A valid location (lat/lng) is required"), { code: "BAD_REQUEST" });
  }

  const now = new Date();
  const serialId = String(state.serial++).padStart(4, "0");
  const emergencyId = `EM-${serialId}`;
  const caseRef = `RR-${now.getFullYear()}-${serialId}`;

  const isCrash = kind === "CRASH_DETECTION";

  const em = {
    emergencyId,
    caseRef,
    kind: isCrash ? "CRASH_DETECTION" : kind || "SELF_USE",
    reporter: reporter || { name: "Anonymous", via: "self" },
    patient: {
      name: patient?.name || "Unknown",
      age: patient?.age ?? null,
      bloodGroup: patient?.bloodGroup || "Unknown",
      allergies: patient?.allergies || "None listed",
      condition: patient?.condition || "Emergency reported",
      severity: patient?.severity || "moderate",
      // Patient identification (bystander mode). The QR/scan only carries a
      // non-sensitive patient REFERENCE. Verification is resolved server-side.
      identificationMethod: patient?.identificationMethod || "UNKNOWN",
      patientId: patient?.patientId ?? null,
      verified: patient?.verified === true,
      verifiedAt: patient?.verified === true ? new Date().toISOString() : null,
    },
    aiDecisionLog: [],
    patientIdentifiedAt: null,
    location: { lat: location.lat, lng: location.lng, label: location.label || "Location confirmed" },
    status: isCrash ? STATUS.POTENTIAL_CRASH : STATUS.REPORTED,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ambulanceId: null,
    ambulance: null,
    hospitalId: null,
    hospital: null,
    etaToPatient: null,
    etaToHospital: null,
    offeredHospitalIds: [],
    rejectedHospitalIds: [],
    declinedAmbulanceIds: [],
    hospitalRequests: [],
    hospitalRecommendations: [],
    requiredSpecialty: null,
    requiredEquipment: [],
    recommendation: null,
    greenCorridor: null,
    driverStarted: false,
    crashConfidence: isCrash ? confidence ?? 80 : null,
    timeline: [],
    sirenOn: false,
    riskScore: 0,
    reportFlags: [],
  };

  state.emergencies.set(emergencyId, em);

  /* ---- fake-case mitigation: per-account risk score (fed by report history) ---- */
  em.riskScore = computeRiskScore(em);
  if (em.riskScore >= 40) {
    em.reportFlags.push("Repeated cancellation history");
  }
  if (em.riskScore >= 60) {
    em.reportFlags.push("Suspicious automated behavior");
  }
  trackReporter(em);
  if (em.reportFlags.length) {
    bus.emit("case:flagged", { emergencyId, caseRef: em.caseRef, flags: em.reportFlags, riskScore: em.riskScore, emergency: snapshot(em) });
  }

  if (isCrash) {
    em.status = STATUS.POTENTIAL_CRASH;
    pushTimeline(em, ROLES.REPORTER, "crash-detect", `Potential crash detected — confidence ${em.crashConfidence}%`, { confidence: em.crashConfidence, category: "crash" });
    pushTimeline(em, ROLES.REPORTER, "crash-countdown", `Verification countdown started (${CRASH_COUNTDOWN_MS / 1000}s) — awaiting confirmation`, {}, { allowDuplicate: true });
    scheduleCrashAutoConfirm(emergencyId);
  } else {
    pushTimeline(em, ROLES.REPORTER, "create", "Emergency reported");
    assignAmbulance(em);
    scheduleAutoCancel(emergencyId);
  }

  publish(em);
  bus.emit("sound:event", { sounds: soundPlan(isCrash ? "crash-detect" : "create", em), emergency: snapshot(em) });
  bus.emit("emergency:created", snapshot(em));
  return snapshot(em);
}

function applyAction(emergencyId, action, opts = {}) {
  const em = state.emergencies.get(emergencyId);
  if (!em) throw Object.assign(new Error(`Emergency ${emergencyId} not found`), { code: "NOT_FOUND" });

  const rule = TRANSITIONS[action];
  if (!rule) throw Object.assign(new Error(`Unknown action: ${action}`), { code: "BAD_REQUEST" });

  if (!rule.roles.includes(opts.role)) {
    throw Object.assign(new Error(`Role '${opts.role}' is not allowed to perform '${action}'`), { code: "FORBIDDEN" });
  }

  if (rule.terminal) {
    if (em.status === STATUS.COMPLETED || em.status === STATUS.CANCELLED || em.status === STATUS.USER_CONFIRMED_SAFE) return snapshot(em);
  }

  // crash-detect is special: it is only triggered via createEmergency kind CRASH_DETECTION.
  if (action === "crash-detect") {
    throw Object.assign(new Error("Use CRASH_DETECTION on create to start a crash flow"), { code: "BAD_REQUEST" });
  }

  if (!rule.from.includes(em.status)) {
    throw Object.assign(
      new Error(`Cannot '${action}' while status is '${em.status}' (${rule.label})`),
      { code: "INVALID_STATE", currentStatus: em.status }
    );
  }

  if (rule.roles.includes(ROLES.AMBULANCE) && opts.ambulanceId && opts.ambulanceId !== em.ambulanceId) {
    throw Object.assign(new Error("This ambulance is not assigned to the emergency"), { code: "FORBIDDEN" });
  }

  // A hospital acting on a case must either be the assigned destination OR have
  // a pending (WAITING) admission request for it (required for parallel
  // admission requests where any of the requested hospitals can become the
  // destination by being the first to accept).
  if (rule.roles.includes(ROLES.HOSPITAL) && opts.hospitalId && opts.hospitalId !== em.hospitalId) {
    const pending = (em.hospitalRequests || []).some(
      (r) => r.hospitalId === opts.hospitalId && (r.state === "waiting" || r.state === "accepted")
    );
    if (!pending) {
      throw Object.assign(new Error("This hospital is not the assigned destination or a pending admission request was not found"), { code: "FORBIDDEN" });
    }
  }

  // ---------- hospital request validation ----------
  if (rule.requestHospital) {
    if (!opts.hospitalId) {
      throw Object.assign(new Error("A hospitalId is required to request admission"), { code: "BAD_REQUEST" });
    }
    const rec = (em.hospitalRecommendations || []).find((r) => r.hospital.id === opts.hospitalId);
    if (!rec) throw Object.assign(new Error("Hospital is not in the current recommendations"), { code: "BAD_REQUEST" });
    if (!rec.eligible) throw Object.assign(new Error("Requested hospital is ineligible for this emergency"), { code: "FORBIDDEN" });
    em.hospitalRequest = recordHospitalRequest(em, opts.hospitalId, rec, null);
    em.hospitalId = opts.hospitalId;
    const h = state.hospitals.find((x) => x.id === opts.hospitalId);
    em.hospital = hospitalSnapshotOf(h);
    em.etaToHospital = calculateETA(rec.distance);
    em.recommendation = rec;
    if (em.status !== STATUS.TO_HOSPITAL && em.status !== STATUS.HOSPITAL_ACCEPTED) em.status = STATUS.HOSPITAL_OFFERED;
    pushTimeline(em, opts.role, "hospital-request", `Admission requested at ${h.name} by authorized operator`, {}, { allowDuplicate: true });
  }

  // ---------- reject-patient reason validation ----------
  if (action === "reject-patient") {
    if (!opts.rejectReason) {
      throw Object.assign(new Error("A legitimate operational reject reason is required"), { code: "BAD_REQUEST" });
    }
    const valid = config.REJECT_REASONS.some((r) => r.id === opts.rejectReason);
    if (!valid) {
      throw Object.assign(new Error("Reject reason is not from the authorized list"), { code: "BAD_REQUEST" });
    }
  }

  // ---------- conditional-accept requires conditions ----------
  if (action === "conditional-accept") {
    if (!opts.conditions || !String(opts.conditions).trim()) {
      throw Object.assign(new Error("A condition/limitation is required for a conditional accept"), { code: "BAD_REQUEST" });
    }
  }

  const previousHospitalId = em.hospitalId;
  const previousAmbulanceId = em.ambulanceId;

  // Validate the driver's navigate target BEFORE any status mutation so a failed
  // navigation cannot leave the case half-transitioned.
  if (rule.navigate) {
    if (!opts.hospitalId) {
      throw Object.assign(new Error("A hospitalId is required to start navigation"), { code: "BAD_REQUEST" });
    }
    const hasAccepted = (em.hospitalRequests || []).some(
      (r) => r.hospitalId === opts.hospitalId && r.state === "accepted"
    );
    if (!hasAccepted) {
      throw Object.assign(new Error("Cannot navigate to a hospital that has not accepted the patient"), { code: "FORBIDDEN" });
    }
  }

  if (rule.to) {
    em.status = rule.to;
  }
  if (rule.handover) em.handover = true;

  em.updatedAt = new Date().toISOString();
  pushTimeline(em, opts.role, action, rule.label, { actor: opts.actor, category: categoryFor(action) });

  /* ---- crash confirmation: convert to a normal emergency ---- */
  if (rule.crashConfirm) {
    clearCrashTimer(emergencyId);
    em.status = STATUS.CONFIRMED_EMERGENCY;
    pushTimeline(em, opts.role, "crash-confirmed", "Crash confirmed — creating emergency case", { category: "crash" }, { allowDuplicate: true });
    em.status = STATUS.REPORTED;
    assignAmbulance(em);
    if (!em.ambulanceId) {
      em.status = STATUS.NO_AMBULANCE_AVAILABLE;
    }
    pushTimeline(em, "system", "create", "Emergency case created from crash detection", { category: "crash" }, { allowDuplicate: true });
    scheduleAutoCancel(emergencyId);
  }

  if (rule.reassignAmbulance) {
    if (!em.declinedAmbulanceIds) em.declinedAmbulanceIds = [];
    if (previousAmbulanceId) em.declinedAmbulanceIds.push(previousAmbulanceId);
    markAmbulanceAvailable(previousAmbulanceId);
    em.ambulanceId = null;
    em.ambulance = null;
    em.etaToPatient = null;
    const reassigned = assignAmbulance(em);
    pushTimeline(em, opts.role, "reassign", reassigned ? `Reassigned to ${em.ambulance.name}` : "No ambulance available — searching", {}, { allowDuplicate: true });
    if (!reassigned) {
      em.status = STATUS.NO_AMBULANCE_AVAILABLE;
      em.updatedAt = new Date().toISOString();
    }
    bus.emit("dispatch:reassigned", {
      emergencyId: em.emergencyId,
      ambulanceId: em.ambulanceId,
      actor: opts.actor || opts.role,
      emergency: snapshot(em),
    });
  }

  if (rule.assignHospital) {
    const assigned = assignHospital(em);
    pushTimeline(em, opts.role, "hospital-offer", assigned && em.hospital
      ? `Hospital recommended: ${em.hospital.name} (score ${em.recommendation?.score ?? "?"})`
      : "No eligible hospital available", {}, { allowDuplicate: true });
    bus.emit("recommendations:updated", { emergencyId: em.emergencyId, emergency: snapshot(em) });
  }

  if (rule.hospitalResponse) {
    const req = (em.hospitalRequests || []).find((r) => r.hospitalId === opts.hospitalId);
    if (req) {
      req.response = rule.hospitalResponse;
      req.state = rule.hospitalResponse === "accept" || rule.hospitalResponse === "conditional-accept"
        ? "accepted" : "rejected";
      req.respondedAt = new Date().toISOString();
      if (action === "conditional-accept") req.conditions = opts.conditions;
      if (action === "reject-patient") req.rejectReason = opts.rejectReason;
    }
  }

  /* ---- MULTI-HOSPITAL ACCEPT (driver picks via navigate) ----
     Any requested hospital may accept and REMAIN in "accepted" state. Several
     hospitals can be accepted at the same time; the DRIVER decides which becomes
     the final destination by tapping Navigate on one of them. Until then the case
     sits in HOSPITAL_ACCEPTED awaiting the driver's acknowledgement. */
  if (rule.acceptPatient) {
    const req = (em.hospitalRequests || []).find((r) => r.hospitalId === opts.hospitalId);
    if (req) req.state = "accepted";
    em.hospitalId = null;
    em.hospital = null;
    em.etaToHospital = null;
    em.admissionLocked = false;
    em.acceptanceWindowUntil = new Date(Date.now() + ACCEPTANCE_WINDOW_MS).toISOString();
    clearHospitalRequestTimer(emergencyId);
    bus.emit("hospital:accepted", { emergencyId: em.emergencyId, hospitalId: opts.hospitalId, emergency: snapshot(em) });
    bus.emit("recommendations:updated", { emergencyId: em.emergencyId, emergency: snapshot(em) });
  }

  /* ---- DRIVER NAVIGATE: locks a chosen accepted hospital + starts move ----
     The driver acknowledges an accepted hospital and starts navigation. This is
     the single moment that turns a set of accepted hospitals into ONE destination
     and notifies that hospital that the ambulance has started its journey. */
  if (rule.navigate) {
    const rec = (em.hospitalRecommendations || []).find((r) => r.hospital.id === opts.hospitalId);
    em.hospitalId = opts.hospitalId;
    em.hospital = hospitalSnapshotOf(state.hospitals.find((x) => x.id === opts.hospitalId));
    em.etaToHospital = rec ? calculateETA(rec.distance)
      : calculateETA(calculateDistance(em.location.lat, em.location.lng, em.hospital.liveLocation.lat, em.hospital.liveLocation.lng));
    em.recommendation = rec;
    em.driverStarted = true;
    em.admissionLocked = true;
    em.acceptanceWindowUntil = null;
    // Cancel the accepts we did NOT choose so every other hospital sees it is off.
    (em.hospitalRequests || []).forEach((r) => {
      if (r.hospitalId !== opts.hospitalId && r.state === "accepted") {
        r.state = "cancelled";
        r.respondedAt = new Date().toISOString();
      }
    });
    clearHospitalRequestTimer(emergencyId);
    activateGreenCorridor(em);
    pushTimeline(em, opts.role, "driver-start", `Driver started navigation to ${em.hospital.name}`, { actor: opts.actor }, { allowDuplicate: true });
    bus.emit("hospital:driver-started", { emergencyId: em.emergencyId, hospitalId: em.hospitalId, ambulanceId: em.ambulanceId, emergency: snapshot(em) });
  }

  /* ---- 60s cancellation window (1 min from accepting): reroute ---- */
  if (rule.cancelAccept) {
    if (em.admissionLocked) {
      throw Object.assign(new Error("Admission is locked — only control room override can reroute"), { code: "FORBIDDEN" });
    }
    if (em.acceptanceWindowUntil && Date.now() > new Date(em.acceptanceWindowUntil).getTime()) {
      em.admissionLocked = true;
      throw Object.assign(new Error("Confirmation window has expired — admission locked"), { code: "INVALID_STATE", currentStatus: em.status });
    }
    const cancellingId = opts.hospitalId || previousHospitalId;
    const req = (em.hospitalRequests || []).find((r) => r.hospitalId === cancellingId);
    if (req) {
      req.state = "cancelled";
      req.respondedAt = new Date().toISOString();
    }
    em.acceptanceWindowUntil = null;
    handleReroute(em, cancellingId, { reason: "CANCELLED_WITHIN_WINDOW" });
    bus.emit("hospital:rejected", { emergencyId: em.emergencyId, hospitalId: cancellingId, reason: "CANCELLED_WITHIN_WINDOW", emergency: snapshot(em) });
    bus.emit("recommendations:updated", { emergencyId: em.emergencyId, emergency: snapshot(em) });
  }

  /* ---- PARALLEL admission requests (WAITING) to top suitable hospitals ---- */
  if (rule.sendHospitalRequests) {
    const eligible = (em.hospitalRecommendations || [])
      .filter((r) => r.eligible && !(em.rejectedHospitalIds || []).includes(r.hospital.id))
      .slice(0, 3);
    const deadlineAt = new Date(Date.now() + HOSPITAL_REQUEST_MS).toISOString();
    eligible.forEach((rec, idx) => {
      const existing = (em.hospitalRequests || []).find((r) => r.hospitalId === rec.hospital.id && r.state === "waiting");
      if (existing) return;
      const req = recordHospitalRequest(em, rec.hospital.id, rec, null, { state: "waiting", deadlineAt });
      if (idx === 0) {
        // First eligible hospital becomes the tentative destination while requests wait.
        em.hospitalId = rec.hospital.id;
        em.hospital = hospitalSnapshotOf(state.hospitals.find((x) => x.id === rec.hospital.id));
        em.etaToHospital = calculateETA(rec.distance);
        em.recommendation = rec;
      }
    });
    if (em.status !== STATUS.TO_HOSPITAL && em.status !== STATUS.HOSPITAL_ACCEPTED) em.status = STATUS.HOSPITAL_OFFERED;
    scheduleHospitalRequestTimeout(em);
    pushTimeline(em, opts.role, "hospital-request",
      `Admission requests sent to ${eligible.length} suitable hospitals — awaiting acceptance`, {}, { allowDuplicate: true });
  }

  if (rule.reassignHospital) {
    handleReroute(em, previousHospitalId, { reason: opts.rejectReason });
    const rerouteDetail = em.recommendation && em.hospital
      ? `Hospital unavailable — rerouting to ${em.hospital.name}`
      : "Hospital unavailable — rerouting patient";
    bus.emit("hospital:rejected", {
      emergencyId: em.emergencyId,
      hospitalId: previousHospitalId,
      reason: opts.rejectReason || null,
      reasonLabel: opts.rejectReason ? reasonLabelFor(opts.rejectReason) : null,
      nextHospitalId: em.hospitalId,
      emergency: snapshot(em),
    });
    bus.emit("recommendations:updated", { emergencyId: em.emergencyId, emergency: snapshot(em) });
  }

  if (rule.dispatchOverride) {
    const h = state.hospitals.find((x) => x.id === opts.hospitalId);
    if (!h) throw Object.assign(new Error("Specified hospital not found"), { code: "NOT_FOUND" });
    em.hospitalId = h.id;
    em.hospital = hospitalSnapshotOf(h);
    em.hospitalRequest = recordHospitalRequest(em, h.id, null, null);
    em.etaToHospital = calculateETA(calculateDistance(em.location.lat, em.location.lng, h.location.lat, h.location.lng));
    em.controlRoomEscalation = null;
    em.status = STATUS.HOSPITAL_OFFERED;
    pushTimeline(em, ROLES.DISPATCH, "dispatch-override", `Control room selected ${h.name}`, { actor: opts.actor }, { allowDuplicate: true });
  }

  if (rule.expandRadius) {
    const previous = em.offeredHospitalIds || [];
    const eligible = state.hospitals.filter((h) => !previous.includes(h.id));
    if (eligible.length > 0) {
      const result = assignHospital(em);
      if (result) {
        pushTimeline(em, ROLES.DISPATCH, "radius-expand", `Search radius expanded — recommended ${em.hospital.name}`, {}, { allowDuplicate: true });
      } else {
        em.status = STATUS.NO_HOSPITAL_AVAILABLE;
      }
    } else {
      em.status = STATUS.NO_HOSPITAL_AVAILABLE;
    }
    if (!em.hospitalId) {
      pushTimeline(em, ROLES.DISPATCH, "no-hospital", "No accepting hospital found — control room monitoring", {}, { allowDuplicate: true });
    }
  }

  if (rule.updateResources) {
    const h = state.hospitals.find((x) => x.id === opts.hospitalId);
    if (!h) throw Object.assign(new Error("Hospital not found"), { code: "NOT_FOUND" });
    const patch = opts.resources || {};
    if (typeof patch.emergencyBeds === "number") h.emergencyBeds = Math.max(0, patch.emergencyBeds);
    if (typeof patch.availableBeds === "number") h.availableBeds = Math.max(0, patch.availableBeds);
    if (typeof patch.currentLoad === "number") h.currentLoad = Math.max(0, Math.min(100, patch.currentLoad));
    if (Array.isArray(patch.equipment)) h.equipment = patch.equipment;
    h.resourceLastUpdated = new Date().toISOString();
    pushTimeline(em, opts.role, "resources-updated", `${h.name} resource data refreshed`, {}, { allowDuplicate: true });
    bus.emit("hospital:resources", { hospitalId: h.id, hospital: h, at: new Date().toISOString() });
  }

  /* ---- green corridor activates when the DRIVER starts navigation ---- */

  if (action === "false-alarm") logFalseAlarm(em);

  // Repeated cancellations feed the fake-case risk score (advisory only).
  if ((em.status === STATUS.CANCELLED) && !["false-alarm"].includes(action)) {
    const key = reporterAccountKey(em);
    const r = state.reporterStats.get(key) || { cancels: 0 };
    r.cancels = (r.cancels || 0) + 1;
    state.reporterStats.set(key, r);
  }

  if (!isUnconfirmed(em) || ["COMPLETED", "CANCELLED", "USER_CONFIRMED_SAFE"].includes(em.status)) {
    clearAutoCancelTimer(emergencyId);
  } else if (rule.reassignAmbulance) {
    scheduleAutoCancel(emergencyId);
  }

  /* ---- reporter/patient rates the hospital (feedback, non-transitional) ---- */
  if (rule.rateHospital) {
    const score = opts.rating != null ? Number(opts.rating) : null;
    if (score != null && (score < 1 || score > 5)) {
      throw Object.assign(new Error("Rating must be a number between 1 and 5"), { code: "BAD_REQUEST" });
    }
    em.hospitalRating = {
      score,
      comment: opts.ratingComment || "",
      categories: opts.ratingCategories || {},
      ratedBy: opts.role || "reporter",
      ratedAt: new Date().toISOString(),
    };
    pushTimeline(em, opts.role, "hospital-rated", `Patient/reporter rated the hospital ${score != null ? `${score}/5` : ""}`, {}, { allowDuplicate: true });
  }

  if (rule.endCorridor) {
    endGreenCorridor(em);
  }

  /* Handing the patient over frees the ambulance for the next case, but the
     case stays LIVE (IN_TREATMENT) until the hospital discharges the patient. */
  if (em.status === STATUS.IN_TREATMENT || (["COMPLETED", "CANCELLED", "USER_CONFIRMED_SAFE"].includes(em.status) && rule.terminal)) {
    if (em.ambulanceId) markAmbulanceAvailable(em.ambulanceId);
    em.sirenOn = false;
  }

  if (em.status === STATUS.ARRIVED_AT_HOSPITAL || em.status === STATUS.IN_TREATMENT) {
    endGreenCorridor(em);
  }

  /* Hospital request timeout no longer relevant once the patient has a confirmed
     destination / is in treatment / case is terminal. */
  if (em.status === STATUS.TO_HOSPITAL || em.status === STATUS.ARRIVED_AT_HOSPITAL || em.status === STATUS.IN_TREATMENT
      || ["COMPLETED", "CANCELLED", "USER_CONFIRMED_SAFE"].includes(em.status)) {
    clearHospitalRequestTimer(emergencyId);
  }

  publish(em);
  bus.emit("sound:event", { sounds: soundPlan(action, em), emergency: snapshot(em) });
  return snapshot(em);
}

function categoryFor(action) {
  if (["crash-detect", "crash-confirm-safe", "crash-confirm-emergency", "crash-confirmed"].includes(action)) return "crash";
  if (["accept-patient", "conditional-accept", "reject-patient", "update-resources", "hospital-reject", "hospital-offer", "discharge", "handover", "cancel-accept", "confirm-patient-received", "send-hospital-requests", "hospital-req-expired"].includes(action)) return "hospital";
  if (["accept", "reject", "at-patient", "pickup", "arrived-hospital", "request-hospital"].includes(action)) return "ambulance";
  if (["escalate", "dispatch-override", "expand-radius", "false-alarm", "cancel", "complete"].includes(action)) return "control";
  if (["create", "hospital-reassign", "reassign", "corridor-activate", "corridor-end", "no-hospital", "radius-expand", "resources-updated", "auto-cancel", "siren-on", "siren-off", "hospital-rated"].includes(action)) return "system";
  return "system";
}

function hospitalSnapshotOf(h) {
  if (!h) return null;
  return {
    id: h.id,
    name: h.name,
    emergencyContact: h.emergencyContact || null,
    specialties: h.specialties,
    specialists: h.specialists,
    availableBeds: h.availableBeds,
    emergencyBeds: h.emergencyBeds,
    icuBeds: h.icuBeds,
    emergencyCapacity: h.emergencyCapacity,
    currentLoad: h.currentLoad,
    liveLocation: { ...h.location },
    resourceLastUpdated: h.resourceLastUpdated,
  };
}

function missingEquipmentFor(em) {
  const eq = recommender.requiredEquipment(em);
  return eq.filter((e) => !em.hospital?.equipment?.includes(e));
}

/* ------------------------------------------------------------------ */
/* Siren + simulated ambulance movement                                */
/* ------------------------------------------------------------------ */

function toggleSiren({ ambulanceId, emergencyId, on }) {
  const em = state.emergencies.get(emergencyId) || findEmergencyByAmbulance(ambulanceId);
  if (!em) throw Object.assign(new Error("No active emergency for this ambulance"), { code: "NOT_FOUND" });

  if (em.ambulanceId !== ambulanceId) {
    throw Object.assign(new Error("This ambulance is not assigned to the emergency"), { code: "FORBIDDEN" });
  }

  em.sirenOn = typeof on === "boolean" ? on : !em.sirenOn;
  pushTimeline(em, ROLES.AMBULANCE, em.sirenOn ? "siren-on" : "siren-off", em.sirenOn ? "Siren activated — nearby drivers alerted" : "Siren off");

  const payload = {
    on: em.sirenOn,
    ambulanceId,
    emergencyId: em.emergencyId,
    location: em.ambulance?.liveLocation || em.location,
    at: new Date().toISOString(),
  };

  bus.emit("siren:changed", payload);
  publish(em);
  return payload;
}

function moveAmbulance({ ambulanceId, lat, lng }) {
  const a = state.ambulances.find((x) => x.id === ambulanceId);
  if (!a) throw Object.assign(new Error("Ambulance not found"), { code: "NOT_FOUND" });

  a.location = { lat, lng };
  a.liveLocation = { lat, lng };

  for (const em of state.emergencies.values()) {
    if (em.ambulanceId === ambulanceId && em.ambulance) {
      em.ambulance.liveLocation = { lat, lng };
      em.updatedAt = new Date().toISOString();
      const distance = calculateDistance(em.location.lat, em.location.lng, lat, lng);
      em.etaToPatient = distance > 0.15 ? calculateETA(distance) : null;
    }
  }

  bus.emit("ambulance:moved", { ambulanceId, location: { lat, lng }, at: new Date().toISOString() });
  return { ambulanceId, location: { lat, lng } };
}

/* ------------------------------------------------------------------ */
/* Citizen device registration (green corridor awareness)             */
/* ------------------------------------------------------------------ */

function registerCitizen(citizen) {
  if (!state.citizens) state.citizens = new Map();
  state.citizens.set(citizen.deviceId || citizen.socketId, {
    deviceId: citizen.deviceId || citizen.socketId,
    location: citizen.location || { lat: 17.42, lng: 78.44 },
    notificationsEnabled: citizen.notificationsEnabled !== false,
    registeredAt: new Date().toISOString(),
  });
  return state.citizens.size;
}

function unregisterCitizen(socketId) {
  if (state.citizens) state.citizens.delete(socketId);
}

function listCitizens() {
  return state.citizens ? [...state.citizens.values()] : [];
}

function corridorForEmergency(emergencyId) {
  const em = state.emergencies.get(emergencyId);
  if (!em) throw Object.assign(new Error("Emergency not found"), { code: "NOT_FOUND" });
  return {
    emergencyId: em.emergencyId,
    corridor: em.greenCorridor || null,
    status: em.greenCorridor?.status || "NONE",
  };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

function listEmergencies(opts = {}) {
  let list = [...state.emergencies.values()];
  if (opts.status) list = list.filter((e) => e.status === opts.status);
  if (opts.activeOnly) list = list.filter((e) => !["COMPLETED", "CANCELLED", "USER_CONFIRMED_SAFE"].includes(e.status));
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(snapshot);
}

function getEmergency(emergencyId) {
  const em = state.emergencies.get(emergencyId);
  return em ? snapshot(em) : null;
}

/**
 * Emergencies for which `hospitalId` currently has a WAITING admission request
 * — including cases where it is not yet the tentative destination (used by the
 * hospital UI to surface parallel admission requests and let it accept, which
 * flips it to the confirmed destination via first-accept-wins).
 */
function listAdmissionRequests(hospitalId) {
  const list = [...state.emergencies.values()].filter(
    (e) =>
      !["COMPLETED", "CANCELLED", "USER_CONFIRMED_SAFE"].includes(e.status) &&
      (e.hospitalRequests || []).some((r) => r.hospitalId === hospitalId && r.state === "waiting")
  );
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(snapshot);
}

function getRecommendations(emergencyId) {
  const em = state.emergencies.get(emergencyId);
  if (!em) throw Object.assign(new Error("Emergency not found"), { code: "NOT_FOUND" });
  return {
    emergencyId: em.emergencyId,
    recommendations: (em.hospitalRecommendations || []).map((r) => ({
      rank: r.rank,
      eligible: r.eligible,
      score: r.score,
      scoreBreakdown: r.scoreBreakdown,
      reasons: r.reasons,
      problems: r.problems,
      distance: r.distance,
      eta: r.eta,
      freshness: r.freshness,
      staleMinutes: r.staleMinutes,
      hospital: {
        id: r.hospital.id,
        name: r.hospital.name,
        distance: r.distance,
        eta: r.eta,
        emergencyBeds: r.hospital.emergencyBeds,
        emergencyCapacity: r.hospital.emergencyCapacity,
        currentLoad: r.hospital.currentLoad,
        acceptanceStatus: r.hospital.acceptanceStatus,
        specialties: r.hospital.specialties,
        specialists: r.hospital.specialists,
        equipment: r.hospital.equipment,
        resourceLastUpdated: r.hospital.resourceLastUpdated,
      },
    })),
    requiredSpecialty: em.requiredSpecialty,
    requiredEquipment: em.requiredEquipment,
  };
}

function listAmbulances() {
  return state.ambulances.map((a) => ({
    id: a.id,
    driver: a.driver,
    vehicleNumber: a.vehicleNumber,
    type: a.type,
    location: { ...a.location },
    status: a.status,
    assignedEmergency: a.assignedEmergency || null,
  }));
}

function listHospitals() {
  return state.hospitals.map((h) => ({
    ...h,
    location: { ...h.location },
    freshness: resourceFreshness(h),
  }));
}

function resourceFreshness(h) {
  const minutes = h.resourceLastUpdated
    ? Math.max(0, (Date.now() - new Date(h.resourceLastUpdated).getTime()) / 60000)
    : 0;
  if (minutes <= config.HARD_CONSTRAINTS.staleDataThresholdMinutes) return "LIVE";
  if (minutes <= config.HARD_CONSTRAINTS.veryStaleDataThresholdMinutes) return "RECENT";
  return "STALE";
}

function metrics() {
  const list = [...state.emergencies.values()];
  const activeCases = list.filter((e) => !["COMPLETED", "CANCELLED", "USER_CONFIRMED_SAFE"].includes(e.status)).length;

  let responseMs = 0;
  let samples = 0;
  for (const em of list) {
    const accept = em.timeline.find((t) => t.action === "accept");
    if (accept) {
      responseMs += new Date(accept.at).getTime() - new Date(em.createdAt).getTime();
      samples += 1;
    }
  }

  const sirenActivations = list.reduce(
    (n, em) => n + em.timeline.filter((t) => t.action === "siren-on").length,
    0
  );

  return {
    activeCases,
    avgResponseSeconds: samples ? Math.round(responseMs / samples / 1000) : null,
    responseSamples: samples,
    sirenActivations,
    falseAlarms: [...state.falseAlarms.values()].reduce((n, r) => n + r.count, 0),
  };
}

function listFalseAlarms() {
  return [...state.falseAlarms.entries()]
    .map(([account, rec]) => ({ account, count: rec.count, lastAt: rec.lastAt }))
    .sort((a, b) => b.count - a.count);
}

function registerDriver(driver) {
  if (!state.drivers) state.drivers = new Map();
  state.drivers.set(driver.socketId, {
    name: driver.name || "Nearby driver",
    location: driver.location || { lat: 17.42, lng: 78.44 },
    registeredAt: new Date().toISOString(),
  });
  return state.drivers.size;
}

function unregisterDriver(socketId) {
  if (state.drivers) state.drivers.delete(socketId);
}

function listDrivers() {
  return state.drivers ? [...state.drivers.values()] : [];
}

function listCitizenNotifications() {
  return state.citizens ? [...state.citizens.values()] : [];
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function markAmbulanceAvailable(ambulanceId) {
  const a = state.ambulances.find((x) => x.id === ambulanceId);
  if (a) {
    a.status = "AVAILABLE";
    a.assignedEmergency = null;
  }
}

function findEmergencyByAmbulance(ambulanceId) {
  for (const em of state.emergencies.values()) {
    if (em.ambulanceId === ambulanceId && !["COMPLETED", "CANCELLED", "USER_CONFIRMED_SAFE"].includes(em.status)) {
      return em;
    }
  }
  return null;
}

const UNCONFIRMED_STATUSES = [STATUS.REPORTED, STATUS.AMBULANCE_OFFERED];

function isUnconfirmed(em) {
  return UNCONFIRMED_STATUSES.includes(em.status);
}

function clearAutoCancelTimer(emergencyId) {
  const t = state.autoCancelTimers.get(emergencyId);
  if (t) {
    clearTimeout(t);
    state.autoCancelTimers.delete(emergencyId);
  }
}

function scheduleAutoCancel(emergencyId) {
  clearAutoCancelTimer(emergencyId);
  state.autoCancelTimers.set(
    emergencyId,
    setTimeout(() => autoCancel(emergencyId), AUTO_CANCEL_MS)
  );
}

function autoCancel(emergencyId) {
  state.autoCancelTimers.delete(emergencyId);
  const em = state.emergencies.get(emergencyId);
  if (!em || !isUnconfirmed(em)) return;

  em.status = STATUS.CANCELLED;
  em.updatedAt = new Date().toISOString();
  em.sirenOn = false;
  if (em.ambulanceId) markAmbulanceAvailable(em.ambulanceId);
  pushTimeline(em, ROLES.DISPATCH, "auto-cancel", `Auto-cancelled — no confirmation within ${AUTO_CANCEL_MS / 1000}s`);

  publish(em);
  bus.emit("sound:event", { sounds: soundPlan("cancel", em), emergency: snapshot(em) });
}

/* ---------------- crash countdown auto-confirmation ---------------- */

function scheduleCrashAutoConfirm(emergencyId) {
  clearCrashTimer(emergencyId);
  state.crashTimers.set(
    emergencyId,
    setTimeout(() => {
      state.crashTimers.delete(emergencyId);
      const em = state.emergencies.get(emergencyId);
      if (!em || !["POTENTIAL_CRASH", "USER_CONFIRMATION"].includes(em.status)) return;
      try {
        applyAction(emergencyId, "crash-confirm-emergency", { role: ROLES.REPORTER, actor: "auto (countdown)" });
      } catch {
        /* no-op */
      }
    }, CRASH_COUNTDOWN_MS)
  );
}

function clearCrashTimer(emergencyId) {
  const t = state.crashTimers.get(emergencyId);
  if (t) {
    clearTimeout(t);
    state.crashTimers.delete(emergencyId);
  }
}

/* ---------------- hospital request timeout (WAITING → EXPIRED) ---------------- */

function scheduleHospitalRequestTimeout(em) {
  clearHospitalRequestTimer(em.emergencyId);
  const pending = (em.hospitalRequests || []).some((r) => r.state === "waiting");
  if (!pending) return;
  state.hospitalTimers.set(
    em.emergencyId,
    setTimeout(() => expireHospitalRequests(em.emergencyId), HOSPITAL_REQUEST_MS)
  );
}

function clearHospitalRequestTimer(emergencyId) {
  const t = state.hospitalTimers.get(emergencyId);
  if (t) {
    clearTimeout(t);
    state.hospitalTimers.delete(emergencyId);
  }
}

function expireHospitalRequests(emergencyId) {
  state.hospitalTimers.delete(emergencyId);
  const em = state.emergencies.get(emergencyId);
  if (!em) return;
  let expiredAny = false;
  (em.hospitalRequests || []).forEach((r) => {
    if (r.state === "waiting") {
      r.state = "expired";
      r.respondedAt = new Date().toISOString();
      expiredAny = true;
    }
  });
  if (!expiredAny) return;

  const stillWaitingOrAccepted = (em.hospitalRequests || []).some(
    (r) => r.state === "waiting" || r.state === "accepted"
  );
  if (stillWaitingOrAccepted || em.hospitalId) {
    // A hospital accepted or is still being offered — no escalation needed.
    if (em.status !== STATUS.TO_HOSPITAL) publish(em);
    return;
  }

  pushTimeline(em, ROLES.DISPATCH, "hospital-req-expired", "Hospital admission requests expired without acceptance — searching again", { allowDuplicate: true });
  // Try to re-offer; escalate if nothing responds.
  const moved = assignHospital(em);
  if (!moved || !em.hospital) {
    em.status = STATUS.CONTROL_ROOM_ESCALATION;
    em.controlRoomEscalation = {
      triggeredAt: new Date().toISOString(),
      reason: "No hospital responded to admission requests within the timeout window",
    };
    pushTimeline(em, ROLES.DISPATCH, "escalate", "CRITICAL ESCALATION — no hospital has confirmed admission", { allowDuplicate: true });
    bus.emit("escalation:triggered", { emergencyId: em.emergencyId, emergency: snapshot(em), message: "No hospital confirmed admission within timeout" });
  }
  publish(em);
}

function reporterAccountKey(em) {
  return em.reporter?.username || em.reporter?.name || "unknown";
}

/* ---- fake-case mitigation: per-account risk scoring ----
   The score is advisory only — it NEVER blocks or delays a genuine emergency.
   It is surfaced to the control room as a flag for manual verification. */
function trackReporter(em) {
  const key = reporterAccountKey(em);
  const rec = state.reporterStats.get(key) || { count: 0, cancels: 0, devices: new Set(), lastAt: null };
  rec.count += 1;
  rec.lastAt = new Date().toISOString();
  if (em.reporter?.deviceId) rec.devices.add(em.reporter.deviceId);
  state.reporterStats.set(key, rec);
}

function computeRiskScore(em) {
  const key = reporterAccountKey(em);
  const rec = state.reporterStats.get(key);
  if (!rec) return 0;
  let score = 0;

  // Repeated cancelled cases
  const cancelHistory = em.cancelHistoryCount || rec.cancels || 0;
  if (cancelHistory >= FAKE_CANCEL_THRESHOLD) score += 40;
  else if (cancelHistory >= 1) score += 15;

  // Extremely frequent reports from the same account
  if (rec.count >= 5) score += 20;
  else if (rec.count >= 3) score += 10;

  // Very fast consecutive reports (suspicious automation)
  if (rec.lastAt && Date.now() - new Date(rec.lastAt).getTime() < FAKE_MIN_REPORT_INTERVAL_MS && rec.count > 1) {
    score += 25;
  }

  return Math.min(100, score);
}

function logFalseAlarm(em) {
  const key = reporterAccountKey(em);
  const rec = state.falseAlarms.get(key) || { count: 0, lastAt: null };
  rec.count += 1;
  rec.lastAt = new Date().toISOString();
  state.falseAlarms.set(key, rec);
  // cancelled-case history feeds the risk score
  const r = state.reporterStats.get(key) || { cancels: 0 };
  r.cancels = (r.cancels || 0) + 1;
  state.reporterStats.set(key, r);
}

function pushTimeline(em, role, action, detail, meta, opts = {}) {
  if (!opts.allowDuplicate && em.timeline[em.timeline.length - 1]?.action === action) return;
  em.timeline.push({
    at: new Date().toISOString(),
    role,
    action,
    detail,
    category: meta?.category || categoryFor(action),
    ...(meta || {}),
  });
}

function snapshot(em) {
  return {
    ...em,
    ambulance: em.ambulance ? { ...em.ambulance, liveLocation: em.ambulance.liveLocation || em.ambulance.location } : null,
    hospital: em.hospital ? { ...em.hospital } : null,
    location: { ...em.location },
    timeline: [...em.timeline],
    offeredHospitalIds: [...(em.offeredHospitalIds || [])],
    rejectedHospitalIds: [...(em.rejectedHospitalIds || [])],
    declinedAmbulanceIds: [...(em.declinedAmbulanceIds || [])],
    hospitalRequests: [...(em.hospitalRequests || [])],
    hospitalRecommendations: (em.hospitalRecommendations || []).map((r) => ({
      rank: r.rank,
      eligible: r.eligible,
      score: r.score,
      scoreBreakdown: r.scoreBreakdown,
      reasons: r.reasons,
      problems: r.problems,
      distance: r.distance,
      eta: r.eta,
      freshness: r.freshness,
      staleMinutes: r.staleMinutes,
      hospital: hospitalSnapshotOf(r.hospital),
    })),
    greenCorridor: em.greenCorridor ? { ...em.greenCorridor } : null,
    recommendation: em.recommendation ? { ...em.recommendation, hospital: em.recommendation.hospital ? { ...em.recommendation.hospital } : null } : null,
    aiDecisionLog: [...(em.aiDecisionLog || [])],
  };
}

function publish(em) {
  bus.emit("emergency:updated", snapshot(em));
}

/* ------------------------------------------------------------------ */
/* Patient identification (bystander mode)                              */
/* ------------------------------------------------------------------ */

const IDENTIFICATION_METHODS = ["QR", "MANUAL", "VEHICLE", "AADHAAR_REFERENCE", "UNKNOWN"];

/**
 * attachPatient(emergencyId, { patientId, identificationMethod, details }) —
 * Links a server-resolved patient reference to an emergency after bystander
 * verification. Only the non-sensitive patient reference + verified choice is
 * stored; sensitive medical profiles are NEVER embedded here.
 */
function attachPatient(emergencyId, opts = {}) {
  const em = state.emergencies.get(emergencyId);
  if (!em) throw Object.assign(new Error(`Emergency ${emergencyId} not found`), { code: "NOT_FOUND" });

  const method = IDENTIFICATION_METHODS.includes(opts.identificationMethod) ? opts.identificationMethod : "UNKNOWN";
  if (!opts.patientId && method !== "UNKNOWN") {
    throw Object.assign(new Error("A patientId is required when identificationMethod is not UNKNOWN"), { code: "BAD_REQUEST" });
  }

  em.patient.patientId = opts.patientId ?? null;
  em.patient.identificationMethod = method;
  em.patient.verified = opts.verified !== false;
  em.patient.verifiedAt = new Date().toISOString();
  if (opts.details) {
    em.patient.identificationDetails = opts.details;
  }
  em.patientIdentifiedAt = new Date().toISOString();

  pushTimeline(em, ROLES.REPORTER, "patient-identified",
    `Patient identified via ${method}${opts.patientId ? ` (${opts.patientId})` : ""}`, { category: "identify" }, { allowDuplicate: true });

  bus.emit("patient:identified", {
    emergencyId: em.emergencyId,
    patient: safePatientView(em.patient),
    emergency: snapshot(em),
    at: em.patientIdentifiedAt,
  });
  publish(em);
  return snapshot(em);
}

/** Compact patient view — only what response teams genuinely need. */
function safePatientView(patient) {
  return {
    name: patient?.name || "Unknown",
    age: patient?.age ?? null,
    bloodGroup: patient?.bloodGroup || "Unknown",
    allergies: patient?.allergies || "None listed",
    condition: patient?.condition || "Emergency reported",
    severity: patient?.severity || "moderate",
    patientId: patient?.patientId ?? null,
    identificationMethod: patient?.identificationMethod || "UNKNOWN",
    verified: patient?.verified === true,
  };
}

/**
 * logAiDecision(emergencyId, entry) — append an AI decision to the emergency's
 * audit trail (append-only). The orchestrator writes here via the engine.
 */
function logAiDecision(emergencyId, entry) {
  const em = state.emergencies.get(emergencyId);
  if (!em) throw Object.assign(new Error(`Emergency ${emergencyId} not found`), { code: "NOT_FOUND" });
  if (!em.aiDecisionLog) em.aiDecisionLog = [];
  em.aiDecisionLog.push({ ...entry, at: entry.at || new Date().toISOString() });
  em.updatedAt = new Date().toISOString();
  const stored = em.aiDecisionLog[em.aiDecisionLog.length - 1];
  const ev = entry.event || "ai:decision";
  const payload = { emergencyId: em.emergencyId, entry: stored, emergency: snapshot(em) };
  bus.emit(ev, payload);
  bus.emit("ai:decision", payload);
  publish(em);
  return stored;
}

/* ------------------------------------------------------------------ */
/* Seed / reset                                                        */
/* ------------------------------------------------------------------ */

function reset() {
  state.emergencies.clear();
  state.autoCancelTimers.forEach((t) => clearTimeout(t));
  state.autoCancelTimers.clear();
  state.crashTimers.forEach((t) => clearTimeout(t));
  state.crashTimers.clear();
  state.hospitalTimers.forEach((t) => clearTimeout(t));
  state.hospitalTimers.clear();
  state.falseAlarms.clear();
  state.reporterStats.clear();
  state.ambulances.forEach((a) => {
    a.status = "AVAILABLE";
    a.assignedEmergency = null;
    a.location = a._originalLocation ? { ...a._originalLocation } : a.location;
  });
  state.hospitals.forEach((h) => {
    h.acceptanceStatus = "OPEN";
    h.currentLoad = h._originalLoad ?? h.currentLoad;
    h.emergencyBeds = h._originalEmergencyBeds ?? h.emergencyBeds;
    h.availableBeds = h._originalBeds ?? h.availableBeds;
  });
  if (state.drivers) state.drivers.clear();
  state.serial = 1;
}

function setAutoCancelWindow(ms) {
  AUTO_CANCEL_MS = Math.max(0, Number(ms) || 0);
  return AUTO_CANCEL_MS;
}

function getAutoCancelWindow() {
  return AUTO_CANCEL_MS;
}

function setCrashCountdown(ms) {
  CRASH_COUNTDOWN_MS = Math.max(50, Number(ms) || config.CRASH_DETECTION.countdownSeconds * 1000);
  return CRASH_COUNTDOWN_MS;
}

function getCrashCountdown() {
  return CRASH_COUNTDOWN_MS;
}

function getScoringConfig() {
  return {
    weights: config.WEIGHTS,
    hardConstraints: config.HARD_CONSTRAINTS,
    timeouts: {
      hospitalRequestMs: HOSPITAL_REQUEST_MS,
      acceptanceWindowMs: ACCEPTANCE_WINDOW_MS,
      cancelHistoryThreshold: FAKE_CANCEL_THRESHOLD,
      minReportIntervalMs: FAKE_MIN_REPORT_INTERVAL_MS,
    },
  };
}

function setHospitalRequestTimeout(ms) {
  HOSPITAL_REQUEST_MS = Math.max(100, Number(ms) || config.TIMEOUTS.hospitalRequestMs);
  return HOSPITAL_REQUEST_MS;
}
function getHospitalRequestTimeout() {
  return HOSPITAL_REQUEST_MS;
}
function setAcceptanceWindow(ms) {
  ACCEPTANCE_WINDOW_MS = Math.max(50, Number(ms) || config.TIMEOUTS.acceptanceWindowMs);
  return ACCEPTANCE_WINDOW_MS;
}
function getAcceptanceWindow() {
  return ACCEPTANCE_WINDOW_MS;
}

ambulances.forEach((a) => {
  a._originalLocation = { ...a.location };
});
hospitals.forEach((h) => {
  h._originalLoad = h.currentLoad;
  h._originalEmergencyBeds = h.emergencyBeds;
  h._originalBeds = h.availableBeds;
});

module.exports = {
  STATUS,
  ROLES,
  SOUND,
  TRANSITIONS,
  REJECT_REASONS: config.REJECT_REASONS,
  createEmergency,
  applyAction,
  toggleSiren,
  moveAmbulance,
  listEmergencies,
  getEmergency,
  getRecommendations,
  listAdmissionRequests,
  listAmbulances,
  listHospitals,
  metrics,
  listFalseAlarms,
  setAutoCancelWindow,
  getAutoCancelWindow,
  setCrashCountdown,
  getCrashCountdown,
  setHospitalRequestTimeout,
  getHospitalRequestTimeout,
  setAcceptanceWindow,
  getAcceptanceWindow,
  getScoringConfig,
  computeRiskScore,
  registerDriver,
  unregisterDriver,
  listDrivers,
  registerCitizen,
  unregisterCitizen,
  listCitizens,
  corridorForEmergency,
  reset,
  SEVERITY_ORDER,
  attachPatient,
  safePatientView,
  logAiDecision,
  IDENTIFICATION_METHODS,
};