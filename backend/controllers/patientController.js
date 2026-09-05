const registry = require("../domain/patientRegistry");

/* ------------------------------------------------------------------ */
/* QR-based lookup                                                     */
/* ------------------------------------------------------------------ */

function lookupByQr(req, res) {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: "QR token is required" });

    const result = registry.lookupByQrToken(token);
    if (!result) {
      return res.status(404).json({ error: "Invalid or expired QR code", code: "INVALID_QR" });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(err, res);
  }
}

/* ------------------------------------------------------------------ */
/* Vehicle number lookup                                               */
/* ------------------------------------------------------------------ */

function lookupByVehicle(req, res) {
  try {
    const { vehicleNumber } = req.params;
    if (!vehicleNumber) return res.status(400).json({ error: "Vehicle number is required" });

    const result = registry.lookupByVehicleNumber(vehicleNumber);
    if (!result) {
      return res.status(404).json({ error: "Vehicle not registered", code: "VEHICLE_NOT_FOUND" });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(err, res);
  }
}

/* ------------------------------------------------------------------ */
/* Aadhaar lookup                                                      */
/* ------------------------------------------------------------------ */

function lookupByAadhaar(req, res) {
  try {
    const { identifier } = req.params;
    if (!identifier) return res.status(400).json({ error: "Aadhaar identifier is required" });

    // Basic validation: should be 12 digits (with or without spaces)
    const clean = String(identifier).replace(/\s/g, "");
    if (!/^\d{12}$/.test(clean)) {
      return res.status(400).json({ error: "Invalid Aadhaar format — must be 12 digits", code: "INVALID_AADHAAR" });
    }

    const result = registry.lookupByAadhaar(identifier);
    if (!result) {
      return res.status(404).json({ error: "No profile found for this identifier", code: "AADHAAR_NOT_FOUND" });
    }
    res.json({ success: true, profile: result });
  } catch (err) {
    handleError(err, res);
  }
}

/* ------------------------------------------------------------------ */
/* Patient-reference lookup (RESCUEROUTE:PATIENT:<publicId>)           */
/* ------------------------------------------------------------------ */

function lookupByPatientId(req, res) {
  try {
    const { patientId } = req.params;
    if (!patientId) {
      return res.status(400).json({ success: false, code: "PATIENT_REFERENCE_REQUIRED", message: "A patient reference is required." });
    }

    const normalized = registry.normalizePatientReference(patientId);
    if (!normalized) {
      return res.status(400).json({ success: false, code: "INVALID_PATIENT_REFERENCE", message: "Patient reference format is invalid." });
    }

    const patient = registry.lookupByPatientReference(patientId);
    if (!patient) {
      return res.status(404).json({
        success: false,
        code: "PATIENT_NOT_FOUND",
        message: "Patient record could not be found.",
      });
    }
    res.json({ success: true, patient });
  } catch (err) {
    handleError(err, res);
  }
}

/* ------------------------------------------------------------------ */
/* Emergency profile                                                   */
/* ------------------------------------------------------------------ */

function getEmergencyProfile(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const profile = registry.getEmergencyProfile(userId);
    if (!profile) {
      return res.status(404).json({ error: "Patient profile not found", code: "PROFILE_NOT_FOUND" });
    }
    res.json({ success: true, profile });
  } catch (err) {
    handleError(err, res);
  }
}

/* ------------------------------------------------------------------ */
/* Vehicle management                                                  */
/* ------------------------------------------------------------------ */

function createVehicle(req, res) {
  try {
    const { vehicleNumber, ownerUserId } = req.body;
    if (!vehicleNumber || !ownerUserId) {
      return res.status(400).json({ error: "vehicleNumber and ownerUserId are required" });
    }

    // Validate owner exists
    const owner = registry.getUserById(ownerUserId);
    if (!owner) {
      return res.status(404).json({ error: "Owner user not found" });
    }

    const vehicle = registry.createVehicle({ vehicleNumber, ownerUserId });
    res.status(201).json({ success: true, vehicle });
  } catch (err) {
    handleError(err, res);
  }
}

function associateUser(req, res) {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    // Validate user exists
    const user = registry.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const vehicle = registry.associateUser(id, userId);
    res.json({ success: true, vehicle });
  } catch (err) {
    handleError(err, res);
  }
}

function disassociateUser(req, res) {
  try {
    const { id, userId } = req.params;
    const vehicle = registry.disassociateUser(id, userId);
    res.json({ success: true, vehicle });
  } catch (err) {
    handleError(err, res);
  }
}

function listMyVehicles(req, res) {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId query parameter is required" });

    const vehicles = registry.listVehiclesForUser(userId);
    res.json({ success: true, vehicles });
  } catch (err) {
    handleError(err, res);
  }
}

/* ------------------------------------------------------------------ */
/* Profile management                                                  */
/* ------------------------------------------------------------------ */

function updateProfile(req, res) {
  try {
    const { userId } = req.params;
    const updates = req.body;

    const user = registry.updateUser(userId, updates);
    res.json({ success: true, user });
  } catch (err) {
    handleError(err, res);
  }
}

function getProfile(req, res) {
  try {
    const { userId } = req.params;
    const user = registry.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ success: true, user });
  } catch (err) {
    handleError(err, res);
  }
}

function createProfile(req, res) {
  try {
    const userData = req.body;
    if (!userData.name) {
      return res.status(400).json({ error: "Name is required" });
    }
    const user = registry.createUser(userData);
    res.status(201).json({ success: true, user });
  } catch (err) {
    handleError(err, res);
  }
}

/* ------------------------------------------------------------------ */
/* Error handler                                                       */
/* ------------------------------------------------------------------ */

function handleError(err, res) {
  const status = { BAD_REQUEST: 400, NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409 }[err.code] || 500;
  console.error(` [patient-api] ${err.message}`);
  res.status(status).json({
    error: err.message,
    code: err.code || "SERVER_ERROR",
  });
}

module.exports = {
  lookupByQr,
  lookupByVehicle,
  lookupByAadhaar,
  lookupByPatientId,
  getEmergencyProfile,
  createVehicle,
  associateUser,
  disassociateUser,
  listMyVehicles,
  updateProfile,
  getProfile,
  createProfile,
};
