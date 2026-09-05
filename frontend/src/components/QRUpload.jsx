import React, { useRef, useState } from "react";
import "./QRUpload.css";

/**
 * QRUpload — Decode a QR code image (PNG / JPG / WebP) entirely on-device.
 * The image is NEVER uploaded to a server; only the decoded token is returned
 * to the caller via onDecoded(token). Falls back gracefully when the browser
 * cannot run the decoder.
 */
export default function QRUpload({ onDecoded, onBack }) {
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | decoding | detected | error
  const [errorMsg, setErrorMsg] = useState(null);

  const decode = async (file) => {
    setStatus("decoding");
    setErrorMsg(null);
    let container = null;
    try {
      const { Html5Qrcode } = await import("html5-qrcode");

      container = document.createElement("div");
      container.id = "qr-upload-hidden-" + Date.now();
      container.style.display = "none";
      document.body.appendChild(container);

      const scanner = new Html5Qrcode(container.id);
      const decoded = await scanner.scanFile(file, false);
      try { scanner.clear(); } catch {}

      if (container && container.parentNode) container.parentNode.removeChild(container);
      container = null;

      if (decoded) {
        setStatus("detected");
        onDecoded(decoded);
      } else {
        setStatus("error");
        setErrorMsg("No QR code found in that image. Try a clearer photo.");
      }
    } catch (err) {
      console.error("QRUpload decode error:", err && err.message);
      setStatus("error");
      setErrorMsg("No QR code could be read. Use a sharp, well-lit PNG/JPG/WebP of the patient card.");
    } finally {
      if (container && container.parentNode) container.parentNode.removeChild(container);
    }
  };

  const onFiles = (files) => {
    const file = files && files[0];
    if (!file) return;
    if (/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      decode(file);
    } else {
      setStatus("error");
      setErrorMsg("Unsupported file type. Upload a PNG, JPG or WebP image.");
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    onFiles(e.dataTransfer.files);
  };

  return (
    <div className="qu-section">
      <div className="section-title">Upload QR Image</div>
      <div className="section-sub">
        Take a photo of the person's RescueRoute card or upload a screenshot of
        their QR code. The image is decoded on your device — nothing is uploaded.
      </div>

      <div
        className={`card qu-dropzone ${dragOver ? "dragging" : ""} ${status === "decoding" ? "busy" : ""}`}
        onClick={() => !(status === "decoding") && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => onFiles(e.target.files)}
        />

        {status === "decoding" ? (
          <>
            <span className="spin" />
            <p className="qu-status-text">Decoding QR on device…</p>
          </>
        ) : status === "detected" ? (
          <>
            <span className="qu-check">✓</span>
            <p className="qu-status-text">QR detected — resolving patient…</p>
          </>
        ) : (
          <>
            <span className="qu-upload-icon">⇪</span>
            <strong className="qu-title">Tap to choose a photo</strong>
            <p className="muted">or drag &amp; drop a PNG, JPG or WebP here</p>
          </>
        )}
      </div>

      {status === "error" && (
        <div className="pi-error-box">
          <span className="pi-error-icon">!</span>
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="rr-actions">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Back
        </button>
      </div>
    </div>
  );
}