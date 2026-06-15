// WhatsApp Cloud API adapter for the Hermes channel layer.
//
// Configured entirely from env (see src/config/env.ts):
//   WHATSAPP_ACCESS_TOKEN     Meta Graph API token
//   WHATSAPP_PHONE_NUMBER_ID  sender phone number id
//   WHATSAPP_VERIFY_TOKEN     value echoed during webhook subscribe handshake
//   WHATSAPP_APP_SECRET       enables X-Hub-Signature-256 verification
//
// Without credentials the adapter reports configured=false and the /whatsapp
// simulator remains the only delivery surface — nothing else breaks.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.ts';
import type { ChannelAdapter, InboundChannelMessage, OutboundDelivery } from './types.ts';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly kind = 'whatsapp' as const;

  get configured(): boolean {
    return config.whatsapp.configured;
  }

  async sendText(to: string, text: string): Promise<OutboundDelivery> {
    if (!this.configured) {
      return { ok: false, error: 'WhatsApp Cloud API is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).' };
    }
    // WhatsApp rejects messages over 4096 chars; split conservatively.
    const chunks = splitMessage(text, 3800);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      const res = await fetch(`${GRAPH_BASE}/${config.whatsapp.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.whatsapp.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: chunk },
        }),
      }).catch((err: unknown) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(err) } }) }) as Response);

      const body = await res.json().catch(() => ({})) as any;
      if (!res.ok) {
        return { ok: false, error: `WhatsApp send failed (${res.status}): ${body?.error?.message ?? 'unknown error'}` };
      }
      lastId = body?.messages?.[0]?.id;
    }
    return { ok: true, providerMessageId: lastId };
  }
}

function splitMessage(text: string, max: number): string[] {
  const clean = String(text ?? '').trim();
  if (clean.length <= max) return [clean];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
    const at = cut > max * 0.5 ? cut + 1 : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

/** GET webhook subscribe handshake: echo hub.challenge when the token matches. */
export function verifySubscribe(query: Record<string, string | undefined>): string | null {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === config.whatsapp.verifyToken && query['hub.challenge']) {
    return query['hub.challenge'];
  }
  return null;
}

/** X-Hub-Signature-256 verification; passes when no app secret is configured. */
export function verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = config.whatsapp.appSecret;
  if (!secret) return true;
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const given = signatureHeader.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** Normalize a Cloud API webhook body into inbound text messages. */
export function parseWebhook(body: any): InboundChannelMessage[] {
  const messages: InboundChannelMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const profileByWaId = new Map<string, string>(
        (value?.contacts ?? []).map((c: any) => [String(c?.wa_id ?? ''), String(c?.profile?.name ?? '')]),
      );
      for (const m of value?.messages ?? []) {
        if (m?.type !== 'text' || !m?.text?.body) continue;
        const from = String(m.from ?? '');
        messages.push({
          channel: 'whatsapp',
          from,
          text: String(m.text.body),
          profileName: profileByWaId.get(from) || undefined,
          providerMessageId: String(m.id ?? `${from}-${m.timestamp ?? Date.now()}`),
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
        });
      }
    }
  }
  return messages;
}

export const whatsappAdapter = new WhatsAppCloudAdapter();
