"use client";

import { useEffect, useRef, useState } from "react";
import { createFrameDecoder } from "../../scanner/decoder";

/**
 * Live camera preview that reports every QR code it reads. The same code held under the lens is
 * reported repeatedly; the caller debounces (3 s) and ignores codes while a result is showing.
 */
export function Camera({ onCode, paused }: { onCode: (raw: string) => void; paused: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const handler = useRef(onCode);
  handler.current = onCode;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [error, setError] = useState("");

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser has no camera access. Use manual entry.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        setError("Camera blocked. Allow camera access for this site, then reload.");
        return;
      }
      const el = video.current;
      if (stopped || !el) return;
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
  }, []);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        background: "#000",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <video
        ref={video}
        playsInline
        muted
        style={{ width: "100%", maxHeight: "55vh", objectFit: "cover", display: "block" }}
      />
      {error && (
        <p role="alert" style={{ color: "#fca5a5", padding: 12, margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
