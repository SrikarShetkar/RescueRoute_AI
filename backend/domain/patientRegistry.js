/**
 * patientRegistry.js — In-memory registry for vehicles, users, and emergency profiles.
 *
 * Provides QR-token-based identification, vehicle-number lookup, Aadhaar lookup,
 * and emergency-profile retrieval. Seeded with demo data for SIH prototype.
 *
 * All sensitive data (Aadhaar, medical history) is NEVER stored in QR codes.
 * QR codes contain only a secure random token.
 *
 * Bystander patient-reference QR codes carry ONLY a non-sensitive public
 * reference (e.g. `RESCUEROUTE:PATIENT:PT-8F29A1`). The server resolves that
 * reference to the underlying record and returns only emergency-relevant
 * fields — never Aadhaar or full medical history.
 */

const crypto = require("crypto");

/* ------------------------------------------------------------------ */
/* In-memory state                                                     */
/* ------------------------------------------------------------------ */

const vehicles = new Map();   // vehicleId -> vehicle object
const users = new Map();      // userId -> user/patient object
const qrTokenMap = new Map(); // qrToken -> vehicleId
const patientRefMap = new Map(); // public patient ref (PT-XXXXXX) -> userId
let vehicleSerial = 1;

const PATIENT_REF_PREFIX = "RESCUEROUTE:PATIENT:";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function generateQrToken() {
  return "rr-qr-" + crypto.randomBytes(18).toString("hex");
}

function normalizeVehicleNumber(num) {
  return String(num || "").toUpperCase().replace(/\s+/g, "").replace(/-/g, "");
}

function maskAadhaar(aadhaar) {
  if (!aadhaar) return "";
  const clean = String(aadhaar).replace(/\s/g, "");
  if (clean.length === 12) {
    return "XXXX XXXX " + clean.slice(-4);
  }
  return "XXXX";
}

/**
 * Public patient reference. Deterministic, non-sensitive, collision-safe for
 * demo seeds; maps 1:1 to a registry user id.
 */
function publicRefFor(userId) {
  let h = 0;
  for (let i = 0; i < String(userId).length; i++) h = (h * 31 + String(userId).charCodeAt(i)) >>> 0;
  const suffix = (h % 0xffffff).toString(16).toUpperCase().padStart(6, "0");
  return `PT-${suffix}`;
}

/**
 * Accept either the full QR payload (`RESCUEROUTE:PATIENT:PT-XXXXXX`) or the
 * bare reference (`PT-XXXXXX`). Returns null for clearly invalid references.
 */
function normalizePatientReference(ref) {
  if (!ref) return null;
  let clean = String(ref).trim();
  const idx = clean.toUpperCase().indexOf(PATIENT_REF_PREFIX);
  if (idx !== -1) {
    clean = clean.slice(idx + PATIENT_REF_PREFIX.length);
  }
  clean = clean.trim();
  if (!/^[A-Za-z]{2}:\d+$/.test(clean) && !/^[A-Za-z]{2,}-\d+$/.test(clean) && !/^PT-[A-Fa-f0-9]{6}$/i.test(clean)) {
    return null;
  }
  return clean.toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function generateQrToken() {
  return "rr-qr-" + crypto.randomBytes(18).toString("hex");
}

function normalizeVehicleNumber(num) {
  return String(num || "").toUpperCase().replace(/\s+/g, "").replace(/-/g, "");
}

function maskAadhaar(aadhaar) {
  if (!aadhaar) return "";
  const clean = String(aadhaar).replace(/\s/g, "");
  if (clean.length === 12) {
    return "XXXX XXXX " + clean.slice(-4);
  }
  return "XXXX";
}

/* ------------------------------------------------------------------ */
/* Demo seed data                                                      */
/* ------------------------------------------------------------------ */

function seedDemoData() {
  if (vehicles.size > 0) return; // already seeded

  // --- Demo Users / Patients ---
  const demoUsers = [
    {
      id: "pat-001",
      name: "Rajesh Kumar",
      age: 52,
      gender: "Male",
      bloodGroup: "B+",
      phone: "+91 98765 43210",
      photo: null,
      aadhaar: "1234 5678 9012",
      vehicleNumbers: ["TS09AB1234"],
      allergies: "Penicillin",
      medicalHistory: ["Hypertension", "Type 2 Diabetes"],
      emergencyContacts: [
        { name: "Rahul Kumar", phone: "+91 98765 43211", relation: "Son" },
        { name: "Lakshmi Kumar", phone: "+91 98765 43212", relation: "Wife" }
      ],
    },
    {
      id: "pat-002",
      name: "Rahul Kumar",
      age: 21,
      gender: "Male",
      bloodGroup: "O+",
      phone: "+91 98765 43211",
      photo: null,
      aadhaar: "2345 6789 0123",
      vehicleNumbers: ["TS09AB1234"],
      allergies: "None",
      medicalHistory: [],
      emergencyContacts: [
        { name: "Rajesh Kumar", phone: "+91 98765 43210", relation: "Father" },
        { name: "Lakshmi Kumar", phone: "+91 98765 43212", relation: "Mother" }
      ],
    },
    {
      id: "pat-003",
      name: "Lakshmi Kumar",
      age: 48,
      gender: "Female",
      bloodGroup: "A+",
      phone: "+91 98765 43212",
      photo: null,
      aadhaar: "3456 7890 1234",
      vehicleNumbers: ["TS09AB1234"],
      allergies: "Sulfa drugs",
      medicalHistory: ["Hypothyroidism"],
      emergencyContacts: [
        { name: "Rajesh Kumar", phone: "+91 98765 43210", relation: "Husband" },
        { name: "Rahul Kumar", phone: "+91 98765 43211", relation: "Son" }
      ],
    },
    {
      id: "pat-004",
      name: "Ananya Iyer",
      age: 34,
      gender: "Female",
      bloodGroup: "B+",
      phone: "+91 90000 00011",
      photo: null,
      aadhaar: "4567 8901 2345",
      vehicleNumbers: ["TS07JK2211"],
      allergies: "None",
      medicalHistory: [],
      emergencyContacts: [
        { name: "Vikram Iyer", phone: "+91 90000 00015", relation: "Brother" }
      ],
    },
    {
      id: "pat-005",
      name: "Ravi Deshmukh",
      age: 41,
      gender: "Male",
      bloodGroup: "A-",
      phone: "+91 90000 00012",
      photo: null,
      aadhaar: "5678 9012 3456",
      vehicleNumbers: ["TS09CD2211"],
      allergies: "Peanuts",
      medicalHistory: ["Asthma"],
      emergencyContacts: [
        { name: "Sunita Deshmukh", phone: "+91 90000 00016", relation: "Wife" }
      ],
    },
    {
      id: "pat-006",
      name: "Sneha Kulkarni",
      age: 26,
      gender: "Female",
      bloodGroup: "O-",
      phone: "+91 90000 00013",
      photo: null,
      aadhaar: "6789 0123 4567",
      vehicleNumbers: [],
      allergies: "None",
      medicalHistory: [],
      emergencyContacts: [
        { name: "Prakash Kulkarni", phone: "+91 90000 00017", relation: "Father" }
      ],
    },
    {
      id: "pat-007",
      name: "Mohit Gupta",
      age: 30,
      gender: "Male",
      bloodGroup: "AB+",
      phone: "+91 90000 00005",
      photo: null,
      aadhaar: "7890 1234 5678",
      vehicleNumbers: ["TS07JK2211"],
      allergies: "Latex",
      medicalHistory: [],
      emergencyContacts: [
        { name: "Neha Gupta", phone: "+91 90000 00018", relation: "Wife" }
      ],
    },
  ];

  demoUsers.forEach((u) => {
    u.publicId = publicRefFor(u.id);
    users.set(u.id, u);
    patientRefMap.set(u.publicId, u.id);
  });

  // --- Demo Vehicles ---
  const demoVehicles = [
    {
      id: "veh-001",
      vehicleNumber: "TS09AB1234",
      qrToken: generateQrToken(),
      ownerUserId: "pat-001",
      associatedUserIds: ["pat-001", "pat-002", "pat-003"],
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: "veh-002",
      vehicleNumber: "TS07JK2211",
      qrToken: generateQrToken(),
      ownerUserId: "pat-004",
      associatedUserIds: ["pat-004", "pat-007"],
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: "veh-003",
      vehicleNumber: "TS09CD2211",
      qrToken: generateQrToken(),
      ownerUserId: "pat-005",
      associatedUserIds: ["pat-005"],
      active: true,
      createdAt: new Date().toISOString(),
    },
  ];

  demoVehicles.forEach((v) => {
    vehicles.set(v.id, v);
    qrTokenMap.set(v.qrToken, v.id);
  });

  vehicleSerial = demoVehicles.length + 1;

  console.log(` [patientRegistry] Seeded ${demoUsers.length} users and ${demoVehicles.length} vehicles`);
}

/* ------------------------------------------------------------------ */
/* Vehicle operations                                                  */
/* ------------------------------------------------------------------ */

function createVehicle({ vehicleNumber, ownerUserId }) {
  const normalized = normalizeVehicleNumber(vehicleNumber);
  if (!normalized) throw Object.assign(new Error("Vehicle number is required"), { code: "BAD_REQUEST" });

  // Check for duplicate
  for (const v of vehicles.values()) {
    if (v.vehicleNumber === normalized) {
      throw Object.assign(new Error("Vehicle already registered"), { code: "CONFLICT" });
    }
  }

  const id = "veh-" + String(vehicleSerial++).padStart(3, "0");
  const qrToken = generateQrToken();

  const vehicle = {
    id,
    vehicleNumber: normalized,
    qrToken,
    ownerUserId,
    associatedUserIds: [ownerUserId],
    active: true,
    createdAt: new Date().toISOString(),
  };

  vehicles.set(id, vehicle);
  qrTokenMap.set(qrToken, id);

  // Update user's vehicleNumbers
  const user = users.get(ownerUserId);
  if (user && !user.vehicleNumbers.includes(normalized)) {
    user.vehicleNumbers.push(normalized);
  }

  return vehicle;
}

function getVehicleById(vehicleId) {
  return vehicles.get(vehicleId) || null;
}

function getVehicleByNumber(vehicleNumber) {
  const normalized = normalizeVehicleNumber(vehicleNumber);
  for (const v of vehicles.values()) {
    if (v.vehicleNumber === normalized && v.active) return v;
  }
  return null;
}

function getVehicleByQrToken(token) {
  const vehicleId = qrTokenMap.get(token);
  if (!vehicleId) return null;
  return vehicles.get(vehicleId) || null;
}

function associateUser(vehicleId, userId) {
  const vehicle = vehicles.get(vehicleId);
  if (!vehicle) throw Object.assign(new Error("Vehicle not found"), { code: "NOT_FOUND" });
  if (vehicle.associatedUserIds.includes(userId)) {
    return vehicle;
  }
  vehicle.associatedUserIds.push(userId);

  // Update user's vehicleNumbers
  const user = users.get(userId);
  if (user && !user.vehicleNumbers.includes(vehicle.vehicleNumber)) {
    user.vehicleNumbers.push(vehicle.vehicleNumber);
  }

  return vehicle;
}

function disassociateUser(vehicleId, userId) {
  const vehicle = vehicles.get(vehicleId);
  if (!vehicle) throw Object.assign(new Error("Vehicle not found"), { code: "NOT_FOUND" });

  vehicle.associatedUserIds = vehicle.associatedUserIds.filter((id) => id !== userId);

  // Remove vehicle number from user
  const user = users.get(userId);
  if (user) {
    user.vehicleNumbers = user.vehicleNumbers.filter((n) => n !== vehicle.vehicleNumber);
  }

  return vehicle;
}

/* ------------------------------------------------------------------ */
/* User/Patient operations                                              */
/* ------------------------------------------------------------------ */

function getUserById(userId) {
  return users.get(userId) || null;
}

function getUserByAadhaar(aadhaar) {
  const clean = String(aadhaar || "").replace(/\s/g, "");
  for (const u of users.values()) {
    if (u.aadhaar && u.aadhaar.replace(/\s/g, "") === clean) return u;
  }
  return null;
}

function getAssociatedUsers(vehicleId) {
  const vehicle = vehicles.get(vehicleId);
  if (!vehicle) return [];
  return vehicle.associatedUserIds
    .map((id) => users.get(id))
    .filter(Boolean);
}

function updateUser(userId, updates) {
  const user = users.get(userId);
  if (!user) throw Object.assign(new Error("User not found"), { code: "NOT_FOUND" });

  const allowed = ["name", "age", "gender", "bloodGroup", "phone", "photo", "allergies", "medicalHistory", "emergencyContacts", "aadhaar"];
  for (const key of allowed) {
    if (updates[key] !== undefined) user[key] = updates[key];
  }
  return user;
}

function createUser(userData) {
  const id = "pat-" + String(users.size + 100).padStart(3, "0");
  const publicId = publicRefFor(id);
  const user = {
    id,
    publicId,
    name: userData.name || "",
    age: userData.age || null,
    gender: userData.gender || "",
    bloodGroup: userData.bloodGroup || "O+",
    phone: userData.phone || "",
    photo: userData.photo || null,
    aadhaar: userData.aadhaar || "",
    vehicleNumbers: [],
    allergies: userData.allergies || "None",
    medicalHistory: userData.medicalHistory || [],
    emergencyContacts: userData.emergencyContacts || [],
  };
  users.set(id, user);
  patientRefMap.set(publicId, id);
  return user;
}

/* ------------------------------------------------------------------ */
/* Emergency profile (safe subset for bystander view)                   */
/* ------------------------------------------------------------------ */

function getEmergencyProfile(userId) {
  const user = users.get(userId);
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    age: user.age,
    gender: user.gender,
    bloodGroup: user.bloodGroup,
    photo: user.photo,
    allergies: user.allergies,
    medicalHistory: user.medicalHistory,
    vehicleNumbers: user.vehicleNumbers,
    emergencyContacts: user.emergencyContacts,
  };
}

/* ------------------------------------------------------------------ */
/* QR lookup (returns vehicle + associated user summaries)              */
/* ------------------------------------------------------------------ */

function lookupByQrToken(token) {
  const vehicle = getVehicleByQrToken(token);
  if (!vehicle) return null;

  const people = getAssociatedUsers(vehicle.id).map((u) => ({
    id: u.id,
    name: u.name,
    age: u.age,
    gender: u.gender,
    bloodGroup: u.bloodGroup,
    photo: u.photo,
    allergies: u.allergies,
  }));

  return {
    vehicleId: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
    people,
  };
}

/* ------------------------------------------------------------------ */
/* Vehicle number lookup                                               */
/* ------------------------------------------------------------------ */

function lookupByVehicleNumber(vehicleNumber) {
  const vehicle = getVehicleByNumber(vehicleNumber);
  if (!vehicle) return null;

  const people = getAssociatedUsers(vehicle.id).map((u) => ({
    id: u.id,
    name: u.name,
    age: u.age,
    gender: u.gender,
    bloodGroup: u.bloodGroup,
    photo: u.photo,
    allergies: u.allergies,
  }));

  return {
    vehicleId: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
    people,
  };
}

/* ------------------------------------------------------------------ */
/* Aadhaar lookup (returns single profile)                             */
/* ------------------------------------------------------------------ */

function lookupByAadhaar(aadhaar) {
  const user = getUserByAadhaar(aadhaar);
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    age: user.age,
    gender: user.gender,
    bloodGroup: user.bloodGroup,
    photo: user.photo,
    allergies: user.allergies,
    medicalHistory: user.medicalHistory,
    vehicleNumbers: user.vehicleNumbers,
  };
}

/* ------------------------------------------------------------------ */
/* Patient-reference QR lookup (RESCUEROUTE:PATIENT:<publicId>)        */
/* ------------------------------------------------------------------ */

/**
 * Resolve a patient reference to a SAFE emergency-relevant subset. Never
 * returns Aadhaar, phone, or full medical history — only what a responding
 * team genuinely needs to treat the patient.
 */
function lookupByPatientReference(ref) {
  const clean = normalizePatientReference(ref);
  if (!clean) return null;
  const userId = patientRefMap.get(clean);
  if (!userId) return null;
  const user = users.get(userId);
  if (!user) return null;

  return {
    id: user.id,
    patientId: user.publicId,
    name: user.name,
    age: user.age,
    gender: user.gender,
    bloodGroup: user.bloodGroup,
    allergies: user.allergies,
    criticalConditions: user.medicalHistory || [],
    emergencyContactAvailable: Array.isArray(user.emergencyContacts) && user.emergencyContacts.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* List all vehicles for a user                                        */
/* ------------------------------------------------------------------ */

function listVehiclesForUser(userId) {
  const result = [];
  for (const v of vehicles.values()) {
    if (v.associatedUserIds.includes(userId)) {
      const people = getAssociatedUsers(v.id).map((u) => ({
        id: u.id,
        name: u.name,
        age: u.age,
        gender: u.gender,
        bloodGroup: u.bloodGroup,
        photo: u.photo,
      }));
      result.push({
        id: v.id,
        vehicleNumber: v.vehicleNumber,
        qrToken: v.qrToken,
        ownerUserId: v.ownerUserId,
        active: v.active,
        people,
      });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Initialize                                                          */
/* ------------------------------------------------------------------ */

seedDemoData();

module.exports = {
  createVehicle,
  getVehicleById,
  getVehicleByNumber,
  getVehicleByQrToken,
  associateUser,
  disassociateUser,
  getUserById,
  getUserByAadhaar,
  getAssociatedUsers,
  updateUser,
  createUser,
  getEmergencyProfile,
  lookupByQrToken,
  lookupByVehicleNumber,
  lookupByAadhaar,
  lookupByPatientReference,
  normalizePatientReference,
  listVehiclesForUser,
  maskAadhaar,
  normalizeVehicleNumber,
  generateQrToken,
};
