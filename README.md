# 🚑 RescueRoute — Real-Time Emergency Response Platform

RescueRoute is a full-stack emergency response platform that coordinates citizen,
ambulance, hospital and control-room stakeholders around a single **live emergency
lifecycle**. It turns a reported emergency into a tracked, audited, dispatching-to-handover
operation with smart hospital recommendation, parallel admission requests with
first-accept-wins, a green corridor for approaching ambulances, fake-case mitigation,
and real-time (Socket.IO) sync across every role.

It also layers an **AI Emergency Orchestrator** on top of the deterministic engine:
advisory triage, ambulance/hospital recommendations and adaptive re-evaluation
(Gemini or an audited deterministic fallback), plus **bystander patient identification**
that resolves a non-sensitive patient-reference QR to the response team's working view
of the victim.

The **backend is the single source of truth** — each role's screen reflects server state,
and the server validates every state transition (role-gated, ownership-checked). The whole
engine runs **fully in-memory**, so the demo works with no database at all (MongoDB is
optional and auto-detected).

---

## Table of Contents

1. [Highlights](#highlights)
2. [Role-Based Dashboards](#role-based-dashboards)
3. [Emergency Lifecycle (State Machine)](#emergency-lifecycle-state-machine)
4. [How the Algorithms Work](#how-the-algorithms-work)
5. [Fake-Case (False Alarm) Mitigation](#fake-case-false-alarm-mitigation)
6. [AI Emergency Orchestrator & Patient Identification](#ai-emergency-orchestrator--patient-identification)
7. [Tech Stack](#tech-stack)
8. [Project Structure](#project-structure)
9. [Backend API Reference](#backend-api-reference)
10. [Installation & Running](#installation--running)
11. [Demo Accounts](#demo-accounts)
12. [Testing](#testing)
13. [Configuration](#configuration)
14. [Data Labels & Demo Clarity](#data-labels--demo-clarity)
15. [Known Limitations](#known-limitations)

---

## Highlights

- **One-tap SOS & guided reporting** — self / bystander / crash (with an optional
  confirmation dialog for manual reports).
- **Smart ambulance dispatch** — nearest available unit, distance- and traffic-aware.
- **Google-Maps-style animated navigation** — simulated travel, or opt-in **live GPS**
  readout when the driver permits it.
- **Transparent 2-stage hospital recommendation** — capability eligibility filter, then
  weighted scoring with an explainability breakdown shown in the UI.
- **Parallel admission requests + first-accept-wins** — the top hospitals are asked at once;
  the first to accept gets the patient, and a second hospital accept is rejected server-side.
- **Configurable hospital-request timeout** — unanswered requests expire and re-route or
  escalate to the control room.
- **60-second acceptance cancellation window** — a hospital may cancel its acceptance right
  after accepting; once the window closes the admission locks (control-room override only).
- **Green corridor** — as the ambulance travels, nearby drivers receive a clear-ahead signal.
- **Audit timeline** — every transition is logged with role, action, actor and timestamp.
- **Functional siren** — a real domain event (not a click) triggers the siren; nearby drivers
  in the demo are alerted.
- **Fake-case mitigation** — manual-report confirmation, per-device rate limiting, an advisory
  risk score and suspicious-case flags surfaced in the control room.
- **First-login guided demo** — a two-minute walkthrough on the first login.
- **AI Emergency Orchestrator** — advisory triage, ambulance/hospital recommendation and
  adaptive re-evaluation. Gemini when a key is present, else an audited, deterministic
  fallback (`FALLBACK`-labelled). The AI stays advisory: the engine, not the model, executes.
- **On-device QR patient identification** — bystander camera scan or image upload decoding
  (`html5-qrcode`) plus manual entry; a non-sensitive `patientId` reference is resolved
  server-side and attached to the emergency (`patient:identified`).
- **Adaptive dispatch demo** — traffic degrades the assigned unit's ETA, the AI re-evaluation
  flags `REASSIGN_AMBULANCE` (requires human approval), and the control room approves →
  deterministic reassignment — all streamed live.
- **Live metrics & control-room clarity** — every figure is labelled `SIMULATED`, `LIVE` or
  `DEMO` so the demo never misleads.

---

## Role-Based Dashboards

| Role | Route | What it does |
|------|-------|--------------|
| **Citizen / Reporter** | `/report` | SOS, guided form, crash detection, live tracking of the assigned ambulance. |
| **Ambulance Driver** | `/ambulance` | Accept/reject offers, animated route to patient and hospital, live GPS, siren, request hospital admission, hospital contact `CALL`. |
| **Hospital ER Staff** | `/hospital` | Incoming-patient preview, accept / conditional-accept / decline-with-reason, parallel admission-request cards, 60s countdown, confirm-patient-received, `CALL` buttons. |
| **Control Room Dispatcher** | `/control-room` | All active emergencies, escalations, suspicious-case flags, hospital-request statuses, override routing, false-alarm marking, live feed. |
| **Nearby Driver** | `/driver` | Corridor/siren awareness, alerts for oncoming ambulances. |

Each dashboard is locked to exactly one role (`ProtectedRoute`).

---

## Emergency Lifecycle (State Machine)

Every case moves through an immutable, role-gated state machine (`backend/domain/emergencyEngine.js`).
A transition is only legal for the allowed role(s), from the current status, and with the
required ownership — otherwise the API returns a structured error.

```
REPORTED
   │  (auto) assign nearest available ambulance
   ▼
AMBULANCE_OFFERED ──reject──► (search again / NO_AMBULANCE_AVAILABLE)
   │
   │ accept
   ▼
AMBULANCE_ACCEPTED ──(simulate travel / GPS)──► at-patient
   ▼
AT_PATIENT ──pickup──► PICKED_UP
   │
   │  auto-offer top hospital (HOSPITAL_OFFERED)
   │  or send-hospital-requests → parallel WAITING to top-3
   ▼
HOSPITAL_OFFERED ──accept-patient / conditional-accept / reject-patient────┐
   │                                                                        │ reroute /
   │ first-accept-wins; 60s cancellation window;                            │ escalate
   ▼                                                                        │
TO_HOSPITAL ──arrived-hospital──► ARRIVED_AT_HOSPITAL                       │
   │                                                                        │
   │ handover / confirm-patient-received  (ambulance → AVAILABLE)           │
   ▼                                                                        │
IN_TREATMENT ──discharge──► COMPLETED ◄─────────────────────────────────────┘
```

Crash detection enters the same machine via `POTENTIAL_CRASH → USER_CONFIRMATION →
CONFIRMED_EMERGENCY | USER_CONFIRMED_SAFE`.

**Key transitions** (all in `emergencyEngine.js`):

| Action | Role(s) | Allowed from | Effect |
|--------|---------|--------------|--------|
| `accept` / `reject` | ambulance | AMBULANCE_OFFERED | accept/decline the dispatch |
| `at-patient` | ambulance | AMBULANCE_ACCEPTED | arrived at the patient |
| `pickup` | ambulance | AT_PATIENT | patient picked up; triggers hospital offer |
| `send-hospital-requests` | ambulance, dispatch | PICKED_UP / HOSPITAL_OFFERED / TO_HOSPITAL | ask top eligible hospitals in parallel (WAITING) |
| `accept-patient` / `conditional-accept` / `reject-patient` | hospital | HOSPITAL_OFFERED / TO_HOSPITAL | decision; **first-accept-wins**; reroutes on reject |
| `cancel-accept` | hospital, dispatch | TO_HOSPITAL | cancel only inside the 60s window; else INVALID_STATE / FORBIDDEN |
| `arrived-hospital` | ambulance | TO_HOSPITAL | reached the destination |
| `confirm-patient-received` / `handover` | hospital, dispatch | ARRIVED_AT_HOSPITAL | → IN_TREATMENT, frees the ambulance |
| `discharge` / `complete` | hospital, dispatch | IN_TREATMENT / ARRIVED_AT_HOSPITAL | close the case |
| `escalate` / `dispatch-override` | dispatch | CONTROL_ROOM_ESCALATION / etc. | control-room manual routing |

**Ambulance release rule:** a unit only returns to `AVAILABLE` when the patient enters
`IN_TREATMENT` (handover / confirm-patient-received) — *not* at discharge. A new emergency
is only ever assigned to an `AVAILABLE` unit.

---

## How the Algorithms Work

### 1. Hospital recommendation (two-stage, explainable)
Implemented in `backend/domain/hospitalRecommender.js` + `backend/config/scoringConfig.js`.

1. **Hard-constraint eligibility filter** — a hospital is ineligible if it lacks the
   required specialty/equipment, its emergency capacity is below minimum, or its data is too
   stale (linear age-based penalty: 0.85 fresh → 0.70 stale).
2. **Weighted scoring** (weights sum to 1.0, enforced at startup):
   `0.30 travelTime + 0.20 bedAvailability + 0.20 equipmentCapability + 0.15 specialistAvailability + 0.10 emergencyCapacity + 0.05 currentLoad`.
   Each sub-score is normalised to 0–100. The score **breakdown** is stored per hospital and
   shown in the UI (algorithm transparency).

### 2. Parallel admission requests + first-accept-wins
On `send-hospital-requests`, the engine creates one `waiting` request for up to the top-3
eligible non-rejected recommendations with a shared `deadlineAt`. Any hospital acting on the
case must be the assigned destination **or** hold a pending `waiting` request. When a hospital
accepts:
- its request → `accepted`, all other `waiting` requests → `cancelled` (first-accept-wins),
- the accepting hospital becomes the destination (even if it wasn't the tentative one),
- `acceptanceWindowUntil = now + 60s` (cancellation window opened),
- the request-expiry timer is cleared.

Because the engine is a single Node process, the check-and-set is **atomic** — a second
hospital's `accept-patient` is rejected with HTTP 403.

### 3. Hospital request timeout
A `waiting` request expires after `hospitalRequestMs` (default 60s). Expired requests are
marked `expired`; if none was accepted and none is offered, the engine re-offers the next-best
hospital or escalates to `CONTROL_ROOM_ESCALATION` (emitting `escalation:triggered`).

### 4. 60-second acceptance cancellation window
After a hospital accepts, it has `acceptanceWindowMs` (default 60s) to call `cancel-accept`
(→ reroute, case never ends). Once the window passes, the admission is **locked**
(`admissionLocked`) and only control-room `dispatch-override` can reroute.

### 5. Ambulance dispatch
`assignAmbulance` picks the nearest available unit using a distance × current traffic factor
(`etaCalculator`); the score/ETA is shown in `dispatchNote`.

### 6. Green corridor
`greenCorridor.js` projects a corridor polygon ahead of a travelling ambulance and notifies
registered nearby drivers (`CORRIDOR_CONFIG` width/radius/advance-time).

### 7. Crash detection
`CrashSensorPanel`/server countdown → `POTENTIAL_CRASH` → auto-confirm on silence or
field-confirm via `confirm`.

### 8. Fake-case scoring
See the dedicated section below.

---

## Fake-Case (False Alarm) Mitigation

- **Useful Caution:** risk/rate limiting are **advisory** by design — they flag suspicious
  behaviour without ever blocking a genuine emergency.
- **Manual-report confirmation dialog** — the UI asks "Are you reporting a real emergency?"
  before dispatching.
- **Per-device identity** — the client keeps a stable `deviceId` used to correlate reports.
- **Rate limiting** — `minReportIntervalMs` gates repeated reports from the same reporter.
- **Risk score & flags** — `computeRiskScore` combines cancellation history and repetition;
  it flags at risk ≥ 40 ("Repeated cancellation history") and ≥ 60 ("Suspicious automated
  behavior"), exposed via `reportFlags` and a `case:flagged` event. The control room lists
  every flagged case with its risk score.
- **False-alarm marking** — control room can mark a case as a false alarm; cancellations also
  increment the reporter's history.

---

## AI Emergency Orchestrator & Patient Identification

### AI decision support (`backend/domain/ai/`)

Every emergency report triggers an **advisory pipeline** (fire-and-forget, never blocks the
report): triage → ambulance recommendation. A control-room operator can also trigger an
**adaptive re-evaluation** (`POST /emergencies/:id/reevaluate`) that detects plan degradation
(ETA jump, ambulance/hospital resource loss) and recommends `REASSIGN_AMBULANCE` when a
better unit is available — flagged `requiresHumanApproval: true`.

- **Safety contract**: `AI → structured output → schema validation → deterministic eligibility
  checks → role authorization → engine action`. The AI never calls engine actions; the engine
  remains the source of truth and re-checks every real-world rule.
- **Two sources, honest labels**: Gemini when `GEMINI_API_KEY` is set (`GENERATED`), otherwise
  the deterministic fallback (`FALLBACK`). Everything degrades gracefully.
- **Audit trail**: every decision lands in the emergency's append-only `aiDecisionLog`
  (`AI-###` ids, confidence %, status, why/reasoning) and streams to dashboards as
  `ai:triage`, `ai:recommendation`, `ai:reevaluation`, `ai:decision` + `dispatch:reassigned`.
- **Control room**: the `AIDecisionPanel` renders the live trail; the operator can run a
  re-evaluation and can approve a reassignment (`reassign-ambulance`, dispatch role) which
  the deterministic engine executes against its own fleet rules.

### Bystander patient identification (optional, reference-only)

A bystander can identify the victim by scanning a **patient-reference QR** (camera), by
uploading a QR image (decoded **on-device**, never uploaded past the token), or by manually
entering the reference. `GET /api/patient/lookup/:patientId` resolves it server-side to a
bounded, emergency-safe profile — **no Aadhaar, no phone, no medical history**.

- The QR payload carries only `RESCUEROUTE:PATIENT:<publicId>` (deterministic per user, e.g.
  `PT-B7D6D7`); tampered/unknown tokens return `PATIENT_NOT_FOUND` / `INVALID_PATIENT_REFERENCE`
  and surface as `patient:verification-failed`.
- Attach via `POST /emergencies/:id/patient` → stored as `{ patientId, identificationMethod:
  QR|MANUAL|VEHICLE|AADHAAR_REFERENCE|UNKNOWN, verified, verifiedAt }` → `patient:identified`.
- Demo patient references: `PT-B7D6D7` (Rajesh Kumar), `PT-B7D6D8` (Rahul Kumar), `PT-B7D6D9`
  (Lakshmi Kumar), `PT-B7D6DC` (Sneha Kulkarni).

### Demo scenarios

| Scenario | Endpoint | Demonstrates |
|----------|----------|--------------|
| Full rescue | `POST /demo/full-scenario` | report → accept → pickup → hospital reject → reroute → handover → rating |
| Crash detection | `POST /demo/crash-scenario` | POTENTIAL_CRASH → countdown confirmation |
| **Adaptive dispatch** | `POST /demo/adaptive-dispatch` | QR identify → AI triage → traffic ETA jump → AI re-evaluation → control-room approval → reassign → completed |
| **QR failure** | `POST /demo/unknown-qr` | `patient:verification-failed` with no emergency created |
| **Ambulance shortage** | `POST /demo/ambulance-shortage` | every unit declines → `NO_AMBULANCE_AVAILABLE` → escalation |

---

## Tech Stack

### Frontend (`frontend/` — React 18.2, Create-React-App)
- **React 18 + React Router 6.20** — SPA with role-locked routes.
- **Leaflet + OpenStreetMap** — animated route map (`RouteMap`), live-GPS marker.
- **Socket.IO client** — real-time emergency updates, siren, ambulance movement (`services/socket.js`).
- **React context auth** — role-based demo accounts persisted in `localStorage`.
- **html5-qrcode** — on-device camera / upload decoding of patient-reference QRs (private by design).
- CSS custom properties + per-screen stylesheets; sound via `Web Audio`/`soundManager.js`.

### Backend (`backend/` — Node.js / Express 5)
- **Express** + **CORS** + **Socket.IO** real-time layer (`sockets/rescueSocket.js`).
- **In-memory emergency engine** — the source of truth; no DB required.
- **AI advisory layer** (`domain/ai/`) — Gemini structured outputs with schema validation and
  a deterministic fallback; append-only decision log (`aiDecisionLog`).
- **MongoDB via Mongoose** *(optional)* — schemas exist (`models/`) for persistence if a
  `MONGO_URI` is provided, but the app starts and runs fully without it.
- `dotenv` config, centralized scoring/timing config.

### Real-Time
- **Socket.IO** — `emergency:update`, siren state, ambulance movement, corridor signals.

---

## Project Structure

```
RescueRoute/
├── backend/                 # Node/Express + Socket.IO server, engine (source of truth)
│   ├── app.js               # Express app, CORS, mounts routes (incl. /api/v1)
│   ├── server.js            # entry point (port 5001)
│   ├── config/
│   │   └── scoringConfig.js # centralised weights, thresholds, timeouts
│   ├── controllers/         # express handlers (emergency, hospital, ambulance, traffic…)
│   ├── domain/
│   │   ├── emergencyEngine.js    # lifecycle state machine + risk scoring + timeouts
│   │   ├── hospitalRecommender.js# two-stage recommendation
│   │   ├── greenCorridor.js      # corridor projection + driver notifications
│   │   ├── demoMode.js           # deterministic end-to-end / crash scenarios
│   │   └── bus.js                # Node EventEmitter for domain events
│   ├── models/              # optional Mongoose schemas (Emergency, User, MedicalProfile)
│   ├── routes/              # REST route definitions
│   ├── sockets/rescueSocket.js # Socket.IO wiring
│   ├── test/emergencyEngine.test.js # 33 unit tests
│   ├── utils/               # etaCalculator, rescueScoreLogic, signalLogic
│   └── services/            # notificationService
│
└── frontend/                # React SPA (Create-React-App), port 3000
    ├── public/
    └── src/
        ├── App.js           # routes (role-locked)
        ├── context/AuthContext.js  # demo accounts, login/register
        ├── components/      # RouteMap, StatusBadge, DataLabel, icons, AlertBanner,
        │                    # GreenCorridorStatus, HospitalRecommendations, CrashSensor,
        │                    # Navbar, Footer, SoundCenter, ProtectedRoute …
        ├── pages/           # Home, Login, Demo, Reporter, Ambulance, Hospital,
        │                    # ControlRoom, DriverScreen, Assistant, FamilyEmergency…
        ├── services/        # api, socket, authApi, soundManager, location, uiRole…
        └── utils/           # time, helpers, rescueScore, vibrationPatterns
```

---

## Backend API Reference

Base URL: `http://<host>:5001`

### Unified v1 API (`/api/v1`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/emergencies` | Create a report (self / bystander / crash). Triggers the advisory AI pipeline. |
| GET | `/emergencies` | List emergencies (`?activeOnly`, `?status`). |
| GET | `/emergencies/admission-requests?hospitalId=` | Cases with a WAITING admission request for that hospital. |
| GET | `/emergencies/:id` | Single emergency detail. |
| POST | `/emergencies/:id/actions` | Apply a role-gated action (see state table). Body: `{ role, action, ambulanceId?, hospitalId?, ... }`. |
| POST | `/emergencies/:id/patient` | Attach a resolved patient reference. Body: `{ patientId, identificationMethod, verified?, details? }`. |
| GET | `/emergencies/:id/ai` | AI decision trail (`aiDecisionLog`) for the emergency. |
| POST | `/emergencies/:id/reevaluate` | Run an advisory AI re-evaluation (plan-degradation check). |
| POST | `/emergencies/:id/siren` | Toggle the ambulance siren. |
| GET | `/emergencies/:id/recommendations` | Explainable hospital recommendations. |
| POST | `/emergencies/:id/resources` | Hospital updates its resource freshness. |
| GET | `/ambulances` | List ambulances (+ status, contact). |
| POST | `/ambulances/:id/move` | Update a unit's live position. |
| GET | `/hospitals` | List hospitals (+ beds, load, contact). |
| GET | `/status` | Control-room overview (active counts, available units). |
| GET | `/metrics` | Live metrics. |
| GET | `/scoring-config` | Exposed weights/thresholds for transparency. |
| GET | `/green-corridor/:emergencyId` | Corridor state for an emergency. |
| POST | `/demo/reset` | Reset in-memory state (also clears AI plan trackers). |
| POST | `/demo/full-scenario` | Deterministic end-to-end demo. |
| POST | `/demo/crash-scenario` | Crash-detection demo. |
| POST | `/demo/adaptive-dispatch` | AI adaptive-dispatch demo (traffic → re-plan → reassign). |
| POST | `/demo/unknown-qr` | QR identification-failure demo. |
| POST | `/demo/ambulance-shortage` | All-units-decline → escalation demo. |

The patient lookup endpoints live under `/api/patient` (singular base, matching the frontend):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/patient/lookup/:patientId` | Resolve a patient-reference QR token (`PT-…`) to an emergency-safe profile. |

Other mount points: `/api/ambulance`, `/api/hospital`, `/api/traffic`, `/api/vehicles`,
`/api/family-emergency`, `/api/auth`.

---

## Installation & Running

> Pick whichever repo path applies. You need **two terminals** (backend + frontend).

```bash
# 1) Install backend deps
cd backend
npm install

# 2) (Optional, for MongoDB) copy .env.example to .env and set MONGO_URI
#    The app runs fine WITHOUT Mongo.

# 3) Start the backend on :5001
npm start          # or: npm run dev  (nodemon)
```

```bash
# 4) Install frontend deps (from the repo root)
cd frontend
npm install

# 5) Start the frontend on :3000
npm start
# Open http://localhost:3000
```

> If frontend and backend live on different machines on the same LAN, the frontend derives
> the backend host from the page hostname automatically (`http://<laptop-ip>:5001`) — or set
> `REACT_APP_API_URL` to override.

### Environment variables (backend)
| Variable | Purpose |
|----------|---------|
| `PORT` | Backend port (default `5001`). |
| `MONGO_URI` | *(optional)* MongoDB connection string. If absent, the in-memory engine runs. |
| `GEMINI_API_KEY` | *(optional)* Google AI key. When set, the orchestrator uses Gemini for triage/recommendation/re-evaluation (`GENERATED` entries); when absent it uses the audited deterministic fallback (`FALLBACK` entries). |

---

## Demo Accounts

All seeded demo accounts use the password **`password`**. They appear in the **Login →
Demo accounts** dropdown, and can also be created new via **Create account**.

| Username | Role | Notes |
|----------|------|-------|
| `citizen` / `citizen1` / `citizen2` / `citizen3` | Citizen / Reporter | `citizen` = primary demo citizen. |
| `driver.amb` / `ambulance1` / `ambulance2` / `ambulance3` | Ambulance Driver | Bound to AMB-001/002/003. |
| `er.staff` / `hospital1` / `hospital2` / `hospital3` | Hospital ER Staff | Bound to HOSP-001/002/003/005. |
| `control` | Control Room Dispatcher | Single dispatcher account. |
| `nearby` / `driver1` / `driver2` / `driver3` | Nearby Driver | Corridor/siren awareness demo. |

> **Work-in-progress login flow:** logging in with an existing username or creating a new
> account both work — the demo list is merged (never wiping user-created accounts) on each load.

---

## Testing

```bash
# Backend unit tests (33 tests, Node's built-in test runner)
cd backend
npm test
# or, if `npm test` hits a MODULE_NOT_FOUND dir-glob quirk, run files directly:
node --test test/emergencyEngine.test.js

# Frontend production build (ESLint treated as errors under CI)
cd frontend
CI=true npm run build
```

Covered behaviours include: dispatch, hospital acceptance/reject/conditional-accept, reroute
and escalation, crash detection, parallel admission requests + **first-accept-wins**, the
invalid "second hospital" FORBIDDEN path, the 60s cancellation window (in-window success,
after-window lock + control-room override), `confirm-patient-received` freeing the ambulance,
reusing a freed ambulance, and report-risk flagging.

The AI re-evaluation/reassignment path is covered by a live smoke flow: `POST /demo/adaptive-dispatch`
then `GET /emergencies/:id/ai` shows `ai:triage`, `ai:recommendation`, `ai:reevaluation`
(REASSIGN, requires human approval) and the applied `ai:decision` entry.

---

## Configuration

Centralised in `backend/config/scoringConfig.js`:

- `WEIGHTS` — hospital scoring weights (must sum to 1.0).
- `HARD_CONSTRAINTS` — eligibility thresholds and escalation cap (`maxRejectionsBeforeEscalation: 3`).
- `REJECT_REASONS` — the authorized, reason-gated decline options.
- `CORRIDOR_CONFIG` — green-corridor geometry.
- `CRASH_DETECTION` — crash thresholds, countdown.
- `TIMEOUTS` — `hospitalRequestMs` (60s), `acceptanceWindowMs` (60s),
  `cancelHistoryThreshold` (3), `minReportIntervalMs` (30s).

All are exposed via `GET /scoring-config` and adjustable at runtime through engine setters.

---

## Data Labels & Demo Clarity

Every dynamic figure is marked so users can tell **real** from **simulated**:

- `LIVE` — real live value (e.g. active count).
- `SIMULATED` — simulated (e.g. ETA, travel, hospital-request deadline).
- `DEMO` — demo-only data (e.g. bed counts, saved-profile fields).

---

## Known Limitations

- The risk score / rate limiting are **advisory** (they never block a real emergency).
- `CALL` buttons use `tel:` links — no telephony/Firebase push integration in this build.
- Mongo persistence is optional; the in-memory engine means a long-lived server only
  reflects cases created since its last restart (a fresh process is the clean demo baseline).
- Animated navigation interpolates between waypoints; real GPS is opt-in and replaces the
  simulation when the driver allows it.
- Single-process, single-instance assumption for the atomic first-accept-wins guarantee.
- **AI is advisory, not autonomous** — no Gemini key means every entry is deterministic
  `FALLBACK`; a re-evaluation recommendation always requires human approval, and the control
  room executes (never the model).
- **Reassignment is pre-pickup** — `reassign-ambulance` is only allowed while the case is
  `AMBULANCE_OFFERED` / `AMBULANCE_ACCEPTED` (dispatch role), keeping the patient safe.
- **QR refs are reference-only** — lookup never returns Aadhaar, phone or medical history;
  a STOLEN QR only leaks a sparse emergency profile, and the OS/service telemetry emits
  `patient:verification-failed` rather than creating a case.