# Kriya fintech leadership demo runbook

This runbook describes exactly how to run the Sentinel credit-card copilot demo for fintech leadership.

## Demo setup & verified state

* **UAT system-of-record**: Every figure shown is pulled live from the Hyperface system-of-record.
* **Strict-live honesty**: For endpoints where the bank has not enabled a feed yet (like transaction lists, statement history, billed/unbilled feeds), Kriya says so honestly ("This live feed is pending bank-side enablement") instead of guessing or fabricating data.
* **Mutations active**: Write operations (card lock/unlock, EMI conversions, credit limit adjustments, autopay cancellations) are enabled (`HYPERFACE_ALLOW_MUTATIONS=true`) and will record the audit trails in the database.

---

## The UAT test profiles

Use one of these registered numbers to sign in. These represent real customers loaded from Hyperface:

| Mobile number | Customer | What you will see |
| :--- | :--- | :--- |
| **8398480550** | Jaden Peyton (ending in `...3350`) | Outstanding balance ₹1,457.04, available ₹18,542.96 |
| **8605763345** | Henry Olivia (ending in `...8100`) | ₹0 due (credit surplus) |

---

## Step-by-step demo flow

### 1. Web chat login & live balance check
1. Open Kriya at the web chat interface (e.g. `https://sentinel-c92w.onrender.com/chat`).
2. Enter **8398480550** (Jaden) and click **Continue**. Kriya will load Jaden's live profile.
3. In the chat, type: `"What is my outstanding balance?"` (or tap the suggestion chip).
4. **Observation**: Sentinel investigations stage runs in the background. Kriya returns Jaden's exact live outstanding balance of **₹1,457.04** and available limit of **₹18,542.96**.
   > **Key Highlight**: "Every number here is pulled live from the Hyperface system of record. There is zero mock data."

### 2. Strict-live honesty story
1. In the chat, type: `"Show my recent transactions"` (or tap the suggestion chip).
2. **Observation**: Kriya returns:
   > *"I cannot retrieve your transactions from the live system right now because the bank feed has not been enabled yet. I can, however, help with your live balance, limits, and card status."*
   > **Key Highlight**: "When a bank feed isn't enabled or is down, Sentinel is transparent instead of hallucinating. It strictly tells the truth."

### 3. Identity verification & policy gating
1. In the chat, type: `"I want to increase my credit limit"` (or tap the suggestion chip).
2. **Observation**: Since credit limit enhancement is a sensitive action, Kriya prompts for verification:
   > *"To keep your account secure, please provide the last 4 digits of your card so I can verify your identity."*
3. Type: **3350** (Jaden's card last 4).
4. **Observation**: Kriya confirms identity verification. It then runs the credit limit policy gate check (`check_credit_limit_increase_eligibility`) to evaluate vintage, utilization, CIBIL, and payment history. It will check eligibility and output the policy decision.

### 4. Autopay cancellation (RBI compliance)
1. In the chat, type: `"Show my active autopays and cancel my Netflix mandate."`
2. **Observation**: Sentinel retrieves subscription/mandate records, checks cancellation eligibility, revokes the autopay mandate, and outputs a structured cancellation receipt (cancellation status, mandate ID, zero customer fee policy).

### 5. Voice chat demo (Sarvam)
1. Click the **microphone** icon in the input area.
2. Speak clearly in English, Hindi, or Hinglish: `"What is my credit limit?"` (or equivalent).
3. **Observation**: Kriya transcribes the voice using Sarvam STT, routes it through the Sentinel pipeline, streams the text response, and speaks the answer back aloud using Sarvam TTS.
