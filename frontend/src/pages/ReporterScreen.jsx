import React, { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import "./ReporterScreen.css";
import api from "../services/api";
import { getCurrentLocation } from "../services/location";
import socketService, { EVENTS } from "../services/socket";
import { setUiRole, setTrackedEmergency } from "../services/uiRole";
import { useAuth } from "../context/AuthContext";
import StatusBadge, { statusInfo } from "../components/StatusBadge";
import DataLabel from "../components/DataLabel";
import AiFirstAid from "../components/AiFirstAid";
import CrashSensorPanel from "../components/CrashSensor";
import { CrashBanner } from "../components/AlertBanner";
import GreenCorridorStatus from "../components/GreenCorridorStatus";
import Icon from "../components/Icon";
import { formatClock, timeAgo } from "../utils/time";
import PatientIdentify from "../components/PatientIdentify";

const SEVERITIES = [
  { id: "minor", label: "Minor", hint: "Conscious, able to walk" },
  { id: "moderate", label: "Moderate", hint: "Injured, needs help" },
  { id: "critical", label: "Critical", hint: "Unconscious / severe injuries" },
];

// Stable per-device identifier used to rate-limit / flag suspicious reporting.
function getDeviceId() {
  let id = localStorage.getItem("rr_device_id");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("rr_device_id", id);
  }
  return id;
}

/**
 * ReporterScreen — the ONE place an emergency starts (self, bystander for an
 * unconscious person, or crash auto-detect) and where the reporter / family
 * track what is happening live.
 */
export default function ReporterScreen() {
  const [params] = useSearchParams();
  const trackedParam = params.get("eid");

  return trackedParam ? (
    <Tracker emergencyId={trackedParam} familyView />
  ) : (
    <ReporterFlow />
  );
}

/* ============================ REPORT FLOW ============================ */

function ReporterFlow() {
  const { user } = useAuth();
  const [step, setStep] = useState("who"); // who | sos | identify | details | track | crash
  const [who, setWho] = useState("self"); // self | bystander | crash
  const [identifiedPatient, setIdentifiedPatient] = useState(null);
  const [trackedId, setTrackedId] = useState(localStorage.getItem("rr_tracked"));
  const [emergency, setEmergency] = useState(null);
  const [crashId, setCrashId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const locationRef = useRef(null);

  // subscribe to live updates while tracking
  useEffect(() => {
    if (!trackedId) return;
    setUiRole("reporter");
    setTrackedEmergency(trackedId);
    api.getEmergency(trackedId).then(({ emergency }) => setEmergency(emergency)).catch(() => {});
    const key = socketService.on(EVENTS.EMERGENCY_UPDATE, (data) => {
      if (data.emergencyId === trackedId) setEmergency(data);
    });
    return () => {
      socketService.off(EVENTS.EMERGENCY_UPDATE, key);
      setTrackedEmergency(null);
    };
  }, [trackedId]);

  const startTrack = (id) => {
    setTrackedId(id);
    localStorage.setItem("rr_tracked", id);
  };

  if (trackedId && emergency) {
    return (
      <TrackView
        emergency={emergency}
        onBack={() => {
          setTrackedId(null);
          localStorage.removeItem("rr_tracked");
          setEmergency(null);
        }}
      />
    );
  }

  const sendEmergency = async (payload) => {
    setSubmitting(true);
    setError(null);
    try {
      let location = locationRef.current;
      if (!location || !location.lat) {
        const geo = await getCurrentLocation();
        locationRef.current = geo;
        location = geo;
      }
      const res = await api.createEmergency({
        ...payload,
        reporter: { ...payload.reporter, ...(user?.username ? { username: user.username } : {}), deviceId: getDeviceId() },
        location: { lat: location.lat, lng: location.lng, label: location.label },
      });
      return res.emergency.emergencyId;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setSubmitting(false);
    }
  };

  // Crash flow is SERVER-DRIVEN: the sensor spike creates a CRASH_DETECTION
  // case in state POTENTIAL_CRASH. The countdown below confirms or clears it
  // through the API, and the server auto-confirms if nobody responds.
  const beginCrash = async (confidence) => {
    const id = await sendEmergency({
      kind: "CRASH_DETECTION",
      crashConfidence: typeof confidence === "number" ? confidence : 87,
      reporter: { name: user?.name || "Crash detection", via: "crash" },
      patient: {
        name: user?.name || "Unknown",
        age: user?.age ?? null,
        bloodGroup: user?.bloodGroup || "Unknown",
        allergies: user?.allergies || "None listed",
        condition: "POSSIBLE CRASH — awaiting confirmation",
        severity: "critical",
      },
    });
    if (!id) return;
    setCrashId(id);
    setStep("crash");
  };

  const crashRespond = async (okay) => {
    if (!crashId) return;
    setSubmitting(true);
    try {
      await api.applyAction(crashId, {
        role: "reporter",
        action: okay ? "crash-confirm-safe" : "crash-confirm-emergency",
      });
      if (okay) {
        setWho("self");
        setStep("okay");
      } else {
        startTrack(crashId);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async (patient, reporter, severity) => {
    const id = await sendEmergency({
      kind: who === "self" ? "SELF_USE" : who === "bystander" ? "BYSTANDER" : "CRASH_ALERT",
      reporter: { name: reporter.name || "Anonymous", via: who },
      patient: { ...patient, severity, condition: patient.condition || severity },
    });
    if (id) startTrack(id);
  };

  // One-tap SOS: skips the manual form and sends the citizen's saved profile.
  const fireSos = async () => {
    const profile = user || {};
    const id = await sendEmergency({
      kind: "SELF_USE",
      reporter: {
        name: profile.name || "Anonymous",
        via: "self",
        ...(profile.emergencyContact ? { emergencyContact: profile.emergencyContact } : {}),
      },
      patient: {
        name: profile.name || "Unknown",
        age: profile.age ?? null,
        bloodGroup: profile.bloodGroup || "Unknown",
        allergies: profile.allergies || "None listed",
        condition: "One-tap SOS pressed",
        severity: "moderate",
      },
    });
    if (id) startTrack(id);
  };

  return (
    <div className="rr-page">
      <header className="page-hero">
        <div className="container page-hero-inner">
          <div>
            <h1>Report an Emergency</h1>
            <p className="muted">One press sends help. You'll see everything happening in real time.</p>
          </div>
          <DataLabel kind="simulated">DEMO SYSTEM</DataLabel>
        </div>
      </header>

      <div className="container rr-body">
        {step === "who" && (
          <>
            <SosPanel onTrigger={() => setStep("sos")} disabled={submitting} />
            <CrashSensorPanel
              onSpike={(confidence) => beginCrash(confidence)}
              onSimulate={(confidence) => beginCrash(confidence)}
            />
            <WhoStep
              who={who}
              setWho={setWho}
              onCrash={() => beginCrash(90)}
              onNext={() => {
                if (who === "crash") beginCrash(90);
                else if (who === "bystander") setStep("identify");
                else setStep("details");
              }}
            />
          </>
        )}

        {step === "sos" && (
          <SosPrompt
            profile={user}
            submitting={submitting}
            error={error}
            onCancel={() => setStep("who")}
            onConfirm={fireSos}
          />
        )}

        {step === "crash" && who === "crash" && (
          <CrashCheckIn
            submitting={submitting}
            onNo={() => crashRespond(true)}
            onYes={() => crashRespond(false)}
          />
        )}

        {step === "okay" && (
          <section className="crash-check">
            <div className="card crash-card good">
              <span className="crash-icon"><Icon name="ok" size={34} className="icon-ok" /></span>
              <h2>You said you're okay.</h2>
              <p className="muted">No emergency was sent. If anything changes, report an emergency below.</p>
              <div className="rr-actions">
                <button
                  className="btn btn-blue"
                  onClick={() => {
                    setWho("self");
                    setStep("who");
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "identify" && (
          <PatientIdentify
            onManualEntry={() => { setIdentifiedPatient(null); setStep("details"); }}
            onPatientConfirmed={(person) => {
              setIdentifiedPatient(person);
              setStep("details");
            }}
          />
        )}

        {step === "details" && (
          <DetailsStep
            who={who}
            identifiedPatient={identifiedPatient}
            onBack={() => identifiedPatient ? setStep("identify") : setStep("who")}
            onSubmit={submit}
            submitting={submitting}
            error={error}
            getLocation={() => getCurrentLocation().then((l) => (locationRef.current = l))}
          />
        )}

        {step === "track" && (
          <div className="empty-state">
            Opening live tracking… <span className="spin" />
          </div>
        )}

        <section className="rr-ai">
          <AiFirstAid />
        </section>
      </div>
    </div>
  );
}

function WhoStep({ who, setWho, onNext, onCrash }) {
  const options = [
    { id: "self", icon: "sos", title: "Report for myself", desc: "I need help right now", danger: true },
    { id: "bystander", icon: "user", title: "Report for someone unconscious", desc: "The injured person can't use a phone", danger: false },
    { id: "crash", icon: "crash", title: "Crash detected — are you okay?", desc: "Simulate a sudden impact check-in", danger: false },
  ];
  return (
    <section>
      <div className="section-title">Who is this for?</div>
      <div className="rr-who-grid">
        {options.map((o) => (
          <button
            key={o.id}
            className={`card rr-who-card ${who === o.id ? "selected" : ""} ${o.danger && who === o.id ? "danger-selected" : ""}`}
            onClick={() => setWho(o.id)}
          >
            <span className="rr-who-icon"><Icon name={o.icon} size={28} /></span>
            <strong>{o.title}</strong>
            <span className="muted">{o.desc}</span>
          </button>
        ))}
      </div>
      <div className="rr-actions">
        <button className="btn btn-blue" onClick={() => (who === "crash" ? onCrash() : onNext())}>
          Continue →
        </button>
      </div>
    </section>
  );
}

function SosPanel({ onTrigger, disabled }) {
  return (
    <section className="sos-panel">
      <button className="sos-button" onClick={onTrigger} disabled={disabled} aria-label="One-tap SOS">
        <span className="sos-ring" />
        <Icon name="sos" size={44} />
        <strong>One-tap SOS</strong>
      </button>
      <p className="sos-panel-note">
        <strong>SOS</strong> skips the form — help is sent with your saved profile
        (age, blood group, allergies, emergency contact).
      </p>
    </section>
  );
}

function SosPrompt({ profile, submitting, error, onCancel, onConfirm }) {
  const [count, setCount] = useState(10);
  const fired = useRef(false);

  const confirm = () => {
    if (fired.current || submitting) return;
    fired.current = true;
    onConfirm();
  };

  useEffect(() => {
    if (count <= 0) {
      confirm();
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const fields = [
    ["Age", profile?.age ?? "—"],
    ["Blood group", profile?.bloodGroup || "Unknown"],
    ["Allergies", profile?.allergies || "None listed"],
    ["Emergency contact", profile?.emergencyContact || "—"],
  ];

  return (
    <section className="crash-check">
      <div className="card crash-card">
        <span className="crash-icon"><Icon name="sos" size={36} className="icon-alert" /></span>
        <h2>One-tap SOS — help is on the way</h2>
        <p className="muted">Your saved profile is auto-filled below. Cancel to abort.</p>
        <div className={`crash-count ${count <= 3 ? "urgent" : ""}`}>{count}</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          {fields.map(([k, v]) => `${k}: ${v}`).join("  ·  ")}
        </p>
        {error && <div className="error-box">{error}</div>}
        <div className="rr-actions" style={{ justifyContent: "center" }}>
          <button className="btn btn-green" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button className="btn btn-red" onClick={confirm} disabled={submitting}>
            {submitting ? <><span className="spin" /> Sending…</> : "Send SOS now"}
          </button>
        </div>
      </div>
    </section>
  );
}

function CrashCheckIn({ submitting, onNo, onYes }) {
  const [count, setCount] = useState(10);

  useEffect(() => {
    if (count <= 0) {
      onYes(); // no response -> report help
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  return (
    <section className="crash-check">
      <div className="card crash-card">
        <span className="crash-icon"><Icon name="alert" size={34} className="icon-alert" /></span>
        <h2>Crash detected — are you okay?</h2>
        <p className="muted">
          A potential-crash case was created automatically. If you don't respond, emergency
          services are alerted automatically.
        </p>
        <div className={`crash-count ${count <= 3 ? "urgent" : ""}`}>{count}</div>
        <div className="rr-actions">
          <button className="btn btn-green" onClick={onNo} disabled={submitting}>I'm okay — dismiss</button>
          <button className="btn btn-red" onClick={onYes} disabled={submitting}>
            {submitting ? <><span className="spin" /> Confirming…</> : "I need help"}
          </button>
        </div>
      </div>
    </section>
  );
}

function DetailsStep({ who, identifiedPatient, onBack, onSubmit, submitting, error, getLocation }) {
  const [patient, setPatient] = useState(() => {
    if (identifiedPatient) {
      return {
        name: identifiedPatient.name || "",
        age: identifiedPatient.age?.toString() || "",
        bloodGroup: identifiedPatient.bloodGroup || "",
        allergies: identifiedPatient.allergies || "None",
        condition: "",
        identificationMethod: identifiedPatient.identificationMethod || "UNKNOWN",
        patientId: identifiedPatient.patientId || null,
      };
    }
    return {
      name: "",
      age: "",
      bloodGroup: "",
      allergies: "None",
      condition: "",
      identificationMethod: who === "self" ? "UNKNOWN" : "MANUAL",
      patientId: null,
    };
  });
  const [reporter, setReporter] = useState({ name: "" });
  const [severity, setSeverity] = useState("moderate");
  const [loc, setLoc] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const set = (k) => (e) => setPatient((p) => ({ ...p, [k]: e.target.value }));

  const confirmLocation = async () => {
    const l = await getLocation();
    if (l) setLoc(l);
  };

  return (
    <section>
      <div className="section-title">{who === "self" ? "Your details" : who === "bystander" ? (identifiedPatient ? `Patient: ${identifiedPatient.name}` : "Details of the person who needs help") : "Crash check-in details"}</div>
      <div className="section-sub">This info is sent to the ambulance crew before they arrive.</div>

      {identifiedPatient && (
        <div className="rr-identified-badge">
          <span className="rr-identified-icon">✓</span>
          <span>
            Patient identified via RescueRoute lookup
            {identifiedPatient.identificationMethod ? ` (${identifiedPatient.identificationMethod})` : ""}
          </span>
          <DataLabel kind="simulated">AUTO-FILLED</DataLabel>
        </div>
      )}

      <div className="rr-form card">
        <div className="rr-grid2">
          <label>
            <span>Patient name</span>
            <input value={patient.name} onChange={set("name")} placeholder="Full name" />
          </label>
          <label>
            <span>Age</span>
            <input type="number" value={patient.age} onChange={set("age")} placeholder="e.g. 34" />
          </label>
          <label>
            <span>Blood group</span>
            <select value={patient.bloodGroup} onChange={set("bloodGroup")}>
              <option value="">Unknown</option>
              {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Allergies</span>
            <input value={patient.allergies} onChange={set("allergies")} placeholder="e.g. Penicillin" />
          </label>
        </div>

        <label className="rr-full">
          <span>What happened?</span>
          <textarea rows="2" value={patient.condition} onChange={set("condition")} placeholder="e.g. heavy bleeding, chest pain, unconscious…" />
        </label>

        <div className="rr-sev">
          <span className="rr-label">Severity</span>
          <div className="rr-sev-row">
            {SEVERITIES.map((s) => (
              <button
                key={s.id}
                className={`rr-sev-btn ${severity === s.id ? "on" : ""} ${s.id === "critical" ? "crit" : ""}`}
                onClick={() => setSeverity(s.id)}
              >
                <strong>{s.label}</strong>
                <span className="muted">{s.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rr-box">
          <span className="rr-label"><Icon name="location" size={14} /> Location</span>
          {loc ? (
            <div>
              <span className="mono">{loc.label || `Lat ${loc.lat.toFixed(4)}, Lng ${loc.lng.toFixed(4)}`}</span>
              <DataLabel kind="simulated">AUTO-DETECTED</DataLabel>
            </div>
          ) : (
            <button className="btn btn-ghost" onClick={confirmLocation}>
              <Icon name="location" size={14} /> Confirm my location
            </button>
          )}
        </div>

        <label className="rr-full">
          <span>Your name (reporter)</span>
          <input value={reporter.name} onChange={(e) => setReporter({ name: e.target.value })} placeholder="Optional" />
        </label>

        {error && <div className="error-box">{error}</div>}

        <div className="rr-actions">
          <button className="btn btn-ghost" onClick={onBack} disabled={submitting}>
            ← Back
          </button>
          <button
            className="btn btn-red"
            disabled={submitting}
            onClick={() => setConfirming(true)}
          >
            {submitting ? <><span className="spin" /> Sending…</> : <><Icon name="sos" size={16} /> Send Emergency Alert</>}
          </button>
        </div>
      </div>

      {confirming && (
        <div className="confirm-mask" onClick={() => setConfirming(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-modal-icon"><Icon name="alert" size={40} /></div>
            <h3>Confirm Emergency</h3>
            <p className="muted">Are you reporting a real emergency requiring immediate assistance?</p>
            <div className="rr-actions">
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
              <button
                className="btn btn-red"
                disabled={submitting}
                onClick={() => { setConfirming(false); onSubmit(patient, reporter, severity); }}
              >
                {submitting ? <><span className="spin" /> Sending…</> : "CONFIRM EMERGENCY"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ============================ TRACK VIEW ============================ */

function Tracker({ emergencyId, familyView }) {
  const [emergency, setEmergency] = useState(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setUiRole("reporter");
    setTrackedEmergency(emergencyId);
    api.getEmergency(emergencyId).then(({ emergency }) => setEmergency(emergency)).catch(() => setNotFound(true));
    const key = socketService.on(EVENTS.EMERGENCY_UPDATE, (data) => {
      if (data.emergencyId === emergencyId) setEmergency(data);
    });
    return () => {
      socketService.off(EVENTS.EMERGENCY_UPDATE, key);
      setTrackedEmergency(null);
    };
  }, [emergencyId]);

  if (notFound) return <div className="container empty-state">No emergency found with code {emergencyId}.</div>;
  if (!emergency) return <div className="container empty-state"><span className="spin" /> Loading…</div>;

  return <TrackView emergency={emergency} familyView={familyView} />;
}

function TrackView({ emergency, familyView, onBack }) {
  const [copied, setCopied] = useState(false);
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [ratingComment, setRatingComment] = useState("");
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  const [rated, setRated] = useState(!!emergency.hospitalRating);
  const tone = statusInfo(emergency.status).tone;
  const active = !["COMPLETED", "CANCELLED"].includes(emergency.status);
  const showRating = !familyView && ["IN_TREATMENT", "COMPLETED"].includes(emergency.status) && emergency.hospitalId && !rated;

  async function submitRating() {
    if (rating === 0 || ratingSubmitting) return;
    setRatingSubmitting(true);
    try {
      await api.applyAction(emergency.emergencyId, { role: "reporter", action: "rate-hospital", rating, ratingComment });
      setRated(true);
    } catch { /* ignored */ }
    setRatingSubmitting(false);
  }

  return (
    <div className="rr-page">
      <header className={`page-hero ${!active ? "muted-hero" : ""}`}>
        <div className="container page-hero-inner">
          <div>
            <h1>{familyView ? "Family / Friend Tracking" : "Your Emergency — live status"}</h1>
            <p className="muted">Every update below is pushed by the system in real time.</p>
          </div>
          <StatusBadge status={emergency.status} />
        </div>
      </header>

      <div className="container rr-track">
        <CrashBanner emergency={emergency} />
        <GreenCorridorStatus corridor={emergency.greenCorridor} emergency={emergency} />

        <div className="rr-track-grid">
          <section className="card rr-card-details">
            <div className="section-title" style={{ fontSize: 18 }}>Patient</div>
            <p><strong>{emergency.patient.name}</strong> · {emergency.patient.age || "?"} yrs · {emergency.patient.bloodGroup}</p>
            <p className="muted">Allergies: {emergency.patient.allergies}</p>
            <p className="muted">Condition: {emergency.patient.condition || emergency.patient.severity}</p>
            <p className="mono" style={{ fontSize: 12 }}><Icon name="location" size={12} /> {emergency.location.label}</p>

            <div className="rr-assign">
              <div>
                <span className="rr-label">Ambulance</span>
                <p>{emergency.ambulance ? emergency.ambulance.name : "— searching —"}</p>
                {emergency.etaToPatient && <small className="muted">ETA to patient: <DataLabel kind="simulated">{emergency.etaToPatient}</DataLabel></small>}
              </div>
              <div>
                <span className="rr-label">Hospital</span>
                <p>{emergency.hospital ? emergency.hospital.name : "Not selected yet"}</p>
                {emergency.etaToHospital && <small className="muted">ETA: <DataLabel kind="simulated">{emergency.etaToHospital}</DataLabel></small>}
              </div>
            </div>

            <div className="rr-share">
              <span className="rr-label">Share code (family can track)</span>
              <div className="rr-share-row">
                <code>{`/report?eid=${emergency.emergencyId}`}</code>
                <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/report?eid=${emergency.emergencyId}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
          </section>

          <section className="card rr-card-timeline">
            <div className="section-title" style={{ fontSize: 18 }}>Timeline</div>
            <div className="rr-timeline">
              {emergency.timeline.map((t, i) => (
                <div key={i} className="rr-tl-item">
                  <span className={`rr-tl-dot ${tone}`} />
                  <div>
                    <strong>{t.detail}</strong>
                    <small className="muted">{formatClock(t.at)} · {timeAgo(t.at)} · by {t.role}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {showRating && (
          <div className="card rr-rate-panel">
            <div className="section-title" style={{ fontSize: 18 }}>Rate your experience</div>
            <p className="muted" style={{ marginBottom: 12 }}>
              How would you rate the hospital care you (or your loved one) received?
            </p>
            <div className="rr-rate-stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`rr-star ${n <= (hoverRating || rating) ? "filled" : ""}`}
                  onClick={() => setRating(n)}
                  onMouseEnter={() => setHoverRating(n)}
                  onMouseLeave={() => setHoverRating(0)}
                >
                  ★
                </button>
              ))}
              {rating > 0 && <span className="rr-rate-label">{rating}/5</span>}
            </div>
            <textarea
              rows="2"
              placeholder="Optional — any comments about the care, facilities or staff…"
              value={ratingComment}
              onChange={(e) => setRatingComment(e.target.value)}
              style={{ width: "100%", marginTop: 10, padding: 8, borderRadius: 6, border: "1px solid #333", background: "#111", color: "#eee", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn btn-green" onClick={submitRating} disabled={rating === 0 || ratingSubmitting}>
                {ratingSubmitting ? "Submitting…" : "Submit rating"}
              </button>
            </div>
          </div>
        )}

        {rated && !showRating && emergency.hospitalRating && (
          <div className="card rr-rate-panel" style={{ opacity: 0.85 }}>
            <div className="section-title" style={{ fontSize: 18 }}>Your rating</div>
            <div className="rr-rate-stars" style={{ marginBottom: 4 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className={`rr-star ${n <= emergency.hospitalRating.score ? "filled" : ""}`}>★</span>
              ))}
              <span className="rr-rate-label">{emergency.hospitalRating.score}/5</span>
            </div>
            {emergency.hospitalRating.comment && <p className="muted" style={{ fontSize: 13 }}>"{emergency.hospitalRating.comment}"</p>}
          </div>
        )}

        {onBack && (
          <button className="btn btn-ghost" onClick={onBack}>
            ← Back to reporting
          </button>
        )}

        {active && <AiFirstAid />}
      </div>
    </div>
  );
}

export { ReporterFlow };