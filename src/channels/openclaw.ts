// OpenClaw channel adapter. OpenClaw is a personal AI agent gateway the
// customer runs themselves; it brings Kriya into any surface OpenClaw speaks
// (Telegram, iMessage, Discord, ...). Integration shape:
//
//   Inbound:  the OpenClaw agent POSTs to /api/channels/openclaw/webhook with
//             a bearer token (OPENCLAW_API_KEY). The customer is matched by
//             the registered mobile number in the payload. The HTTP response
//             carries the reply synchronously — the natural fit for an
//             OpenClaw tool call.
//   Outbound: optional push for proactive messages (ticket updates, evidence
//             requests) via OPENCLAW_CALLBACK_URL; without it, outbound
//             delivery is "reply in webhook response" only.
//
// Trust: a valid token means the message came from the customer's own agent,
// which holds their registered number — so token-authenticated inbound grants
// the possession factor, same as a signature-verified WhatsApp webhook.
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.ts';
import type { ChannelAdapter, InboundChannelMessage, OutboundDelivery } from './types.ts';

export function verifyOpenClawToken(authorization: string | undefined): boolean {
  const expected = config.openclaw.apiKey;
  if (!expected) return false;
  const presented = String(authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OpenClawInboundBody {
  /** Registered mobile number of the cardholder (E.164-ish). */
  from?: string;
  text?: string;
  message?: string;
  messageId?: string;
  profileName?: string;
}

/** Normalize an OpenClaw webhook body; null when required fields are absent. */
export function parseOpenClawInbound(body: OpenClawInboundBody): InboundChannelMessage | null {
  const from = String(body.from ?? '').trim();
  const text = String(body.text ?? body.message ?? '').trim();
  if (!from || !text) return null;
  return {
    channel: 'openclaw',
    from,
    text: text.slice(0, 4000),
    profileName: body.profileName ? String(body.profileName) : undefined,
    providerMessageId: String(body.messageId ?? `oc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    timestamp: new Date().toISOString(),
  };
}

class OpenClawAdapter implements ChannelAdapter {
  readonly kind = 'openclaw' as const;

  get configured(): boolean {
    return config.openclaw.configured;
  }

  /** Push a message to the customer's OpenClaw agent (proactive/outbound). */
  async sendText(to: string, text: string): Promise<OutboundDelivery> {
    const url = config.openclaw.callbackUrl;
    if (!url) {
      // No push channel configured — the webhook's synchronous response is
      // the delivery path, so this is an expected no-op, not a failure.
      return { ok: true, providerMessageId: undefined };
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.openclaw.callbackToken ? { authorization: `Bearer ${config.openclaw.callbackToken}` } : {}),
        },
        body: JSON.stringify({ to, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, error: `openclaw callback HTTP ${res.status}` };
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      return { ok: true, providerMessageId: (data as { messageId?: string }).messageId };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
    }
  }
}

export const openclawAdapter = new OpenClawAdapter();
