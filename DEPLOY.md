# Deploying Kriya

Kriya is one Node server (built with Flue) that serves the web chat and the connect
page, and talks to Supabase (chat memory + audit), Hyperface (live card data), OpenAI
(the agent), and Sarvam (voice). To go live you need a host that runs Node with a public
HTTPS address, plus a handful of keys.

## What works with no channel setup

Deploy with the keys in step 1 and you immediately get the **web chat** (customers sign
in with their registered mobile number), **live card data**, and **voice**. Messaging
channels are optional add-ons on top — **Telegram (§4) is the quickest and is free**: no
extra phone number, no approval process, just a bot anyone can message.

## 1. Keys

Copy `.env.example` to `.env` and fill these in.

**Required**

| Key | What it's for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Chat history + audit log |
| `OPENAI_API_KEY` | The assistant |
| `SARVAM_API_KEY` | Voice (speech in and out) |
| `KRIYA_PROVIDER_MODE=hyperface_uat` | Turns on live card data |
| `HYPERFACE_ACCESS_KEY`, `HYPERFACE_SECRET_KEY`, `HYPERFACE_PROGRAM_ID` | Live card account access |
| `HYPERFACE_TENANT_ID=DEFAULT` | Hyperface datasource selector |
| `APP_BASE_URL=https://your-domain` | Used to build the channel webhook URLs |
| `KRIYA_DEPLOYED=true` | Enables the deployed-mode checks |

**For deployed mode, also set one of:**

- `DATABASE_URL=<Supabase Postgres connection string>` — recommended, or
- `ALLOW_LOCAL_FLUE_SQLITE=true` — throwaway demos only

…and for file uploads in production: `KRIYA_EVIDENCE_BUCKET=<a Supabase Storage bucket>`.

**Optional**

- `DEMO_PHONE` — a card-registered number offered as a one-tap shortcut on the sign-in screen
- `HYPERFACE_WEBHOOK_SECRET` — needed only if you want to receive provider event alerts

## 2. Build and run

```sh
npm ci
npm run build
node --env-file=.env dist/server.mjs
```

Default port is `3583` (override with `PORT`). Use your host's start command or a process
manager. Health check: open `https://your-domain/api/web/config` — it shows which channels
are live.

## 3. Domain and HTTPS

Point your domain at the server over **HTTPS**. This is required: Telegram and WhatsApp
webhooks need HTTPS, and the browser microphone only works on HTTPS (or on `localhost`
during local dev).

## 4. (Recommended, free) Connect Telegram

No extra phone number, no business verification — a Telegram bot is free and anyone can
message it from a link.

1. In Telegram, message **@BotFather** → `/newbot`, give it a name, and copy the **bot
   token** it gives you.
2. Set `TELEGRAM_BOT_TOKEN` to that token. Optionally choose any random string for
   `TELEGRAM_WEBHOOK_SECRET` (recommended — it authenticates deliveries).
3. Register the webhook once (replace the token, domain, and secret):

   ```sh
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d url="https://your-domain/api/channels/telegram/webhook" \
     -d secret_token="<TELEGRAM_WEBHOOK_SECRET>"
   ```

   Verify with `.../getWebhookInfo`; undo with `.../deleteWebhook`.
4. Share your `https://t.me/<your_bot>` link. On first contact Kriya asks the customer to
   tap **"Share my number"** so it can match their card account (a one-tap, Telegram-verified
   step); after that they just chat. Done.

## 5. (Optional) Provider alerts (Hyperface webhooks)

Set `HYPERFACE_WEBHOOK_SECRET`, then subscribe Kriya's receiver:

```sh
curl -X POST https://your-domain/api/providers/hyperface/webhook/subscribe \
  -H 'content-type: application/json' \
  -d '{"event_type":"TRANSACTION_POSTED","scope":"ACCOUNT","scope_id":"<accountId>"}'
```

## Notes

- Web chat sign-in is by the customer's **card-registered mobile number**. Kriya looks it
  up live in Hyperface and links the real account. There is no seed or demo data in the system.
- On **Telegram**, a customer is identified by the number they share on first contact (the
  "Share my number" tap — a Telegram-verified possession factor). Proactive alerts reach them
  on Telegram only after they've messaged the bot at least once since the last restart.
- While Hyperface UAT is down, the mobile lookup returns no matches, so new numbers can't
  link yet; only an already-linked account (set as `DEMO_PHONE`) signs in. This clears
  automatically once UAT is back — no code change needed.
- Voice models default to `saarika:v2.5` (speech-to-text) and `bulbul:v2` (text-to-speech);
  override with `SARVAM_STT_MODEL` / `SARVAM_TTS_MODEL`.
