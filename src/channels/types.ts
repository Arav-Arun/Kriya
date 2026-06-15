// Hermes channel layer: one abstraction for every messaging surface that can
// carry the Kriya copilot (WhatsApp Cloud API today; the /whatsapp simulator
// always; Telegram/Slack/email later). Adapters translate between provider
// payloads and these normalized shapes — the Hermes orchestrator never sees
// raw provider JSON.

export type ChannelKind = 'telegram' | 'simulator';

export interface InboundChannelMessage {
  channel: ChannelKind;
  /** E.164-ish sender id, e.g. "919260756057" for WhatsApp. */
  from: string;
  text: string;
  profileName?: string;
  providerMessageId: string;
  timestamp: string;
}

export interface OutboundDelivery {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly configured: boolean;
  sendText(to: string, text: string): Promise<OutboundDelivery>;
}

/** Last-10-digit normalization shared by matching and storage. */
export function phoneKey(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '').slice(-10);
}
