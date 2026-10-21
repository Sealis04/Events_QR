import { z } from "zod";

/**
 * Runtime settings, read from the environment (the repo-root `.env` in development, compose env
 * on the VM). Secrets are env values or mounted file paths; none are ever committed.
 */
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  APP_MODE: z.enum(["server", "hub", "worker"]).default("server"),

  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().default("events_qr"),
  DB_USER: z.string().default("events_qr"),
  DB_PASSWORD: z.string().default(""),
  DB_POOL_SIZE: z.coerce.number().int().min(1).default(20),

  /** HMAC key for session cookies. */
  SESSION_SECRET: z.string().min(32).optional(),
  /** Set to `false` only for plain-http development; defaults to true in production. */
  COOKIE_SECURE: bool.optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),

  /** 32 bytes, hex or base64: encrypts each event's AES key at rest. */
  EVENT_KEY_MASTER: z.string().min(1).optional(),
  SIGNING_KEY_PATH: z.string().min(1).optional(),
  SIGNING_KEY_PASSPHRASE: z.string().min(1).optional(),

  /** Base URL put into `DEV1:` setup QRs when no hub is configured. */
  HUB_URL: z.string().url().optional(),
  /** IANA zone used to place "00:00 local on the first day" for slot minutes. */
  EVENT_TIMEZONE: z.string().default("UTC"),

  /** Ticket sync only serves rows older than this, so a late commit can't slip behind a cursor. */
  SYNC_HORIZON_SECONDS: z.coerce.number().int().min(0).default(2),

  GMAIL_SA_KEY_PATH: z.string().min(1).optional(),
  GMAIL_SENDER: z.string().email().optional(),
  EMAIL_DAILY_LIMIT: z.coerce.number().int().positive().default(1800),
  EMAIL_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(250),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(6),
  WORKER_POLL_SECONDS: z.coerce.number().positive().default(5),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export function requireSetting<K extends keyof Config>(
  config: Config,
  key: K,
): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null) throw new Error(`${String(key)} is not set`);
  return value as NonNullable<Config[K]>;
}

export function cookieSecure(config: Config): boolean {
  return config.COOKIE_SECURE ?? config.NODE_ENV === "production";
}
