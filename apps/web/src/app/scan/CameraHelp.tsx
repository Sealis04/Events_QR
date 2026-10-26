"use client";

/** Per-browser steps for turning the camera back on. Shown in the ⋯ menu and when the camera is blocked. */
export function CameraHelp({ onRetry, onBack }: { onRetry: () => void; onBack?: () => void }) {
  return (
    <div className="sc-help" data-testid="camera-help">
      <p>The scanner needs the camera. If it is black or says it is blocked:</p>
      <h3>iPhone (Safari)</h3>
      <ol>
        <li>Tap the “aA” icon in the address bar.</li>
        <li>Tap Website Settings, then Camera, then Allow.</li>
        <li>Come back here and tap Try camera again.</li>
      </ol>
      <h3>Android (Chrome)</h3>
      <ol>
        <li>Tap the icon at the left of the address bar (a lock or sliders).</li>
        <li>Tap Permissions, then Camera, then Allow.</li>
        <li>Come back here and tap Try camera again.</li>
      </ol>
      <p style={{ marginTop: 8 }}>
        Still black? Close other apps that use the camera, then reload this page.
      </p>
      <div
        className={onBack ? "sc-pair" : undefined}
        style={{ marginTop: 8, display: "grid", gap: 10 }}
      >
        {onBack && (
          <button type="button" className="sc-btn" onClick={onBack}>
            Back
          </button>
        )}
        <button type="button" className="sc-btn primary" onClick={onRetry}>
          Try camera again
        </button>
      </div>
    </div>
  );
}
