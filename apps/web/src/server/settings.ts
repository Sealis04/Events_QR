/** The per-event "offline devices admit only tickets allowed at this gate" switch (`config.offline_gate_only`). */
export const offlineGateOnly = (config: unknown): boolean =>
  !!config &&
  typeof config === "object" &&
  (config as Record<string, unknown>).offline_gate_only === true;
