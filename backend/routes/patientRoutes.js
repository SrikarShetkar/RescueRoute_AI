const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/patientController");

// --- Lookup endpoints (no auth required for emergency scenarios) ---

// GET /api/patient/qr/:token — resolve QR token to vehicle + people
router.get("/qr/:token", ctrl.lookupByQr);

// GET /api/patient/vehicle/:vehicleNumber — lookup by vehicle number
router.get("/vehicle/:vehicleNumber", ctrl.lookupByVehicle);

// GET /api/patient/aadhaar/:identifier — lookup by Aadhaar number
router.get("/aadhaar/:identifier", ctrl.lookupByAadhaar);

// GET /api/patient/lookup/:patientId — resolve a patient reference
// (RESCUEROUTE:PATIENT:<publicId>) to an emergency-relevant subset
router.get("/lookup/:patientId", ctrl.lookupByPatientId);

// GET /api/patient/emergency-profile/:userId — get full emergency profile
router.get("/emergency-profile/:userId", ctrl.getEmergencyProfile);

// --- Profile management ---

// GET /api/patient/profile/:userId
router.get("/profile/:userId", ctrl.getProfile);

// POST /api/patient/profile — create new profile
router.post("/profile", ctrl.createProfile);

// PUT /api/patient/profile/:userId — update profile
router.put("/profile/:userId", ctrl.updateProfile);

// --- Vehicle management ---

// POST /api/patient/vehicles — create a new vehicle
router.post("/vehicles", ctrl.createVehicle);

// GET /api/patient/vehicles?userId=xxx — list vehicles for a user
router.get("/vehicles", ctrl.listMyVehicles);

// POST /api/patient/vehicles/:id/associate — associate a user with a vehicle
router.post("/vehicles/:id/associate", ctrl.associateUser);

// DELETE /api/patient/vehicles/:id/associate/:userId — remove association
router.delete("/vehicles/:id/associate/:userId", ctrl.disassociateUser);

module.exports = router;
