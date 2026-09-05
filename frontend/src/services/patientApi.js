import { SERVER_URL } from "./config";

const BASE = `${SERVER_URL}/api/patient`;

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.code = body?.code;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function lookupByQr(token) {
  return request(`/qr/${encodeURIComponent(token)}`);
}

export function lookupByVehicle(vehicleNumber) {
  return request(`/vehicle/${encodeURIComponent(vehicleNumber)}`);
}

export function lookupByAadhaar(identifier) {
  return request(`/aadhaar/${encodeURIComponent(identifier)}`);
}

/** Resolve a patient reference (RESCUEROUTE:PATIENT:<publicId>) to an emergency-relevant subset. */
export function lookupByPatientId(patientId) {
  return request(`/lookup/${encodeURIComponent(patientId)}`);
}

export function getEmergencyProfile(userId) {
  return request(`/emergency-profile/${encodeURIComponent(userId)}`);
}

export function getProfile(userId) {
  return request(`/profile/${encodeURIComponent(userId)}`);
}

export function updateProfile(userId, updates) {
  return request(`/profile/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

export function createProfile(data) {
  return request("/profile", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function listMyVehicles(userId) {
  return request(`/vehicles?userId=${encodeURIComponent(userId)}`);
}

export function createVehicle(data) {
  return request("/vehicles", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function associateUser(vehicleId, userId) {
  return request(`/vehicles/${encodeURIComponent(vehicleId)}/associate`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export function disassociateUser(vehicleId, userId) {
  return request(`/vehicles/${encodeURIComponent(vehicleId)}/associate/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

const patientApi = {
  lookupByQr,
  lookupByVehicle,
  lookupByAadhaar,
  lookupByPatientId,
  getEmergencyProfile,
  getProfile,
  updateProfile,
  createProfile,
  listMyVehicles,
  createVehicle,
  associateUser,
  disassociateUser,
};

export default patientApi;
