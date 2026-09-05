import React, { useState, useEffect } from "react";
import "./ControlRoom.css";
import api from "../services/api";
import socketService, { EVENTS } from "../services/socket";
import { setUiRole } from "../services/uiRole";
import { useAuth } from "../context/AuthContext";
import StatusBadge from "../components/StatusBadge";
import DataLabel from "../components/DataLabel";
import Icon from "../components/Icon";
import AIDecisionPanel from "../components/AIDecisionPanel";
import { EscalationBanner } from "../components/AlertBanner";
import { formatClock, timeAgo } from "../utils/time";

const CORRIDOR_SIGNALS = ["Main St & 1st Ave", "2nd Ave & Park Rd", "3rd Ave & Hill St", "4th Ave & Lake Rd"];

/**
 * ControlRoom — one dispatcher sees every active emergency at once: which
 * ambulance, which hospital, a running history, and the green corridor.
 * Numbers are explicitly labelled as SIMULATED / DEMO.
 */
export default function ControlRoom() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [emergencies, setEmergencies] = useState([]);
  const [feed, setFeed] = useState([]);
  const [selected, setSelected] = useState(null);
  const [overrideBusy, setOverrideBusy] = useState(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [reevalBusy, setReevalBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setUiRole("dispatch");
    socketService.registerRole("dispatch");

    const refresh = () => {
      api.statusOverview().then(setStats).catch((e) => setError(e.message));
      api.metrics().then(setMetrics).catch((e) => setError(e.message));
      api.listEmergencies().then(({ emergencies }) => setEmergencies(emergencies)).catch((e) => setError(e.message));
    };
    refresh();
    const poll = setInterval(refresh, 5000);

    const key = socketService.on(EVENTS.EMERGENCY_UPDATE, (data) => {
      setEmergencies((list) => {
        const exists = list.find((e) => e.emergencyId === data.emergencyId);
        if (exists) return list.map((e) => (e.emergencyId === data.emergencyId ? data : e));
        return [data, ...list];
      });
      setSelected((sel) => (sel && sel.emergencyId === data.emergencyId ? data : sel));
      const last = data.timeline[data.timeline.length - 1];
      if (last) setFeed((f) => [{ ...last, emergencyId: data.emergencyId }, ...f].slice(0, 30));
      api.statusOverview().then(setStats).catch(() => {});
      api.metrics().then(setMetrics).catch(() => {});
    });

    const escKey = socketService.on(EVENTS.ESCALATION_TRIGGERED, (data) => {
      setFeed((f) => [{ detail: `ESCALATION — ${data.message}`, emergencyId: data.emergencyId, at: new Date().toISOString() }, ...f].slice(0, 30));
      if (data.emergency) setEmergencies((list) => list.map((e) => (e.emergencyId === data.emergencyId ? data.emergency : e)));
    });
    const corrKey = socketService.on(EVENTS.CORRIDOR_UPDATED, (data) => {
      setFeed((f) => [{
        detail: data.corridor?.active ? `Green corridor ACTIVE — ${data.corridor.notifiedUsers} users notified` : "Green corridor ended",
        emergencyId: data.emergencyId,
        at: new Date().toISOString(),
      }, ...f].slice(0, 30));
    });
    const rejKey = socketService.on(EVENTS.HOSPITAL_REJECTED, (data) => {
      setFeed((f) => [{ detail: `HOSPITAL REJECTED — ${data.hospitalId} (${data.reasonLabel || "operational reason"})`, emergencyId: data.emergencyId, at: new Date().toISOString() }, ...f].slice(0, 30));
    });

    // AI decision trail streaming (triage / recommendation / re-evaluation).
    const aiKey = socketService.on(EVENTS.AI_DECISION, (data) => {
      const entry = data?.entry;
      if (!entry) return;
      const kind = entry.status === "FALLBACK" ? "DETERMINISTIC" : "AI";
      const label = ({ "ai:triage": "TRIAGE", "ai:recommendation": "RECOMMEND", "ai:reevaluation": "RE-EVAL" }[entry.event] || "AI DECISION");
      setFeed((f) => [{
        detail: `${label} [${kind}] — ${entry.reason || "—"}${entry.confidencePct != null ? ` (conf ${entry.confidencePct}%)` : ""}`,
        emergencyId: data.emergencyId,
        at: entry.at || new Date().toISOString(),
      }, ...f].slice(0, 30));
    });

    // Bystander patient identification + QR failure live stream.
    const identKey = socketService.on(EVENTS.PATIENT_IDENTIFIED, (data) => {
      setFeed((f) => [{
        detail: `PATIENT IDENTIFIED — ${data.patient?.name || "Unknown"} via ${data.patient?.identificationMethod || "UNKNOWN"}${data.patient?.verified ? " (verified)" : " (unverified)"}`,
        emergencyId: data.emergencyId,
        at: data.at || new Date().toISOString(),
      }, ...f].slice(0, 30));
    });
    const qrFailKey = socketService.on(EVENTS.PATIENT_VERIFICATION_FAILED, (data) => {
      setFeed((f) => [{
        detail: `QR FAILED — ${data.message || data.reason || "token did not resolve"} (${data.token || "unknown token"})`,
        emergencyId: data.emergencyId,
        at: data.at || new Date().toISOString(),
      }, ...f].slice(0, 30));
    });

    // Adaptive dispatch: control-room approved reassignment went live.
    const reassignKey = socketService.on(EVENTS.DISPATCH_REASSIGNED, (data) => {
      setFeed((f) => [{
        detail: `ADAPTIVE DISPATCH — approval applied, case reassigned to ${data.ambulanceId || "another unit"}`,
        emergencyId: data.emergencyId,
        at: new Date().toISOString(),
      }, ...f].slice(0, 30));
    });

    return () => {
      clearInterval(poll);
      socketService.off(EVENTS.EMERGENCY_UPDATE, key);
      socketService.off(EVENTS.ESCALATION_TRIGGERED, escKey);
      socketService.off(EVENTS.CORRIDOR_UPDATED, corrKey);
      socketService.off(EVENTS.HOSPITAL_REJECTED, rejKey);
      socketService.off(EVENTS.AI_DECISION, aiKey);
      socketService.off(EVENTS.PATIENT_IDENTIFIED, identKey);
      socketService.off(EVENTS.PATIENT_VERIFICATION_FAILED, qrFailKey);
      socketService.off(EVENTS.DISPATCH_REASSIGNED, reassignKey);
      setUiRole("home");
    };
  }, []);

  const active = emergencies.filter((e) => !["COMPLETED", "CANCELLED"].includes(e.status));
  const enRouteCount = active.filter((e) => ["AMBULANCE_ACCEPTED", "AT_PATIENT", "TO_HOSPITAL"].includes(e.status)).length;
  const escalations = active.filter((e) => ["CONTROL_ROOM_ESCALATION", "NO_HOSPITAL_AVAILABLE"].includes(e.status));
  const flaggedCases = active.filter((e) => e.reportFlags && e.reportFlags.length > 0);

  const markFalseAlarm = async (e) => {
    try {
      const res = await api.applyAction(e.emergencyId, { role: "dispatch", action: "false-alarm", actor: user?.name });
      setSelected(res.emergency);
      api.metrics().then(setMetrics).catch(() => {});
    } catch (err) {
      setError(err.message);
    }
  };

  // Control-room override — pick any recommended hospital manually.
  const dispatchOverride = async (hospitalId) => {
    if (!selected) return;
    setOverrideBusy(hospitalId);
    try {
      const res = await api.applyAction(selected.emergencyId, {
        role: "dispatch",
        action: "dispatch-override",
        hospitalId,
        actor: user?.name,
      });
      setSelected(res.emergency);
      api.listEmergencies().then(({ emergencies }) => setEmergencies(emergencies)).catch(() => {});
      setFeed((f) => [{ detail: `DISPATCH OVERRIDE → ${hospitalId}`, emergencyId: selected.emergencyId, at: new Date().toISOString() }, ...f].slice(0, 30));
    } catch (err) {
      setError(err.message);
    } finally {
      setOverrideBusy(null);
    }
  };

  const runDemo = async (which) => {
    setDemoBusy(true);
    setError(null);
    const refresh = () => {
      api.statusOverview().then(setStats).catch(() => {});
      api.metrics().then(setMetrics).catch(() => {});
      api.listEmergencies().then(({ emergencies }) => setEmergencies(emergencies)).catch((e) => setError(e.message));
    };
    try {
      if (which === "full") await api.runFullScenario();
      else if (which === "crash") await api.runCrashScenario();
      else if (which === "adaptive") await api.runAdaptiveDispatchScenario();
      else if (which === "qr-fail") await api.runUnknownQrScenario();
      else if (which === "shortage") await api.runAmbulanceShortageScenario();
      refresh();
      setTimeout(refresh, 1500);
      setTimeout(refresh, 4000);
    } catch (err) {
      setError(err.message);
    } finally {
      setDemoBusy(false);
    }
  };

  const runReevaluation = async () => {
    if (!selected) return;
    setReevalBusy(true);
    setError(null);
    try {
      const res = await api.reevaluateEmergency(selected.emergencyId, { requestedBy: "control-room" });
      const kind = res.entry?.status === "FALLBACK" ? "DETERMINISTIC" : "AI";
      setFeed((f) => [{
        detail: `RE-EVAL [${kind}] — ${res.entry?.reason || res.decision?.recommendedAction || "done"} (Δ ${res.etaDelta} min)`,
        emergencyId: selected.emergencyId,
        at: new Date().toISOString(),
      }, ...f].slice(0, 30));
      const updated = await api.getEmergency(selected.emergencyId);
      setSelected(updated.emergency);
      api.listEmergencies().then(({ emergencies }) => setEmergencies(emergencies)).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setReevalBusy(false);
    }
  };

  return (
    <div className="rr-page">
      <header className="page-hero">
        <div className="container page-hero-inner">
          <div>
            <h1>Control Room</h1>
            <p className="muted">One view of every active emergency. All figures below are clearly labelled.</p>
          </div>
          <div className="cr-header-actions">
            <button className="btn btn-blue" onClick={() => runDemo("full")} disabled={demoBusy}>
              {demoBusy ? <><span className="spin" /> Running…</> : <><Icon name="play" size={15} /> Full scenario</>}
            </button>
            <button className="btn btn-amber" onClick={() => runDemo("crash")} disabled={demoBusy}>
              <Icon name="crash" size={15} /> Crash scenario
            </button>
            <button className="btn btn-green" onClick={() => runDemo("adaptive")} disabled={demoBusy}>
              {demoBusy ? <><span className="spin" /> Running…</> : <><Icon name="robot" size={15} /> AI re-plan</>}
            </button>
            <button className="btn btn-ghost" onClick={() => runDemo("qr-fail")} disabled={demoBusy}>
              <Icon name="camera" size={15} /> QR fail
            </button>
            <button className="btn btn-ghost" onClick={() => runDemo("shortage")} disabled={demoBusy}>
              <Icon name="alert" size={15} /> Shortage
            </button>
            <button className="btn btn-ghost" onClick={() => api.resetDemo().then(() => { setEmergencies([]); setFeed([]); setStats(null); setMetrics(null); api.statusOverview().then(setStats); api.metrics().then(setMetrics); })}>
              <Icon name="refresh" size={15} /> Reset demo
            </button>
          </div>
        </div>
      </header>

      <div className="container cr-body">
        {error && <div className="error-box">{error}<button className="btn btn-ghost" onClick={() => setError(null)}>dismiss</button></div>}

        <section className="cr-stats">
          <div className="card cr-stat">
            <h3>{stats?.activeEmergencies ?? <span className="spin" />}</h3>
            <span>Active emergencies</span>
            <DataLabel kind="live">LIVE</DataLabel>
          </div>
          <div className="card cr-stat">
            <h3>{stats?.ambulancesAvailable ?? "—"} / {stats?.ambulanceCount ?? "—"}</h3>
            <span>Ambulances available</span>
            <DataLabel kind="simulated" />
          </div>
          <div className="card cr-stat">
            <h3>{stats?.hospitalCapacity ?? "—"}</h3>
            <span>Hospital beds free</span>
            <DataLabel kind="demo" />
          </div>
          <div className={`card cr-stat corridor ${escalations.length > 0 ? "escalation" : ""}`}>
            <h3>{escalations.length > 0 ? `×${escalations.length}` : "NONE"}</h3>
            <span>Escalations awaiting override</span>
            <DataLabel kind="live">LIVE</DataLabel>
          </div>
        </section>

        <div className="cr-grid">
          <section className="card cr-list">
            <div className="section-title" style={{ fontSize: 18 }}>Active emergencies</div>
            <div className="cr-cases">
              {active.length === 0 && <p className="muted">No active emergencies.</p>}
              {active.map((e) => (
                <button key={e.emergencyId} className={`cr-case ${selected?.emergencyId === e.emergencyId ? "sel" : ""}`} onClick={() => setSelected(e)}>
                  <div className="cr-case-row">
                    <StatusBadge status={e.status} />
                    <span className="mono muted">{e.emergencyId}</span>
                  </div>
                  <p className="cr-case-pat">{e.patient.name} · {e.patient.condition || e.patient.severity}</p>
                  <p className="muted" style={{ fontSize: 12 }}>
                    <Icon name="ambulance" size={12} /> {e.ambulance?.name || "searching…"} → <Icon name="hospital" size={12} /> {e.hospital?.name || "not offered"}
                  </p>
                </button>
              ))}
            </div>

            <div className="section-title" style={{ fontSize: 18, marginTop: 22 }}>Escalations</div>
            {escalations.length === 0 && <p className="muted" style={{ marginTop: 6 }}>None — under the rejection threshold.</p>}
            <div className="cr-esc-list">
              {escalations.map((e) => (
                <button key={e.emergencyId} className="cr-esc" onClick={() => setSelected(e)}>
                  <span>{e.emergencyId}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{e.hospitalRequests?.length || 0} rejections</span>
                  <Icon name="alert" size={13} />
                </button>
              ))}
            </div>

            <div className="section-title" style={{ fontSize: 18, marginTop: 22 }}>Suspicious cases</div>
            {flaggedCases.length === 0 && <p className="muted" style={{ marginTop: 6 }}>No flagged reports.</p>}
            <div className="cr-flags">
              {flaggedCases.map((e) => (
                <button key={e.emergencyId} className="cr-flag" onClick={() => setSelected(e)}>
                  <span>{e.emergencyId}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    risk {e.riskScore ?? 0} · {(e.reportFlags || []).join(", ")}
                  </span>
                  <Icon name="alert" size={13} />
                </button>
              ))}
            </div>

            <div className="section-title" style={{ fontSize: 18, marginTop: 22 }}>Signals on corridor</div>
            <div className="cr-signals">
              {CORRIDOR_SIGNALS.map((s, i) => (
                <div key={s} className="cr-signal">
                  <span className={`cr-light ${enRouteCount > 0 ? "green" : "red"}`} />
                  <span>{s}</span>
                  {enRouteCount > 0 && <span className="muted" style={{ fontSize: 11 }}>cleared in {i * 2}s for ambulance</span>}
                </div>
              ))}
            </div>
          </section>

          <section className="card cr-detail">
            {selected ? (
              <>
                <div className="cr-detail-head">
                  <span className="mono">{selected.emergencyId}</span>
                  <StatusBadge status={selected.status} />
                </div>
                <EscalationBanner
                  escalation={["CONTROL_ROOM_ESCALATION", "NO_HOSPITAL_AVAILABLE"].includes(selected.status) ? selected.controlRoomEscalation : null}
                  emergencyId={selected.emergencyId}
                />

                {["CONTROL_ROOM_ESCALATION", "NO_HOSPITAL_AVAILABLE"].includes(selected.status) && (
                  <div className="cr-override">
                    <div className="section-sub" style={{ marginBottom: 8 }}>
                      All hospitals declined within the search radius — override routing to a hospital you trust.
                    </div>
                    <div className="cr-override-list">
                      {(selected.hospitalRecommendations || []).map((r) => (
                        <button
                          key={r.hospital.id}
                          className="cr-override-item"
                          onClick={() => dispatchOverride(r.hospital.id)}
                          disabled={overrideBusy != null}
                        >
                          <span className="mono">{r.hospital.id}</span>
                          <span>{r.hospital.name}</span>
                          <span className="muted mono">{r.distance?.toFixed(1)} km</span>
                          {overrideBusy === r.hospital.id && <span className="spin" />}
                        </button>
                      ))}
                      {!selected.hospitalRecommendations?.length && (
                        <p className="muted">No recommendations stored — expand the search radius server-side or override anyway using dispatch tools.</p>
                      )}
                    </div>
                  </div>
                )}

                <p><strong>{selected.patient.name}</strong> · {selected.patient.age || "?"} · {selected.patient.bloodGroup}</p>
                <p className="muted">{selected.patient.condition}</p>
                {selected.patient?.identificationMethod && selected.patient.identificationMethod !== "UNKNOWN" && (
                  <div className="cr-identified">
                    <Icon name="check" size={13} />
                    <span>Patient identified via {selected.patient.identificationMethod}</span>
                    {selected.patient.patientId && <span className="mono muted">{selected.patient.patientId}</span>}
                    <DataLabel kind="simulated">{selected.patient.verified ? "VERIFIED" : "UNVERIFIED"}</DataLabel>
                  </div>
                )}
                <div className="cr-detail-assign">
                  <div><span className="rr-label">Ambulance</span><span>{selected.ambulance?.name || "—"}</span></div>
                  <div><span className="rr-label">Hospital</span><span>{selected.hospital?.name || "—"}</span></div>
                  <div><span className="rr-label">ETA patient</span><span>{selected.etaToPatient || "—"}</span></div>
                  <div><span className="rr-label">ETA hospital</span><span>{selected.etaToHospital || "—"}</span></div>
                </div>
                {selected.greenCorridor?.active && (
                  <div className="cr-detail-corridor">
                    <span className="rr-label">Green corridor</span>
                    <span><span className="cr-green-dot" /> ACTIVE — {selected.greenCorridor.notifiedUsers} users notified → {selected.greenCorridor.destination}</span>
                  </div>
                )}
                {(selected.hospitalRequests || []).length > 0 && (
                  <div className="cr-requests">
                    <span className="rr-label">Hospital admission requests</span>
                    {selected.hospitalRequests.map((r) => (
                      <div key={r.hospitalId} className={`cr-request req-${r.state || "waiting"}`}>
                        <span className="mono">{r.hospitalId}</span>
                        <span className="cr-request-state">{r.state || "waiting"}</span>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {r.score != null ? `score ${r.score}` : ""}
                          {r.respondedAt && <> · {formatClock(r.respondedAt)}</>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {(selected.reportFlags || []).length > 0 && (
                  <div className="cr-flag-summary">
                    <Icon name="alert" size={13} /> Risk {selected.riskScore ?? 0} — {(selected.reportFlags || []).join(", ")}
                  </div>
                )}
                <AIDecisionPanel emergency={selected} />
                {!["COMPLETED", "CANCELLED"].includes(selected.status) && (
                  <button className="btn btn-blue cr-reeval" onClick={runReevaluation} disabled={reevalBusy}>
                    {reevalBusy ? <><span className="spin" /> Re-evaluating…</> : <><Icon name="robot" size={14} /> Run AI re-evaluation</>}
                  </button>
                )}
                {!["COMPLETED", "CANCELLED"].includes(selected.status) && (
                  <button className="btn btn-red cr-false-alarm" onClick={() => markFalseAlarm(selected)}>
                    <Icon name="alert" size={14} /> Mark as false alarm
                  </button>
                )}
                <div className="cr-timeline">
                  <div className="cr-timeline-caption">case timeline · categories shown server-side</div>
                  {selected.timeline.map((t, i) => (
                    <div key={i} className="cr-tl">
                      <span className="mono muted">{formatClock(t.at)}</span>
                      {t.category && <span className={`cr-cat cat-${t.category}`}>{t.category}</span>}
                      <span>{t.detail}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-state">Select an emergency to inspect its full history.</div>
            )}
          </section>
        </div>

        <section className="cr-metrics">
          <div className="card cr-metric">
            <h3>{metrics ? metrics.activeCases : <span className="spin" />}</h3>
            <span>Active cases</span>
            <DataLabel kind="live">LIVE</DataLabel>
          </div>
          <div className="card cr-metric">
            <h3>{metrics?.avgResponseSeconds == null ? "—" : `${metrics.avgResponseSeconds}s`}</h3>
            <span>Avg response time (report → accept)</span>
            <DataLabel kind="simulated" />
          </div>
          <div className="card cr-metric">
            <h3>{metrics?.sirenActivations ?? "—"}</h3>
            <span>Green-corridor / siren activations</span>
            <DataLabel kind="demo" />
          </div>
          <div className="card cr-metric">
            <h3>{metrics?.falseAlarms ?? "—"}</h3>
            <span>False alarms this session</span>
            <DataLabel kind="demo" />
          </div>
        </section>

        <section className="card cr-feed">
          <div className="section-title" style={{ fontSize: 18 }}>Live system feed</div>
          <div className="cr-feed-list">
            {feed.length === 0 && <p className="muted">Events will stream here as the demo runs.</p>}
            {feed.map((f, i) => (
              <div key={i} className="cr-feed-item">
                <span className="mono muted">{f.emergencyId} · {formatClock(f.at)} · {timeAgo(f.at)}</span>
                <span>{f.detail}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}