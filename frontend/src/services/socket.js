import io from "socket.io-client";
import { SOCKET_URL } from "./config";

/**
 * socket.js — one shared socket for the whole app.
 *
 * - Screens join role rooms (ambulance / hospital / driver / dispatch).
 * - The domain's sound plans, siren alerts, and emergency updates arrive here
 *   and are re-broadcast to React via a tiny subscription helper.
 */

export const EVENTS = {
  EMERGENCY_UPDATE: "emergency:update",
  EMERGENCY_CREATED: "emergency:created",
  SOUND_EVENT: "sound:event",
  SIREN_EVENT: "siren:event",
  AMBULANCE_LOCATION: "ambulance:location",
  ERROR: "error:event",
  HOSPITAL_REJECTED: "hospital:rejected",
  RECOMMENDATIONS_UPDATED: "recommendations:updated",
  CORRIDOR_UPDATED: "corridor:updated",
  GREEN_CORRIDOR_ALERT: "green-corridor:alert",
  ESCALATION_TRIGGERED: "escalation:triggered",
  HOSPITAL_RESOURCES: "hospital:resources",
  HOSPITAL_ACCEPTED: "hospital:accepted",
  DRIVER_STARTED: "hospital:driver-started",
  // AI decision-support + bystander patient identification
  PATIENT_IDENTIFIED: "patient:identified",
  PATIENT_VERIFICATION_FAILED: "patient:verification-failed",
  AI_TRIAGE: "ai:triage",
  AI_RECOMMENDATION: "ai:recommendation",
  AI_REEVALUATION: "ai:reevaluation",
  AI_DECISION: "ai:decision",
  DISPATCH_REASSIGNED: "dispatch:reassigned",
};

let socket = null;

export function connectSocket() {
  if (socket) return socket;
  socket = io(SOCKET_URL, {
    transports: ["websocket", "polling"],
    reconnectionAttempts: Infinity,
  });
  socket.on("connect", () => console.log(" Socket connected:", socket.id));
  socket.on("disconnect", () => console.log(" Socket disconnected"));
  return socket;
}

export function getSocket() {
  return socket || connectSocket();
}

/** Tell the server which role this screen plays. */
export function registerRole(role, meta = {}) {
  getSocket().emit("register-role", { role, ...meta });
}

/** Live simulated movement from an ambulance screen. */
export function emitAmbulanceMove({ ambulanceId, lat, lng }) {
  getSocket().emit("ambulance:move", { ambulanceId, lat, lng });
}

/** Siren toggle from the assigned ambulance screen. */
export function emitSiren({ ambulanceId, emergencyId, on }) {
  getSocket().emit("ambulance:siren", { ambulanceId, emergencyId, on });
}

/** Citizen registers live location for green-corridor awareness. */
export function emitCitizenLocation({ lat, lng, notificationsEnabled = true }) {
  getSocket().emit("citizen:location", { lat, lng, notificationsEnabled });
}

/** Register as a citizen for geo-fenced corridor alerts. */
export function registerCitizen(location, notificationsEnabled = true) {
  getSocket().emit("register-role", {
    role: "citizen",
    deviceId: `web-${Math.random().toString(36).slice(2, 8)}`,
    location,
    notificationsEnabled,
  });
}

/* ---- subscription helper (auto-deduped per callback) ---- */

export function on(event, callback) {
  const s = getSocket();
  const wrapped = (data) => {
    console.log(` [socket] ${event}`, data);
    callback(data);
  };
  if (!s._wrappedListeners) s._wrappedListeners = new Map();
  const key = event + "\u0000" + (callback.name || Math.random());
  s._wrappedListeners.set(key, wrapped);
  s.on(event, wrapped);
  return key;
}

export function off(event, key) {
  if (!socket) return;
  if (key && socket._wrappedListeners && socket._wrappedListeners.has(key)) {
    const wrapped = socket._wrappedListeners.get(key);
    socket.off(event, wrapped);
    socket._wrappedListeners.delete(key);
  }
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = {};
  }
}

/* ----- legacy exports (kept for old pages that still import this) ----- */
export function onEmergencyUpdate(callback) {
  return on(EVENTS.EMERGENCY_UPDATE, (data) => {
    const typed = { type: `V1_EMERGENCY_${data.status}`, emergency: data };
    callback(typed);
  });
}
export const offEmergencyUpdate = off;
export function updateLocation() {}
export function triggerEmergency() {}
export const connectToServer = connectSocket;

const socketService = {
  connectSocket,
  connectToServer,
  disconnectSocket,
  onEmergencyUpdate,
  offEmergencyUpdate,
  registerRole,
  emitAmbulanceMove,
  emitSiren,
  emitCitizenLocation,
  registerCitizen,
  getSocket,
  EVENTS,
  on,
  off,
};

export default socketService;