const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/emergencyController");

router.post("/emergencies", ctrl.createEmergency);
router.get("/emergencies", ctrl.listEmergencies);
router.get("/emergencies/admission-requests", ctrl.listAdmissionRequests);
router.get("/emergencies/:id", ctrl.getEmergency);
router.post("/emergencies/:id/actions", ctrl.applyAction);
router.post("/emergencies/:id/patient", ctrl.attachPatient);
router.get("/emergencies/:id/ai", ctrl.aiTrail);
router.post("/emergencies/:id/reevaluate", ctrl.reevaluateEmergency);
router.post("/emergencies/:id/siren", ctrl.toggleSiren);
router.get("/emergencies/:id/recommendations", ctrl.getRecommendations);
router.post("/emergencies/:id/resources", ctrl.updateResources);

router.get("/ambulances", ctrl.listAmbulances);
router.post("/ambulances/:id/move", ctrl.moveAmbulance);

router.get("/hospitals", ctrl.listHospitals);
router.get("/status", ctrl.statusOverview);
router.get("/metrics", ctrl.metrics);
router.get("/scoring-config", ctrl.scoringConfig);
router.get("/green-corridor/:emergencyId", ctrl.getCorridor);
router.post("/demo/reset", ctrl.resetDemo);
router.post("/demo/full-scenario", ctrl.fullDemoScenario);
router.post("/demo/crash-scenario", ctrl.crashDemoScenario);
router.post("/demo/adaptive-dispatch", ctrl.adaptiveDispatchDemoScenario);
router.post("/demo/unknown-qr", ctrl.unknownQrDemoScenario);
router.post("/demo/ambulance-shortage", ctrl.ambulanceShortageDemoScenario);

module.exports = router;