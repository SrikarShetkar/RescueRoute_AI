import React, { useState } from "react";
import QrScanner from "./QrScanner";
import QRUpload from "./QRUpload";
import PatientSelect from "./PatientSelect";
import patientApi from "../services/patientApi";
import Icon from "./Icon";
import "./PatientIdentify.css";

const PATIENT_REF_PREFIX = "RESCUEROUTE:PATIENT:";

/** True when the scanned/typed token is a patient reference QR (not a vehicle QR). */
function isPatientReference(raw) {
  const t = String(raw || "").trim().toUpperCase();
  if (t.includes(PATIENT_REF_PREFIX)) return true;
  return /^PT-[A-F0-9]{6}$/.test(t);
}

/** Extract just the public patient id from a full QR payload. */
function stripPatientPrefix(raw) {
  const t = String(raw || "").trim();
  const idx = t.toUpperCase().indexOf(PATIENT_REF_PREFIX);
  return idx !== -1 ? t.slice(idx + PATIENT_REF_PREFIX.length) : t;
}

/** Demo cards to make the flow testable without a physical card. */
const DEMO_PATIENT_REFS = [
  { ref: "PT-B7D6D7", label: "Rajesh Kumar" },
  { ref: "PT-B7D6D8", label: "Rahul Kumar" },
  { ref: "PT-B7D6DC", label: "Sneha Kulkarni" },
];

/**
 * PatientIdentify — Main identification interface for bystander mode.
 * Methods: QR camera scan, QR image upload, Vehicle Number, Aadhaar, Manual.
 * A patient-reference QR (RESCUEROUTE:PATIENT:<id>) resolves directly to one
 * verified patient; a vehicle QR resolves to the registered people list.
 */
export default function PatientIdentify({ onManualEntry, onPatientConfirmed }) {
  const [mode, setMode] = useState(null); // null | qr | upload | vehicle | aadhaar | manual
  const [vehicleInput, setVehicleInput] = useState("");
  const [aadhaarInput, setAadhaarInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lookupResult, setLookupResult] = useState(null);
  const [showScanner, setShowScanner] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  const reset = () => {
    setMode(null);
    setVehicleInput("");
    setAadhaarInput("");
    setError(null);
    setLookupResult(null);
    setLoading(false);
    setShowScanner(false);
    setShowUpload(false);
  };

  // --- Resolve any QR token (patient reference OR vehicle QR) ---
  const handleToken = async (token) => {
    setShowScanner(false);
    setShowUpload(false);
    setLoading(true);
    setError(null);
    try {
      if (isPatientReference(token)) {
        const res = await patientApi.lookupByPatientId(stripPatientPrefix(token));
        const patient = res.patient;
        // emergency-relevant subset only; keep the verified public reference
        setLookupResult({
          people: [{ ...patient, medicalHistory: patient.criticalConditions || [] }],
          vehicleNumber: null,
          isSingleProfile: true,
          identifiedBy: "QR",
          identificationMethod: "QR",
          patientId: patient.patientId || patient.id,
        });
      } else {
        const result = await patientApi.lookupByQr(token);
        setLookupResult({ ...result, identificationMethod: "VEHICLE" });
      }
    } catch (err) {
      setError(
        err.code === "PATIENT_NOT_FOUND"
          ? "Patient record could not be found. Use another method or report manually."
          : err.message || "Invalid or expired QR code."
      );
    } finally {
      setLoading(false);
    }
  };

  // --- Vehicle Number Lookup ---
  const handleVehicleLookup = async () => {
    const num = vehicleInput.trim();
    if (!num) { setError("Please enter a vehicle number."); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await patientApi.lookupByVehicle(num);
      setLookupResult({ ...result, identificationMethod: "VEHICLE" });
    } catch (err) {
      setError(err.message || "Vehicle not found. Check the number and try again.");
    } finally {
      setLoading(false);
    }
  };

  // --- Aadhaar Lookup ---
  const handleAadhaarLookup = async () => {
    const num = aadhaarInput.replace(/\s/g, "").trim();
    if (!num || num.length !== 12) { setError("Please enter a valid 12-digit Aadhaar number."); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await patientApi.lookupByAadhaar(num);
      setLookupResult({
        vehicleNumber: result.profile.vehicleNumbers?.[0] || "—",
        people: [result.profile],
        isSingleProfile: true,
        identificationMethod: "AADHAAR_REFERENCE",
      });
    } catch (err) {
      setError(err.message || "No profile found for this Aadhaar number.");
    } finally {
      setLoading(false);
    }
  };

  // --- Format Aadhaar with spaces ---
  const formatAadhaar = (val) => {
    const digits = val.replace(/\D/g, "").slice(0, 12);
    const parts = [];
    for (let i = 0; i < digits.length; i += 4) {
      parts.push(digits.slice(i, i + 4));
    }
    return parts.join(" ");
  };

  // --- If lookupResult is set, show PatientSelect ---
  if (lookupResult) {
    return (
      <PatientSelect
        people={lookupResult.people}
        vehicleNumber={lookupResult.vehicleNumber}
        isSingleProfile={lookupResult.isSingleProfile}
        onConfirm={(person) =>
          onPatientConfirmed({
            ...person,
            identificationMethod: lookupResult.identificationMethod || "UNKNOWN",
            patientId: person.patientId || lookupResult.patientId || person.id || null,
          })
        }
        onBack={reset}
      />
    );
  }

  return (
    <div className="pi-section">
      {showScanner && (
        <QrScanner
          onScan={handleToken}
          onClose={() => setShowScanner(false)}
        />
      )}

      {showUpload && (
        <QRUpload
          onDecoded={handleToken}
          onBack={() => setShowUpload(false)}
        />
      )}

      {!showScanner && !showUpload && (
        <>
          <div className="section-title">Identify Patient</div>
          <div className="section-sub">
            Use one of these methods to quickly identify the injured person.
            Scanning a RescueRoute patient card or uploading its QR image confirms
            their profile instantly. Vehicle/Aadhaar lookup also works.
          </div>

          <div className="pi-grid">
            {/* Camera QR Scan Card */}
            <button className="card pi-card" onClick={() => { setMode("qr"); setShowScanner(true); }}>
              <span className="pi-card-icon"><Icon name="crash" size={28} /></span>
              <strong>Scan Emergency QR</strong>
              <span className="muted">Scan a vehicle QR or a RescueRoute patient card with the camera</span>
              <span className="pi-card-action btn btn-blue" onClick={(e) => { e.stopPropagation(); setMode("qr"); setShowScanner(true); }}>
                Scan QR
              </span>
            </button>

            {/* Upload QR Image Card */}
            <button className="card pi-card" onClick={() => { setMode("upload"); setShowUpload(true); }}>
              <span className="pi-card-icon"><Icon name="camera" size={28} /></span>
              <strong>Upload QR Image</strong>
              <span className="muted">No camera handy? Decode a patient card photo (PNG/JPG/WebP) on-device</span>
              <span className="pi-card-action btn btn-blue" onClick={(e) => { e.stopPropagation(); setMode("upload"); setShowUpload(true); }}>
                Upload Image
              </span>
            </button>

            {/* Vehicle Number Card */}
            <div className="card pi-card" onClick={() => setMode(mode === "vehicle" ? null : "vehicle")}>
              <span className="pi-card-icon"><Icon name="car" size={28} /></span>
              <strong>Vehicle Number</strong>
              <span className="muted">Look up registered people by entering the vehicle number</span>
              {mode === "vehicle" && (
                <div className="pi-input-group" onClick={(e) => e.stopPropagation()}>
                  <input
                    className="pi-input"
                    value={vehicleInput}
                    onChange={(e) => setVehicleInput(e.target.value.toUpperCase())}
                    placeholder="e.g. TS09AB1234"
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && handleVehicleLookup()}
                  />
                  <button
                    className="btn btn-blue"
                    onClick={handleVehicleLookup}
                    disabled={loading || !vehicleInput.trim()}
                  >
                    {loading ? <><span className="spin" /> Searching…</> : "Find Patient"}
                  </button>
                </div>
              )}
            </div>

            {/* Aadhaar Card */}
            <div className="card pi-card" onClick={() => setMode(mode === "aadhaar" ? null : "aadhaar")}>
              <span className="pi-card-icon"><Icon name="user" size={28} /></span>
              <strong>Aadhaar Number</strong>
              <span className="muted">Look up a registered profile by Aadhaar identity number</span>
              {mode === "aadhaar" && (
                <div className="pi-input-group" onClick={(e) => e.stopPropagation()}>
                  <input
                    className="pi-input"
                    value={aadhaarInput}
                    onChange={(e) => setAadhaarInput(formatAadhaar(e.target.value))}
                    placeholder="XXXX XXXX XXXX"
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && handleAadhaarLookup()}
                    maxLength={14}
                  />
                  <button
                    className="btn btn-blue"
                    onClick={handleAadhaarLookup}
                    disabled={loading || aadhaarInput.replace(/\s/g, "").length !== 12}
                  >
                    {loading ? <><span className="spin" /> Searching…</> : "Find Patient"}
                  </button>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="pi-error-box">
              <span className="pi-error-icon">!</span>
              <span>{error}</span>
            </div>
          )}

          <div className="pi-demo-row">
            <span className="pi-demo-label">Demo patient cards</span>
            <div className="pi-demo-chips">
              {DEMO_PATIENT_REFS.map((d) => (
                <button
                  key={d.ref}
                  className="pi-demo-chip"
                  disabled={loading}
                  onClick={() => handleToken(d.ref)}
                  title={d.ref}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="pi-manual-row">
            <span className="pi-or">or</span>
            <button className="btn btn-ghost" onClick={onManualEntry}>
              Enter Patient Details Manually
            </button>
          </div>
        </>
      )}
    </div>
  );
}