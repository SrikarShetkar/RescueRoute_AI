import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../components/Icon";
import "./Home.css";

/**
 * RescueRoute — landing page.
 *
 * Product positioning: an AI-ASSISTED emergency response ORCHESTRATOR.
 * The AI recommends a triage and a response, the deterministic Emergency
 * Engine validates and executes every action, humans approve sensitive
 * changes, and the whole plan re-evaluates when reality changes.
 *
 * Pure presentation layer. Every CTA points at real, working routes
 * (/login, /citizen, /ambulance, /hospital, /control-room, /driver).
 */

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

const FLOW_STAGES = [
  { key: "SOS", sub: "REPORT RECEIVED", icon: "sos" },
  { key: "AI TRIAGE", sub: "CLASSIFY · STRUCTURE", icon: "robot", ai: true },
  { key: "RESOURCE MATCH", sub: "AMBULANCE + HOSPITAL", icon: "stats", ai: true },
  { key: "AMBULANCE DISPATCH", sub: "NEAREST AVAILABLE", icon: "ambulance" },
  { key: "LIVE MONITORING", sub: "ETA · POSITION · CORRIDOR", icon: "location" },
  { key: "AI RE-EVALUATION", sub: "RE-PLAN WHEN REALITY CHANGES", icon: "refresh", ai: true, hero: true },
  { key: "HOSPITAL HANDOVER", sub: "ADMIT · CORRIDOR CLEAR", icon: "hospital" },
];

const SEQ = ["REPORT", "IDENTIFY", "TRIAGE", "DISPATCH", "MONITOR", "RE-EVALUATE", "RESPOND", "HANDOVER"];

const DIFFERENCE = [
  {
    icon: "robot",
    chip: "01 · AI TRIAGE",
    title: "AI Triage",
    body: "Structured AI analysis converts emergency information into actionable recommendations.",
    tags: ["classification", "priority"],
  },
  {
    icon: "refresh",
    chip: "02 · ADAPTIVE",
    title: "Adaptive Response",
    body: "When traffic, ETA, ambulance availability, or other conditions change, RescueRoute can re-evaluate the response.",
    tags: ["re-evaluation", "re-assignment"],
  },
  {
    icon: "shield",
    chip: "03 · DETERMINISTIC",
    title: "Deterministic Safety",
    body: "AI recommends. The Emergency Engine validates. Humans approve sensitive actions. Every decision is logged.",
    tags: ["rule-gated", "audit trail"],
  },
];

const ADAPTIVE_STEPS = [
  { t: "ETA 6 min", k: "k" },
  { t: "Traffic changes", k: "e" },
  { t: "ETA 19 min", k: "w" },
  { t: "AI RE-EVALUATION", k: "ai" },
  { t: "Alternative ambulance recommended", k: "ai" },
  { t: "Control Room approval", k: "h" },
  { t: "Dispatch reassigned", k: "ok" },
];

const CAPABILITIES = [
  { icon: "robot", title: "AI Triage", body: "Emergency classification and structured first-response guidance." },
  { icon: "stats", title: "Resource Intelligence", body: "Ambulance and hospital recommendations based on eligibility and explainable scoring." },
  { icon: "refresh", title: "Adaptive Response", body: "Continuous re-evaluation when emergency conditions change." },
  { icon: "clipboard", title: "Decision Trail", body: "Auditable AI recommendations, fallback decisions, approvals, and system actions." },
];

const NET_NODES = [
  { x: 200, y: 62, name: "CITIZEN", sub: "reports emergency", icon: "phone" },
  { x: 700, y: 62, name: "DISPATCHER", sub: "coordinates response", icon: "stats" },
  { x: 150, y: 334, name: "AMBULANCE", sub: "responds + transports", icon: "ambulance" },
  { x: 750, y: 334, name: "HOSPITAL", sub: "prepares + accepts", icon: "hospital" },
  { x: 450, y: 398, name: "NEARBY DRIVERS", sub: "receive corridor alerts", icon: "bell" },
];

const TRUST = [
  { t: "SCHEMA VALIDATED", d: "struct · zod-style" },
  { t: "RULE-GATED ACTIONS", d: "engine authoritative" },
  { t: "HUMAN APPROVAL", d: "no auto re-plans" },
  { t: "AUDIT TRAIL", d: "append-only log" },
  { t: "AI FALLBACK", d: "deterministic, labelled" },
  { t: "REAL-TIME SOCKET EVENTS", d: "socket.io" },
];

const STACK = [
  { t: "React", d: "frontend" },
  { t: "Node.js", d: "runtime" },
  { t: "Express", d: "api" },
  { t: "Socket.IO", d: "real-time" },
  { t: "MongoDB", d: "optional store" },
  { t: "Gemini AI", d: "advisory layer" },
  { t: "Leaflet/OSM", d: "maps" },
];

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

function useReveal() {
  const ref = useRef(null);
  const [tick] = useState(0);
  useEffect(() => {
    const els = ref.current?.querySelectorAll(".rr-reveal");
    if (!els) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [tick]);
  return { ref };
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const fn = (e) => setReduced(e.matches);
    mq.addEventListener?.("change", fn);
    return () => mq.removeEventListener?.("change", fn);
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ */
/*  Hero flow visual — live emergency pipeline                         */
/* ------------------------------------------------------------------ */

function HeroFlow({ reduced }) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setActive((a) => (a + 1) % FLOW_STAGES.length), 1400);
    return () => clearInterval(t);
  }, [reduced]);

  return (
    <div className="ai-hero-card">
      <div className="ai-hero-card-top">
        <span className="ai-live-tag"><span className="rr-live-dot" /> LIVE · SIMULATED</span>
        <span className="ai-mono">RESCUE FLOW</span>
      </div>

      <div className="ai-rail" aria-hidden="true">
        <div className="ai-rail-line">
          {!reduced && <span className="ai-rail-dot" />}
        </div>
        {FLOW_STAGES.map((st, i) => (
          <div key={st.key} className={`ai-node ${active === i ? "on" : ""} ${st.hero ? "hero" : ""}`}>
            <div className="ai-node-ico">
              <Icon name={st.icon} size={15} />
            </div>
            <div className="ai-node-meta">
              <span className="ai-node-key">{st.key}</span>
              <span className="ai-node-sub">{st.sub}</span>
            </div>
            {active === i && <span className="ai-node-active" />}
          </div>
        ))}
      </div>

      <div className="ai-hero-status">
        <span className="k">NODE</span>
        <span className="v ok">{FLOW_STAGES[active].key}</span>
        <span className="k">DECISION</span>
        <span className="v">RECOMMEND → VALIDATE</span>
        <span className="k">MODE</span>
        <span className="v">ADVISORY</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Real-time network visual                                           */
/* ------------------------------------------------------------------ */

function NetworkVisual({ reduced }) {
  const CX = 450, CY = 205;
  return (
    <div className="ai-net">
      <svg viewBox="0 0 900 440" className="ai-net-svg" role="img" aria-label="RescueRoute real-time network">
        <defs>
          <radialGradient id="hubGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(62,242,124,0.22)" />
            <stop offset="100%" stopColor="rgba(62,242,124,0)" />
          </radialGradient>
        </defs>
        <circle cx={CX} cy={CY} r="150" fill="url(#hubGrad)" className="ai-net-halo" />
        {NET_NODES.map((n, i) => (
          <g key={n.name}>
            <line
              x1={CX} y1={CY} x2={n.x} y2={n.y}
              className="ai-net-line"
              style={{ animationDelay: `${i * 0.35}s` }}
            />
          </g>
        ))}
        {!reduced &&
          NET_NODES.map((n, i) => (
            <g key={"p" + n.name}>
              <circle r="3.2" className="ai-net-pulse" fill="#3ef27c">
                <animateMotion
                  dur={`${2.4 + i * 0.4}s`}
                  repeatCount="indefinite"
                  begin={`${i * 0.35}s`}
                  path={`M${CX},${CY} L${n.x},${n.y}`}
                />
              </circle>
            </g>
          ))}

        {/* center hub */}
        <g>
          <rect x={CX - 150} y={CY - 34} width="300" height="68" rx="8" className="ai-hub-box" />
          <text x={CX} y={CY - 4} textAnchor="middle" className="ai-hub-title">RESCUEROUTE INTELLIGENCE</text>
          <text x={CX} y={CY + 18} textAnchor="middle" className="ai-hub-sub">ENGINE · AI ORCHESTRATOR · SOCKET.IO</text>
        </g>

        {NET_NODES.map((n) => (
          <g key={"lbl" + n.name}>
            <rect x={n.x - 92} y={n.y - 30} width="184" height="60" rx="6" className="ai-net-node" />
            <text x={n.x} y={n.y - 8} textAnchor="middle" className="ai-net-name">{n.name}</text>
            <text x={n.x} y={n.y + 12} textAnchor="middle" className="ai-net-sub">{n.sub}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  const reduced = useReducedMotion();
  const { ref } = useReveal();

  return (
    <div className="ldp ai-ldp">
      <div ref={ref}>
        {/* ============================ HERO ============================ */}
        <section className="ai-hero">
          <div className="container ai-hero-grid">
            <div className="ai-hero-copy">
              <div className="ai-hero-badges">
                <span className="ai-badge live"><span className="rr-live-dot" /> LIVE RESPONSE SYSTEM</span>
                <span className="ai-badge">AI-ASSISTED</span>
                <span className="ai-badge">REAL-TIME</span>
              </div>

              <h1 className="ai-hero-title">
                EVERY SECOND<br />
                CHANGES THE<br />
                <span className="ai-accent-green">OUTCOME.</span>
              </h1>

              <p className="ai-hero-sub">
                RescueRoute is an AI-assisted emergency response orchestrator that connects
                citizens, ambulances, hospitals, dispatchers, and nearby drivers into
                one real-time response network.
              </p>

              <p className="ai-hero-keyline">
                <Icon name="refresh" size={14} />
                AI doesn&rsquo;t just make the first decision. It <b>re-evaluates</b> when reality changes.
              </p>

              <div className="ai-hero-ctas">
                <Link to="/login" className="rr-btn solid">Launch Live Demo <span className="rr-arw">→</span></Link>
                <a href="#architecture" className="rr-btn ghost">View Architecture</a>
              </div>
            </div>

            <HeroFlow reduced={reduced} />
          </div>
        </section>

        {/* ===================== RESPONSE SEQUENCE ===================== */}
        <section className="ai-seq">
          <div className="container">
            <span className="rr-eyebrow centered rr-reveal">The response sequence</span>
            <div className="ai-seq-strip rr-reveal">
              {SEQ.map((s, i) => (
                <React.Fragment key={s}>
                  {i > 0 && <span className="ai-seq-chev">›</span>}
                  <span className={`ai-seq-chip ${s === "RE-EVALUATE" ? "focus" : ""}`}>{s}</span>
                </React.Fragment>
              ))}
            </div>
          </div>
        </section>

        {/* ====================== THE DIFFERENCE ====================== */}
        <section className="ai-diff">
          <div className="container">
            <div className="ai-head">
              <span className="rr-eyebrow centered rr-reveal">The difference</span>
              <h2 className="ai-h2 rr-reveal">EMERGENCY RESPONSE CANNOT BE<br />A ONE-TIME DECISION.</h2>
            </div>
            <div className="ai-diff-grid">
              {DIFFERENCE.map((c) => (
                <div className={`ai-diff-card rr-reveal ${c.chip.includes("03") ? "safety" : ""}`} key={c.chip}>
                  <div className="ai-diff-top">
                    <Icon name={c.icon} size={18} />
                    <span className="ai-mono">{c.chip}</span>
                  </div>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  {c.chip.includes("03") && (
                    <div className="ai-safety-flow">
                      <span>AI recommends</span>
                      <span className="a">Engine validates</span>
                      <span className="a">Human approves sensitive actions</span>
                      <span className="a">Every decision is logged</span>
                    </div>
                  )}
                  <div className="ai-diff-tags">
                    {c.tags.map((t) => <span key={t} className="ai-mono">{t}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===================== ADAPTIVE RESPONSE ===================== */}
        <section className="ai-adaptive">
          <div className="container">
            <div className="ai-head">
              <span className="rr-eyebrow centered rr-reveal">The differentiator</span>
              <h2 className="ai-h2 rr-reveal">WHAT HAPPENS WHEN<br />THE SITUATION CHANGES?</h2>
            </div>

            <div className="ai-adaptive-badge rr-reveal">
              <span className="rr-live-dot" /> ADAPTIVE RESPONSE
            </div>

            <div className="ai-timeline rr-reveal">
              {ADAPTIVE_STEPS.map((s, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className={`ai-tl-conn ${s.k === "ai" ? "ai" : ""}`}>→</span>}
                  <div className={`ai-tl-step ${s.k}`}>
                    {s.k === "e" && <Icon name="bell" size={13} />}
                    {s.k === "w" && <Icon name="alert" size={13} />}
                    {s.k === "ai" && <Icon name="refresh" size={12} />}
                    {s.k === "h" && <Icon name="shield" size={13} />}
                    {s.k === "ok" && <Icon name="check" size={13} />}
                    <span>{s.t}</span>
                  </div>
                </React.Fragment>
              ))}
            </div>

            <div className="ai-adaptive-meta rr-reveal">
              <div className="ai-eta-jump">
                <div className="ai-eta-block">
                  <span className="k">ASSIGNED UNIT</span>
                  <span className="v">ETA 6 min</span>
                  <span className="bar b6"><i /></span>
                </div>
                <div className="ai-eta-block">
                  <span className="k">AFTER TRAFFIC</span>
                  <span className="v warn">ETA 19 min · Δ +13</span>
                  <span className="bar b19"><i /></span>
                </div>
              </div>
              <p className="ai-mono ai-meta-line">
                traffic detected → <b className="ok">ai:reevaluation</b> → <b className="ok">REASSIGN_AMBULANCE</b> ·
                requiresHumanApproval<span className="warn">:true</span> → control-room approval → dispatch:reassigned
              </p>
            </div>
          </div>
        </section>

        {/* ==================== AI CAPABILITIES ==================== */}
        <section className="ai-caps">
          <div className="container">
            <div className="ai-head">
              <span className="rr-eyebrow centered rr-reveal">AI capabilities</span>
              <h2 className="ai-h2 rr-reveal">THE ORCHESTRATOR,<br />ON THE INSIDE.</h2>
            </div>
            <div className="ai-caps-grid">
              {CAPABILITIES.map((c) => (
                <div className="ai-cap rr-reveal" key={c.title}>
                  <div className="ai-cap-ico"><Icon name={c.icon} size={17} /></div>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ==================== REAL-TIME NETWORK ==================== */}
        <section className="ai-net-sec" id="network">
          <div className="container">
            <div className="ai-head">
              <span className="rr-eyebrow centered rr-reveal">One event · every system</span>
              <h2 className="ai-h2 rr-reveal">FIVE ROLES.<br />ONE INTELLIGENCE.</h2>
            </div>
            <NetworkVisual reduced={reduced} />
          </div>
        </section>

        {/* ==================== TRUST / SAFETY ==================== */}
        <section className="ai-trust">
          <div className="container">
            <div className="ai-trust-intro rr-reveal">
              <Icon name="shield" size={15} />
              The AI orchestrator recommends — it never holds unrestricted control.
            </div>
            <div className="ai-trust-strip rr-reveal">
              {TRUST.map((t) => (
                <div className="ai-trust-pill" key={t.t}>
                  <span className="t">{t.t}</span>
                  <span className="d">{t.d}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ====================== TECHNOLOGY ====================== */}
        <section className="ai-tech" id="architecture">
          <div className="container">
            <div className="ai-head">
              <span className="rr-eyebrow centered rr-reveal">Built on</span>
              <h2 className="ai-h2 rr-reveal">A REAL-TIME STACK.</h2>
            </div>
            <div className="ai-stack rr-reveal">
              {STACK.map((s) => (
                <div className="ai-stack-chip" key={s.t}>
                  <span className="t">{s.t}</span>
                  <span className="d">{s.d}</span>
                </div>
              ))}
            </div>
            <p className="ai-tech-note rr-reveal">
              The same stack powering every live dashboard — the Emergency Engine stays the
              single source of truth, and the AI orchestrator advises alongside it.
            </p>
          </div>
        </section>

        {/* ====================== FINAL CTA ====================== */}
        <section className="ai-final">
          <div className="container">
            <span className="rr-eyebrow centered rr-reveal">RescueRoute</span>
            <h2 className="ai-final-title rr-reveal">
              FROM SOS TO HOSPITAL HANDOVER —<br />
              COORDINATED IN <span className="ai-accent-green">REAL TIME.</span>
            </h2>
            <p className="ai-final-sub rr-reveal">
              See RescueRoute respond to an emergency, adapt to changing conditions,
              and keep every decision explainable.
            </p>
            <Link to="/login" className="rr-btn solid rr-reveal">Launch Live Demo <span className="rr-arw">→</span></Link>

            <div className="ai-demo-links rr-reveal">
              {[
                { to: "/citizen", l: "/citizen" },
                { to: "/ambulance", l: "/ambulance" },
                { to: "/hospital", l: "/hospital" },
                { to: "/control-room", l: "/control-room" },
                { to: "/driver", l: "/driver" },
              ].map((r) => (
                <Link to={r.to} className="ai-demo-link" key={r.to}>{r.l}</Link>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}