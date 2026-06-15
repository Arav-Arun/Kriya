import fs from 'node:fs';
import path from 'node:path';

// Kriya runtime configuration and hosted-first guardrails.
//
// Local development can run on SQLite (Flue state) and the local filesystem
// (evidence uploads). Deployed environments must use hosted Postgres/Supabase:
// startup fails fast with actionable errors instead of silently degrading.

export interface KriyaConfig {
  deployed: boolean;
  port: number;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  databaseUrl: string | undefined;
  allowLocalFlueSqlite: boolean;
  evidenceBucket: string | undefined;
  providerMode: 'synthetic' | 'hyperface_uat';
  voiceProvider: 'sarvam' | 'mock';
  /** True only when voice is actually usable (Sarvam key present). */
  voiceEnabled: boolean;
  sarvamApiKey: string | undefined;
  sarvamSttModel: string;
  sarvamTtsModel: string;
  /** Resolved agent LLM id (e.g. "openai/gpt-4o-mini"); Flue reads the matching
   *  provider key (OPENAI_API_KEY) from the environment when it runs the model. */
  sentinelModel: string;
  appBaseUrl: string;
  /** Optional demo mobile number the web sign-in screen offers as a shortcut. */
  demoPhone: string | undefined;
  webhookSigningSecret: string | undefined;
  whatsapp: {
    accessToken: string | undefined;
    phoneNumberId: string | undefined;
    verifyToken: string | undefined;
    appSecret: string | undefined;
    configured: boolean;
  };
  telegram: {
    /** Bot token from @BotFather; presence enables the Telegram channel. */
    botToken: string | undefined;
    /** Optional secret echoed in the X-Telegram-Bot-Api-Secret-Token header. */
    webhookSecret: string | undefined;
    configured: boolean;
  };
  hyperface: {
    baseUrl: string;
    /** Datasource selector — "DEFAULT" for our UAT programs (per Hyperface). */
    tenantId: string;
    accessKey: string | undefined;
    secretKey: string | undefined;
    programId: string | undefined;
    webhookSecret: string | undefined;
    /** Known-good UAT sample resources for demos before per-customer linking. */
    testCustomerId: string | undefined;
    testAccountId: string | undefined;
    testCardId: string | undefined;
    /** Live writes stay OFF until a dedicated mutation-safe UAT program is
     *  confirmed (spec global constraint). Reads are always allowed. */
    allowMutations: boolean;
    configured: boolean;
  };
  openclaw: {
    /** Shared token OpenClaw agents present on the inbound webhook. */
    apiKey: string | undefined;
    /** Where to push outbound/proactive messages (optional; sync replies work without it). */
    callbackUrl: string | undefined;
    callbackToken: string | undefined;
    configured: boolean;
  };
}

function flag(value: string | undefined, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KriyaConfig {
  // `flue dev` builds with NODE_ENV=production and the spawned local server
  // inherits it, so NODE_ENV alone would false-positive in development. The
  // dev server is identifiable by FLUE_MODE=local; there, only the explicit
  // KRIYA_DEPLOYED flag can mark the environment as deployed.
  const deployed = env.FLUE_MODE === 'local'
    ? flag(env.KRIYA_DEPLOYED)
    : (env.NODE_ENV === 'production' || flag(env.KRIYA_DEPLOYED));
  const port = Number(env.PORT ?? 3583) || 3583;
  const providerMode = env.KRIYA_PROVIDER_MODE === 'hyperface_uat' ? 'hyperface_uat' : 'synthetic';
  const sarvamApiKey = env.SARVAM_API_KEY || undefined;
  // Voice fails closed: without a Sarvam key voice is DISABLED (callers return
  // 503), never silently mocked. The 'mock' provider is opt-in and dev-only —
  // it must be requested explicitly and is refused in deployed mode — and even
  // then it does not fabricate transcripts (see services/voice.ts).
  const requestedVoice = (env.VOICE_PROVIDER ?? '').toLowerCase();
  const voiceProvider: 'sarvam' | 'mock' =
    requestedVoice === 'mock' && !deployed ? 'mock' : 'sarvam';
  const voiceEnabled = voiceProvider === 'sarvam' && Boolean(sarvamApiKey);

  return {
    deployed,
    port,
    supabaseUrl: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || undefined,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    allowLocalFlueSqlite: flag(env.ALLOW_LOCAL_FLUE_SQLITE, false),
    evidenceBucket: env.KRIYA_EVIDENCE_BUCKET || undefined,
    providerMode,
    voiceProvider,
    voiceEnabled,
    sarvamApiKey,
    sarvamSttModel: env.SARVAM_STT_MODEL || 'saarika:v2.5',
    sarvamTtsModel: env.SARVAM_TTS_MODEL || 'bulbul:v2',
    sentinelModel: env.SENTINEL_MODEL || 'openai/gpt-4o-mini',
    appBaseUrl: env.APP_BASE_URL || `http://127.0.0.1:${port}`,
    demoPhone: env.DEMO_PHONE || undefined,
    webhookSigningSecret: env.WEBHOOK_SIGNING_SECRET || undefined,
    whatsapp: {
      accessToken: env.WHATSAPP_ACCESS_TOKEN || undefined,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || undefined,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || undefined,
      appSecret: env.WHATSAPP_APP_SECRET || undefined,
      configured: Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || undefined,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || undefined,
      configured: Boolean(env.TELEGRAM_BOT_TOKEN),
    },
    hyperface: {
      baseUrl: env.HYPERFACE_BASE_URL || 'https://api-uat.hyperface.co',
      tenantId: env.HYPERFACE_TENANT_ID || 'DEFAULT',
      accessKey: env.HYPERFACE_ACCESS_KEY || undefined,
      secretKey: env.HYPERFACE_SECRET_KEY || undefined,
      programId: env.HYPERFACE_PROGRAM_ID || undefined,
      webhookSecret: env.HYPERFACE_WEBHOOK_SECRET || undefined,
      testCustomerId: env.HYPERFACE_TEST_CUSTOMER_ID || undefined,
      testAccountId: env.HYPERFACE_TEST_ACCOUNT_ID || undefined,
      testCardId: env.HYPERFACE_TEST_CARD_ID || undefined,
      allowMutations: flag(env.HYPERFACE_ALLOW_MUTATIONS, false),
      configured: Boolean(env.HYPERFACE_SECRET_KEY),
    },
    openclaw: {
      apiKey: env.OPENCLAW_API_KEY || undefined,
      callbackUrl: env.OPENCLAW_CALLBACK_URL || undefined,
      callbackToken: env.OPENCLAW_CALLBACK_TOKEN || undefined,
      configured: Boolean(env.OPENCLAW_API_KEY),
    },
  };
}

export const config = loadConfig();

/**
 * Fail startup when a deployed environment is missing hosted state.
 * Call this once from the app entry before serving traffic.
 */
export function enforceHostedGuardrails(cfg: KriyaConfig = config): void {
  const problems: string[] = [];

  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    problems.push('Supabase is not configured: set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.');
  }

  if (cfg.deployed) {
    if (!cfg.databaseUrl && !cfg.allowLocalFlueSqlite) {
      problems.push(
        'DATABASE_URL is required in deployed mode: Flue run state must live in hosted Postgres. '
        + '(Set ALLOW_LOCAL_FLUE_SQLITE=true only for throwaway demos.)',
      );
    }
    if (!cfg.evidenceBucket) {
      problems.push(
        'KRIYA_EVIDENCE_BUCKET is required in deployed mode: evidence uploads must go to Supabase Storage, '
        + 'not the local filesystem.',
      );
    }
    if (cfg.telegram.botToken && !cfg.telegram.webhookSecret) {
      problems.push(
        'TELEGRAM_WEBHOOK_SECRET is required in deployed mode when TELEGRAM_BOT_TOKEN is set: it '
        + 'authenticates inbound webhook deliveries. Without it, anyone could forge Telegram updates.',
      );
    }
  }

  if (problems.length > 0) {
    const mode = cfg.deployed ? 'deployed' : 'development';
    throw new Error(`Kriya cannot start (${mode} mode):\n- ${problems.join('\n- ')}`);
  }

  console.log(
    `[kriya] mode=${cfg.deployed ? 'deployed' : 'development'} provider=${cfg.providerMode} `
    + `voice=${cfg.voiceEnabled ? 'sarvam' : (cfg.voiceProvider === 'mock' ? 'mock-dev' : 'disabled')} `
    + `flue-state=${cfg.databaseUrl ? 'postgres' : 'local-sqlite'} `
    + `evidence=${cfg.evidenceBucket ? `supabase:${cfg.evidenceBucket}` : 'local'} `
    + `whatsapp=${cfg.whatsapp.configured ? 'cloud-api' : 'unconfigured'}`,
  );
}

export function updateTelegramConfig(botToken: string, webhookSecret: string): void {
  config.telegram.botToken = botToken;
  config.telegram.webhookSecret = webhookSecret;
  config.telegram.configured = true;

  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    // ignore
  }

  let lines = content.split('\n');
  let hasToken = false;
  let hasSecret = false;
  lines = lines.map((line) => {
    if (line.trim().startsWith('TELEGRAM_BOT_TOKEN=')) {
      hasToken = true;
      return `TELEGRAM_BOT_TOKEN="${botToken}"`;
    }
    if (line.trim().startsWith('TELEGRAM_WEBHOOK_SECRET=')) {
      hasSecret = true;
      return `TELEGRAM_WEBHOOK_SECRET="${webhookSecret}"`;
    }
    return line;
  });

  if (!hasToken) {
    lines.push(`TELEGRAM_BOT_TOKEN="${botToken}"`);
  }
  if (!hasSecret) {
    lines.push(`TELEGRAM_WEBHOOK_SECRET="${webhookSecret}"`);
  }

  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

