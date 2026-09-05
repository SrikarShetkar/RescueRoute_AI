import React from "react";
import "./AIDecisionPanel.css";
import DataLabel from "./DataLabel";

const EVENT_LABELS = {
  "ai:triage": "Triage",
  "ai:recommendation": "Ambulance / Hospital recommendation",
  "ai:reevaluation": "Adaptive re-evaluation",
  "ai:decision": "Decision",
};

/**
 * AIDecisionPanel — renders an emergency's append-only AI decision trail in
 * the Control Room. Every entry is labelled with its source (AI GENERATED vs
 * DETERMINISTIC FALLBACK) and confidence, so operators can judge how much to
 * trust each suggestion. Advisory only — nothing here bypasses the engine.
 */
export default function AIDecisionPanel({ emergency }) {
  const log = emergency?.aiDecisionLog || [];
  if (!Array.isArray(log) || log.length === 0) return null;

  return (
    <div className="aid-panel">
      <div className="aid-head">
        <span className="aid-title">AI RESPONSE INTELLIGENCE</span>
        <DataLabel kind="simulated">ADVISORY</DataLabel>
      </div>
      <div className="aid-list">
        {log.map((entry) => (
          <div key={entry.id || `${entry.event}-${entry.at}`} className={`aid-entry ${entry.status === "FALLBACK" ? "fallback" : ""}`}>
            <div className="aid-entry-head">
              <span className="aid-event">{EVENT_LABELS[entry.event] || entry.event}</span>
              <span className={`aid-badge ${entry.status === "FALLBACK" ? "fallback" : "gen"}`}>
                {entry.status === "FALLBACK" ? "DETERMINISTIC" : "AI GENERATED"}
              </span>
              {entry.confidencePct != null && (
                <span className="aid-conf">AI confidence {entry.confidencePct}%</span>
              )}
            </div>
            <p className="aid-reason">{entry.reason || "—"}</p>
            <div className="aid-meta">
              <span className="mono muted">{entry.id}</span>
              <span className="mono muted">{new Date(entry.at).toLocaleTimeString()}</span>
              {entry.requiresHumanApproval && (
                <span className="aid-hum">REQUIRES HUMAN APPROVAL</span>
              )}
              {entry.cause?.ambulanceUnavailable && <span className="aid-cue">ambulance unavailable</span>}
              {entry.cause?.hospitalUnavailable && <span className="aid-cue">hospital unavailable</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}