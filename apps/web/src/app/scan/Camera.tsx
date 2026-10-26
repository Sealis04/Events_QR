"use client";

import { useEffect, useRef, useState } from "react";
import { createFrameDecoder } from "../../scanner/decoder";
import { CameraHelp } from "./CameraHelp";

/**
 * Live camera preview that reports every QR code it reads. The same code held under the lens is
 * reported repeatedly; the caller debounces (3 s) and ignores codes while a result is showing.
 * Fills its parent (the .sc-camera box) with an aiming square; when the camera is blocked it shows
 * the camera help inline with "Try camera again".
 */
export function Camera({
  onCode,
  paused,
  hint = "Point at the ticket QR",
}: {
  onCode: (raw: string) => void;
  paused: boolean;
  hint?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const handler = useRef(onCode);
  handler.current = onCode;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [error, setError] = useState<"blocked" | "missing" | "">("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError("");

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("missing");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        if (!stopped) setError("blocked");
        return;
      }
      const el = video.current;
      if (stopped || !el) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      el.srcObject = stream;
      await el.play().catch(() => undefined);
      const decoder = await createFrameDecoder();

      const tick = async () => {
        if (stopped) return;
        if (!pausedRef.current && el.readyState >= 2) {
          try {
            const raw = await decoder.decode(el);
            if (raw) handler.current(raw);
          } catch {
            // a bad frame is not an error worth showing
          }
        }
        timer = setTimeout(tick, 90);
      };
      void tick();
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [attempt]);

  return (
    <div className="sc-camera" data-testid="camera">
      <video ref={video} playsInline muted />
      <div className="sc-aim" aria-hidden="true" />
      <div className="sc-hint">{hint}</div>
      {error === "blocked" && (
        <div className="sc-camera-error" role="alert">
          <strong>Camera blocked.</strong>
          <CameraHelp onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      )}
      {error === "missing" && (
        <div className="sc-camera-error" role="alert">
          This browser has no camera access. Use “Find a ticket by name”.
        </div>
      )}
    </div>
  );
}
