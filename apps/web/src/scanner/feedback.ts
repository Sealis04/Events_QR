import type { ResultView } from "./result";

let audio: AudioContext | undefined;

/** Call from a tap (login, setup) so mobile browsers allow sound later. */
export function unlockAudio(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    // no audio; vibration and colour still work
  }
}

function tone(freq: number, startMs: number, lengthMs: number, type: OscillatorType = "sine") {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0.2;
  osc.connect(gain).connect(audio.destination);
  const t0 = audio.currentTime + startMs / 1000;
  osc.start(t0);
  osc.stop(t0 + lengthMs / 1000);
}

/** Short beep and one buzz for admitted, double beep for exit, long buzz for everything else. */
export function feedback(view: Pick<ResultView, "sound">): void {
  try {
    if (view.sound === "ok") {
      tone(880, 0, 120);
      navigator.vibrate?.(60);
    } else if (view.sound === "exit") {
      tone(660, 0, 90);
      tone(660, 140, 90);
      navigator.vibrate?.([40, 60, 40]);
    } else {
      tone(180, 0, 600, "sawtooth");
      navigator.vibrate?.(400);
    }
  } catch {
    // feedback is best effort
  }
}
