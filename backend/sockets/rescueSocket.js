const { Server } = require("socket.io");
const bus = require("../domain/bus");
const engine = require("../domain/emergencyEngine");
const { calculateDistance } = require("../utils/etaCalculator");

let io;
const vehicles = new Map();
const SIREN_RADIUS_M = 2500;

function initSocket(server) {
  io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    console.log(" Client connected:", socket.id);

    socket.on("disconnect", () => {
      console.log(" Client disconnected:", socket.id);
      vehicles.delete(socket.id);
      engine.unregisterDriver(socket.id);
      engine.unregisterCitizen(socket.id);
    });

    socket.on("register-role", (data) => {
      const role = data?.role;
      if (role) {
        socket.join(`role-${role}`);
        if (role === "driver") {
          engine.registerDriver({
            socketId: socket.id,
            name: data.name,
            location: data.location,
          });
        } else if (role === "ambulance" && data.ambulanceId) {
          socket.data.ambulanceId = data.ambulanceId;
        } else if (role === "citizen" || role === "reporter") {
          if (role === "citizen") {
            engine.registerCitizen({
              socketId: socket.id,
              deviceId: data.deviceId || socket.id,
              location: data.location,
              notificationsEnabled: data.notificationsEnabled,
            });
          }
        }
        console.log(` Socket ${socket.id} registered as role '${role}'`);
      }
    });

    socket.on("join-emergency", (emergencyId) => {
      socket.join(emergencyId);
    });

    socket.on("citizen:location", (data) => {
      if (!data) return;
      if (socket.data.ambulanceId) return;
      engine.registerCitizen({
        socketId: socket.id,
        deviceId: data.deviceId || socket.id,
        location: { lat: data.lat, lng: data.lng },
        notificationsEnabled: data.notificationsEnabled,
      });
    });

    socket.on("update-location", (data) => {
      vehicles.set(socket.id, { lat: data.lat, lng: data.lng, socketId: socket.id });
      if (socket.data.roleDriver) {
        engine.registerDriver({ socketId: socket.id, location: { lat: data.lat, lng: data.lng } });
      }
    });

    socket.on("ambulance:move", (data) => {
      const ambulanceId = socket.data.ambulanceId || data.ambulanceId;
      if (!ambulanceId) return;
      try {
        engine.moveAmbulance({ ambulanceId, lat: data.lat, lng: data.lng });
      } catch (err) {
        socket.emit("error:event", { message: err.message });
      }
    });

    socket.on("ambulance:siren", (data) => {
      const ambulanceId = socket.data.ambulanceId || data.ambulanceId;
      if (!ambulanceId) return;
      try {
        engine.toggleSiren({ ambulanceId, emergencyId: data.emergencyId, on: data.on });
      } catch (err) {
        socket.emit("error:event", { message: err.message });
      }
    });

    socket.on("emergency-alert", (data) => {
      const { lat, lng, radius = 500 } = data;
      vehicles.forEach((vehicle, socketId) => {
        const distance = calculateDistance(lat, lng, vehicle.lat, vehicle.lng) * 1000;
        if (distance <= radius) {
          io.to(socketId).emit("ambulance-approaching", { distance, message: "Emergency vehicle approaching" });
        }
      });
    });
  });

  bus.on("emergency:updated", (emergency) => {
    io.emit("emergency:update", emergency);
  });

  bus.on("emergency:created", (emergency) => {
    io.emit("emergency:created", emergency);
  });

  bus.on("sound:event", ({ sounds, emergency }) => {
    io.emit("sound:event", { sounds: sounds || [], emergency });
  });

  bus.on("siren:changed", (payload) => {
    io.emit("siren:event", payload);
    broadcastToDrivers(payload);
  });

  bus.on("ambulance:moved", (payload) => {
    io.to("role-dispatch").emit("ambulance:location", payload);
    io.to("role-driver").emit("ambulance:location", payload);
    io.to("role-reporter").emit("ambulance:location", payload);
  });

  /* ---------------- new domain streams ---------------- */

  // A hospital rejected a patient → every dashboard reacts in its own way.
  bus.on("hospital:rejected", (payload) => {
    io.emit("hospital:rejected", payload);
  });

  // A hospital accepted the patient (one of possibly several accepted).
  bus.on("hospital:accepted", (payload) => {
    io.emit("hospital:accepted", payload);
  });

  // A hospital accepted the patient (one of possibly several accepted).
  bus.on("hospital:driver-started", (payload) => {
    io.emit("hospital:driver-started", payload);
    io.to(`role-hospital-${payload.hospitalId}`).emit("ambulance:on-the-way", payload);
  });

  // Recommendation set changed (pickup, rejection reroute, override).
  bus.on("recommendations:updated", (payload) => {
    io.emit("recommendations:updated", payload);
  });

  // Green corridor activated / updated.
  bus.on("corridor:updated", (payload) => {
    io.emit("corridor:updated", payload);
  });

  // Citizen-facing green corridor alert (online users / online citizens).
  bus.on("green-corridor:alert", (payload) => {
    io.emit("green-corridor:alert", {
      corridor: payload.corridor,
      notificationText: payload.notificationText,
      emergencyId: payload.emergency?.emergencyId,
      ambulanceId: payload.corridor.ambulanceId,
    });
    io.to("role-citizen").emit("green-corridor:alert", {
      corridor: payload.corridor,
      notificationText: payload.notificationText,
      emergencyId: payload.emergency?.emergencyId,
    });
  });

  // Control room escalation.
  bus.on("escalation:triggered", (payload) => {
    io.emit("escalation:triggered", payload);
  });

  // Hospital resource freshness updates.
  bus.on("hospital:resources", (payload) => {
    io.emit("hospital:resources", payload);
  });

  /* ---------------- AI + patient-identification streams ---------------- */

  // Forward an event to everyone AND to the emergency room it belongs to.
  const forwardToEmergency = (event) => (payload) => {
    io.emit(event, payload);
    if (payload?.emergencyId) io.to(payload.emergencyId).emit(event, payload);
  };

  bus.on("patient:identified", forwardToEmergency("patient:identified"));
  bus.on("patient:verification-failed", forwardToEmergency("patient:verification-failed"));
  bus.on("ai:triage", forwardToEmergency("ai:triage"));
  bus.on("ai:recommendation", forwardToEmergency("ai:recommendation"));
  bus.on("ai:reevaluation", forwardToEmergency("ai:reevaluation"));
  bus.on("ai:decision", forwardToEmergency("ai:decision"));
  bus.on("dispatch:reassigned", forwardToEmergency("dispatch:reassigned"));

  return io;
}

function broadcastToDrivers(payload) {
  const drivers = engine.listDrivers();
  const source = payload.location || { lat: 17.42, lng: 78.44 };
  drivers.forEach((driverData, socketId) => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket || !socket.connected) return;
    if (!payload.on) {
      socket.emit("siren:event", payload);
      return;
    }
    const distanceM = Math.round(calculateDistance(source.lat, source.lng, driverData.location.lat, driverData.location.lng) * 1000);
    if (distanceM <= SIREN_RADIUS_M) {
      socket.emit("siren:event", { ...payload, distanceM });
    } else {
      socket.emit("siren:event", { ...payload, distanceM, outOfRange: true });
    }
  });
}

function emitEmergencyUpdate(data) {
  if (io) {
    io.emit("emergency-update", data);
  }
}

function emitToEmergency(emergencyId, event, data) {
  if (io) {
    io.to(emergencyId).emit(event, data);
  }
}

module.exports = {
  initSocket,
  emitEmergencyUpdate,
  emitToEmergency,
  getIO: () => io,
};