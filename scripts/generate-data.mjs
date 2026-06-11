#!/usr/bin/env node
// Deterministic seeded data generator for Sentinel v2.
// Produces: customers.json, transactions.json, payments.json, fees.json, emis.json
// Run: node scripts/generate-data.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────
const SEED = 20260610;
function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ── Reference data ────────────────────────────────────────────────────
const FIRST_NAMES = [
  'Rohan', 'Priya', 'Arjun', 'Sneha', 'Vikram', 'Ananya', 'Karan', 'Meera',
  'Rahul', 'Divya', 'Aditya', 'Pooja', 'Siddharth', 'Neha', 'Amit', 'Isha',
  'Rajesh', 'Kavya', 'Suresh', 'Tanvi', 'Manish', 'Ritu', 'Deepak', 'Swati',
  'Nikhil', 'Anjali', 'Gaurav', 'Pallavi', 'Varun', 'Shreya', 'Akash', 'Simran',
  'Vishal', 'Nisha', 'Ashish', 'Komal', 'Vivek', 'Aisha', 'Manoj', 'Sonal',
  'Harsh', 'Bhavna', 'Pankaj', 'Preeti', 'Sachin', 'Richa', 'Ajay', 'Megha',
  'Tushar', 'Jyoti'
];
const LAST_NAMES = [
  'Mehta', 'Sharma', 'Patel', 'Singh', 'Gupta', 'Joshi', 'Kumar', 'Reddy',
  'Iyer', 'Nair', 'Das', 'Verma', 'Kapoor', 'Malhotra', 'Chauhan', 'Mishra',
  'Bhat', 'Chopra', 'Tiwari', 'Saxena', 'Agarwal', 'Banerjee', 'Desai', 'Pillai',
  'Rao'
];
const CARD_VARIANTS = ['Classic', 'Gold', 'Platinum', 'Signature'];
const CARD_LIMITS = { Classic: [50000, 150000], Gold: [150000, 500000], Platinum: [500000, 1500000], Signature: [1000000, 2500000] };
const ANNUAL_FEES = { Classic: 500, Gold: 1500, Platinum: 3500, Signature: 7500 };

// MCC per category (ISO 18245 codes as used by Indian acquirers).
const MCC = {
  'Online Shopping': '5399', 'Food Delivery': '5814', 'Groceries': '5411',
  'Electronics': '5732', 'Entertainment': '7832', 'Travel': '4722',
  'Transport': '4121', 'Fashion': '5651', 'Healthcare': '5912',
  'Telecom': '4814', 'Fuel': '5541', 'Sports': '5941', 'Cafe': '5814',
  'Jewellery': '5944', 'Utilities': '4900', 'Insurance': '6300',
  'Luxury': '5999', 'Dining': '5812', 'Kirana (UPI)': '5411',
  'Rent': '6513', 'Education': '8299', 'Home Services': '7349',
  'Fitness': '7997',
};

const MERCHANTS = [
  { name: 'Amazon India', category: 'Online Shopping', loc: 'Mumbai, MH' },
  { name: 'Flipkart', category: 'Online Shopping', loc: 'Bengaluru, KA' },
  { name: 'Meesho', category: 'Online Shopping', loc: 'Bengaluru, KA' },
  { name: 'FirstCry', category: 'Online Shopping', loc: 'Pune, MH' },
  { name: 'Swiggy', category: 'Food Delivery', loc: 'Hyderabad, TS' },
  { name: 'Zomato', category: 'Food Delivery', loc: 'Delhi, DL' },
  { name: 'BigBasket', category: 'Groceries', loc: 'Bengaluru, KA' },
  { name: 'JioMart', category: 'Groceries', loc: 'Mumbai, MH' },
  { name: 'Reliance Digital', category: 'Electronics', loc: 'Mumbai, MH' },
  { name: 'Croma', category: 'Electronics', loc: 'Chennai, TN' },
  { name: 'Vijay Sales', category: 'Electronics', loc: 'Mumbai, MH' },
  { name: 'boAt Lifestyle', category: 'Electronics', loc: 'New Delhi, DL' },
  { name: 'BookMyShow', category: 'Entertainment', loc: 'Mumbai, MH' },
  { name: 'MakeMyTrip', category: 'Travel', loc: 'Gurugram, HR' },
  { name: 'IRCTC', category: 'Travel', loc: 'New Delhi, DL' },
  { name: 'Cleartrip', category: 'Travel', loc: 'Mumbai, MH' },
  { name: 'ixigo', category: 'Travel', loc: 'Gurugram, HR' },
  { name: 'redBus', category: 'Travel', loc: 'Bengaluru, KA' },
  { name: 'Air India', category: 'Travel', loc: 'Gurugram, HR' },
  { name: 'Akasa Air', category: 'Travel', loc: 'Mumbai, MH' },
  { name: 'Uber India', category: 'Transport', loc: 'Bengaluru, KA' },
  { name: 'Ola', category: 'Transport', loc: 'Pune, MH' },
  { name: 'Myntra', category: 'Fashion', loc: 'Bengaluru, KA' },
  { name: 'Ajio', category: 'Fashion', loc: 'Mumbai, MH' },
  { name: 'Shoppers Stop', category: 'Fashion', loc: 'Mumbai, MH' },
  { name: 'Westside', category: 'Fashion', loc: 'Mumbai, MH' },
  { name: 'Apollo Pharmacy', category: 'Healthcare', loc: 'Chennai, TN' },
  { name: 'PharmEasy', category: 'Healthcare', loc: 'Mumbai, MH' },
  { name: 'Tata 1mg', category: 'Healthcare', loc: 'Gurugram, HR' },
  { name: 'Practo', category: 'Healthcare', loc: 'Bengaluru, KA' },
  { name: 'Jio Recharge', category: 'Telecom', loc: 'Mumbai, MH' },
  { name: 'Airtel Payments', category: 'Telecom', loc: 'New Delhi, DL' },
  { name: 'Netflix India', category: 'Entertainment', loc: 'Mumbai, MH' },
  { name: 'Hotstar', category: 'Entertainment', loc: 'Mumbai, MH' },
  { name: 'Spencer\'s Retail', category: 'Groceries', loc: 'Kolkata, WB' },
  { name: 'DMart', category: 'Groceries', loc: 'Pune, MH' },
  { name: 'Indian Oil', category: 'Fuel', loc: 'New Delhi, DL' },
  { name: 'HP Petrol', category: 'Fuel', loc: 'Chennai, TN' },
  { name: 'Bharat Petroleum', category: 'Fuel', loc: 'Mumbai, MH' },
  { name: 'Decathlon India', category: 'Sports', loc: 'Bengaluru, KA' },
  { name: 'Starbucks India', category: 'Cafe', loc: 'Mumbai, MH' },
  { name: 'Third Wave Coffee', category: 'Cafe', loc: 'Bengaluru, KA' },
  { name: 'Chaayos', category: 'Cafe', loc: 'New Delhi, DL' },
  { name: 'PVR Cinemas', category: 'Entertainment', loc: 'Delhi, DL' },
  { name: 'Blinkit', category: 'Groceries', loc: 'Gurugram, HR' },
  { name: 'Zepto', category: 'Groceries', loc: 'Mumbai, MH' },
  { name: 'Nykaa', category: 'Fashion', loc: 'Mumbai, MH' },
  { name: 'Lenskart', category: 'Online Shopping', loc: 'Faridabad, HR' },
  { name: 'IndiGo', category: 'Travel', loc: 'Gurugram, HR' },
  { name: 'OYO Rooms', category: 'Travel', loc: 'Gurugram, HR' },
  { name: 'Rapido', category: 'Transport', loc: 'Bengaluru, KA' },
  { name: 'Tanishq', category: 'Jewellery', loc: 'Bengaluru, KA' },
  { name: 'Domino\'s Pizza', category: 'Dining', loc: 'Bengaluru, KA' },
  { name: 'McDonald\'s India', category: 'Dining', loc: 'Mumbai, MH' },
  { name: 'Haldiram\'s', category: 'Dining', loc: 'New Delhi, DL' },
  { name: 'Barbeque Nation', category: 'Dining', loc: 'Bengaluru, KA' },
  { name: 'Urban Company', category: 'Home Services', loc: 'Gurugram, HR' },
  { name: 'Cult.fit', category: 'Fitness', loc: 'Bengaluru, KA' },
  { name: 'NoBroker Rent Pay', category: 'Rent', loc: 'Bengaluru, KA' },
  { name: 'Vedantu', category: 'Education', loc: 'Bengaluru, KA' },
  { name: 'DPS School Fees (BBPS)', category: 'Education', loc: 'New Delhi, DL' },
  { name: 'Sharma Kirana Store', category: 'Kirana (UPI)', loc: 'Jaipur, RJ' },
  { name: 'Devi General Stores', category: 'Kirana (UPI)', loc: 'Lucknow, UP' },
  { name: 'Tata Power (BBPS)', category: 'Utilities', loc: 'Mumbai, MH' },
  { name: 'BSES Rajdhani (BBPS)', category: 'Utilities', loc: 'New Delhi, DL' },
  { name: 'LIC Premium (BBPS)', category: 'Insurance', loc: 'Mumbai, MH' },
  { name: 'LUXGOODS-ONLINE', category: 'Luxury', loc: 'International' },
  { name: 'TECHWORLD-STORE', category: 'Electronics', loc: 'International' },
  { name: 'GLOBALSHOP-UK', category: 'Online Shopping', loc: 'London, UK' },
];

// Reward earn rate: points per ₹150 spent, by variant. Fuel and utility/insurance
// BBPS spends earn nothing (fuel gets a surcharge waiver instead, per industry norm).
const EARN_RATE = { Classic: 1, Gold: 2, Platinum: 3, Signature: 5 };
// Rent and education joined the exclusion list across Indian issuers in 2024.
const NO_REWARD_CATEGORIES = new Set(['Fuel', 'Utilities', 'Insurance', 'Rent', 'Education']);
const LOUNGE_QUOTA = { Classic: 0, Gold: 4, Platinum: 8, Signature: 16 };
function pointsFor(variant, category, amount) {
  if (NO_REWARD_CATEGORIES.has(category)) return 0;
  return Math.floor(amount / 150) * EARN_RATE[variant];
}

const CHANNELS = ['POS', 'online', 'mobile', 'recurring', 'contactless'];
const DECLINE_REASONS = ['INSUFFICIENT_CREDIT_LIMIT', 'SUSPECTED_FRAUD_BLOCK', 'CARD_EXPIRED', 'INCORRECT_PIN', 'INTERNATIONAL_NOT_ENABLED'];

// 12-digit retrieval reference number, as printed on Indian charge slips.
const rrn = () => String(randInt(100000, 999999)) + String(randInt(100000, 999999));

// ── Helper: date arithmetic ───────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
}
function monthsBetween(d1, d2) {
  const a = new Date(d1), b = new Date(d2);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

// ── Generate customers ────────────────────────────────────────────────
const TODAY = '2026-06-10';
const names = shuffle(FIRST_NAMES);
const lastNames = shuffle(LAST_NAMES);

// Payment behavior profiles
const PROFILES = [
  { type: 'excellent', weight: 22 },  // always on-time, high CIBIL
  { type: 'good', weight: 14 },       // mostly on-time, occasional 1-2 day late
  { type: 'average', weight: 8 },     // some late payments
  { type: 'poor', weight: 4 },        // frequent late/missed
  { type: 'new', weight: 2 },         // < 6 months tenure, limited history
];

const profileAssignments = [];
for (const p of PROFILES) {
  for (let i = 0; i < p.weight; i++) profileAssignments.push(p.type);
}

// Specific demo customers with fixed IDs
const DEMO_CUSTOMERS = new Map([
  [1234, { name: 'Rohan Mehta', profile: 'excellent', variant: 'Platinum', tenureMonths: 48, network: 'Visa' }],
  [1110, { name: 'Aisha Joshi', profile: 'good', variant: 'Gold', tenureMonths: 24, network: 'Mastercard' }],
  [1543, { name: 'Swati Nair', profile: 'average', variant: 'Gold', tenureMonths: 18, network: 'Visa' }],
  [1006, { name: 'Rajesh Das', profile: 'excellent', variant: 'Classic', tenureMonths: 36, network: 'RuPay' }],
]);

// Card controls, network, and benefits shared by both generation loops.
function cardExtras(variant, profile, network) {
  const net = network ?? (variant === 'Classic' ? pick(['RuPay', 'Visa'])
    : variant === 'Signature' ? pick(['Visa', 'Mastercard'])
    : pick(['Visa', 'Mastercard', 'RuPay']));
  return {
    card_network: net,
    upi_linked: net === 'RuPay' ? 1 : 0, // UPI on credit card is RuPay-only in India
    online_enabled: 1,
    pos_enabled: 1,
    contactless_enabled: rand() > 0.15 ? 1 : 0,
    atm_enabled: profile === 'poor' ? 0 : 1,
    per_txn_limit: variant === 'Classic' ? 25000 : variant === 'Gold' ? 100000 : variant === 'Platinum' ? 300000 : 500000,
    lounge_visits_remaining: randInt(0, LOUNGE_QUOTA[variant]),
    lounge_visits_total: LOUNGE_QUOTA[variant],
    fuel_surcharge_waiver: variant === 'Classic' ? 0 : 1,
    autopay_enabled: rand() > 0.6 ? 1 : 0,
    autopay_mode: rand() > 0.5 ? 'minimum_due' : 'total_due',
  };
}

const customers = [];
const usedIds = new Set(DEMO_CUSTOMERS.keys());

function generateCustomerId() {
  let id;
  do { id = randInt(1001, 1999); } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

function cibilForProfile(profile) {
  switch (profile) {
    case 'excellent': return randInt(780, 850);
    case 'good': return randInt(720, 779);
    case 'average': return randInt(650, 719);
    case 'poor': return randInt(550, 649);
    case 'new': return randInt(680, 750);
  }
}

function riskScoreForProfile(profile) {
  switch (profile) {
    case 'excellent': return randInt(5, 20);
    case 'good': return randInt(15, 35);
    case 'average': return randInt(30, 55);
    case 'poor': return randInt(50, 80);
    case 'new': return randInt(25, 45);
  }
}

// Generate demo customers first
for (const [id, demo] of DEMO_CUSTOMERS) {
  const variant = demo.variant;
  const [minLimit, maxLimit] = CARD_LIMITS[variant];
  const creditLimit = Math.round(randInt(minLimit, maxLimit) / 10000) * 10000;
  const utilizationPct = demo.profile === 'poor' ? rand() * 0.5 + 0.5 : rand() * 0.4 + 0.1;
  const outstanding = Math.round(creditLimit * utilizationPct / 100) * 100;
  const billingDay = randInt(1, 28);
  const issuedOn = addMonths(TODAY, -demo.tenureMonths);
  const phone = `+91 ${randInt(70000, 99999)} ${randInt(10000, 99999)}`;

  customers.push({
    id,
    name: demo.name,
    email: demo.name.toLowerCase().replace(' ', '.') + '@gmail.com',
    phone,
    card_number_last4: String(randInt(1000, 9999)),
    card_variant: variant,
    card_status: 'active',
    card_issued_on: issuedOn,
    credit_limit: creditLimit,
    available_limit: creditLimit - outstanding,
    outstanding_total: outstanding,
    outstanding_billed: Math.round(outstanding * 0.7 / 100) * 100,
    minimum_due: Math.max(Math.round(outstanding * 0.05 / 100) * 100, outstanding > 0 ? 500 : 0),
    due_date: addDays(TODAY, randInt(5, 25)),
    billing_cycle_day: billingDay,
    cibil_score: cibilForProfile(demo.profile),
    risk_score: riskScoreForProfile(demo.profile),
    reward_points_balance: randInt(500, 15000),
    international_enabled: variant !== 'Classic' ? 1 : 0,
    annual_fee: ANNUAL_FEES[variant],
    kyc_status: 'verified',
    kyc_expiry: addMonths(TODAY, randInt(6, 24)),
    ...cardExtras(variant, demo.profile, demo.network),
    _profile: demo.profile,
    _tenure_months: demo.tenureMonths,
  });
}

// Generate remaining customers
let nameIdx = 0;
for (let i = customers.length; i < 300; i++) {
  const id = generateCustomerId();
  const firstName = names[nameIdx % names.length];
  const lastName = lastNames[nameIdx % lastNames.length];
  nameIdx++;
  const name = `${firstName} ${lastName}`;
  const profile = profileAssignments[i % profileAssignments.length];
  const variant = profile === 'poor' ? pick(['Classic', 'Gold']) :
    profile === 'new' ? pick(['Classic', 'Gold']) :
    profile === 'excellent' ? pick(['Gold', 'Platinum', 'Signature']) :
    pick(CARD_VARIANTS);
  const [minLimit, maxLimit] = CARD_LIMITS[variant];
  const creditLimit = Math.round(randInt(minLimit, maxLimit) / 10000) * 10000;
  const tenureMonths = profile === 'new' ? randInt(2, 5) : randInt(12, 60);
  const issuedOn = addMonths(TODAY, -tenureMonths);
  const statusPool = profile === 'poor' ? ['active', 'active', 'active', 'blocked', 'frozen'] : ['active'];
  const cardStatus = pick(statusPool);
  const utilizationPct = profile === 'poor' ? rand() * 0.5 + 0.4 : rand() * 0.4 + 0.05;
  const outstanding = Math.round(creditLimit * utilizationPct / 100) * 100;
  const billingDay = randInt(1, 28);
  const phone = `+91 ${randInt(70000, 99999)} ${randInt(10000, 99999)}`;

  customers.push({
    id,
    name,
    email: name.toLowerCase().replace(' ', '.') + '@gmail.com',
    phone,
    card_number_last4: String(randInt(1000, 9999)),
    card_variant: variant,
    card_status: cardStatus,
    card_issued_on: issuedOn,
    credit_limit: creditLimit,
    available_limit: Math.max(creditLimit - outstanding, 0),
    outstanding_total: outstanding,
    outstanding_billed: Math.round(outstanding * 0.7 / 100) * 100,
    minimum_due: Math.max(Math.round(outstanding * 0.05 / 100) * 100, outstanding > 0 ? 500 : 0),
    due_date: addDays(TODAY, randInt(5, 25)),
    billing_cycle_day: billingDay,
    cibil_score: cibilForProfile(profile),
    risk_score: riskScoreForProfile(profile),
    reward_points_balance: randInt(100, 20000),
    international_enabled: variant !== 'Classic' ? 1 : (rand() > 0.7 ? 1 : 0),
    annual_fee: ANNUAL_FEES[variant],
    kyc_status: profile === 'poor' ? pick(['verified', 'expired']) : 'verified',
    kyc_expiry: addMonths(TODAY, randInt(-3, 24)),
    ...cardExtras(variant, profile),
    _profile: profile,
    _tenure_months: tenureMonths,
  });
}

// ── Generate transactions ─────────────────────────────────────────────
const transactions = [];
let txnCounter = 1;

function txnId() {
  return `TXN-${String(txnCounter++).padStart(6, '0')}`;
}

function randomTimestamp(startDate, endDate) {
  const s = new Date(startDate).getTime();
  const e = new Date(endDate).getTime();
  const t = new Date(s + rand() * (e - s));
  return t.toISOString();
}

for (const cust of customers) {
  const tenureMonths = cust._tenure_months;
  const txnStart = addMonths(TODAY, -Math.min(tenureMonths, 6));
  const txnCount = randInt(20, 40);

  for (let t = 0; t < txnCount; t++) {
    let merchant = pick(MERCHANTS);
    // Kirana spends are UPI P2M — only possible on UPI-linked (RuPay) cards.
    while (merchant.category === 'Kirana (UPI)' && cust.upi_linked !== 1) merchant = pick(MERCHANTS);
    const isIntl = merchant.loc.includes('International') || merchant.loc.includes('UK');
    const amount = merchant.category === 'Food Delivery' ? randInt(150, 800) :
      merchant.category === 'Fuel' ? randInt(500, 5000) :
      merchant.category === 'Groceries' ? randInt(300, 4000) :
      merchant.category === 'Entertainment' ? randInt(200, 2000) :
      merchant.category === 'Telecom' ? randInt(200, 1500) :
      merchant.category === 'Transport' ? randInt(100, 800) :
      merchant.category === 'Electronics' ? randInt(5000, 80000) :
      merchant.category === 'Luxury' ? randInt(10000, 150000) :
      merchant.category === 'Travel' ? randInt(2000, 50000) :
      merchant.category === 'Dining' ? randInt(300, 3500) :
      merchant.category === 'Cafe' ? randInt(180, 900) :
      merchant.category === 'Kirana (UPI)' ? randInt(80, 1800) :
      merchant.category === 'Rent' ? randInt(15000, 45000) :
      merchant.category === 'Education' ? randInt(5000, 60000) :
      merchant.category === 'Home Services' ? randInt(400, 5000) :
      merchant.category === 'Fitness' ? randInt(800, 12000) :
      randInt(500, 15000);

    // Kirana UPI P2M rides on RuPay credit-on-UPI; other small spends go UPI
    // sometimes too if the card is UPI-linked.
    const channel = merchant.category === 'Kirana (UPI)' ? 'UPI'
      : (cust.upi_linked === 1 && amount < 2000 && rand() < 0.35) ? 'UPI'
      : pick(CHANNELS);

    const declined = rand() < 0.08;
    transactions.push({
      id: txnId(),
      customer_id: cust.id,
      timestamp: randomTimestamp(txnStart, TODAY),
      merchant: merchant.name,
      category: merchant.category,
      amount,
      currency: isIntl ? 'USD' : 'INR',
      channel,
      location: merchant.loc,
      status: declined ? 'DECLINED' : 'SUCCESS',
      decline_reason: declined ? pick(DECLINE_REASONS) : null,
      mcc: MCC[merchant.category] ?? '5999',
      reference_no: rrn(),
    });
  }
}

// Seeded patterns for demo customers

// Customer 1234: duplicate Amazon charge (₹2,499 x2, 3.5min apart)
const dup1ts = '2026-06-04T14:23:11.000Z';
const dup2ts = '2026-06-04T14:26:38.000Z';
transactions.push(
  { id: txnId(), customer_id: 1234, timestamp: dup1ts, merchant: 'Amazon India', category: 'Online Shopping', amount: 2499, currency: 'INR', channel: 'online', location: 'Mumbai, MH', status: 'SUCCESS', decline_reason: null },
  { id: txnId(), customer_id: 1234, timestamp: dup2ts, merchant: 'Amazon India', category: 'Online Shopping', amount: 2499, currency: 'INR', channel: 'online', location: 'Mumbai, MH', status: 'SUCCESS', decline_reason: null },
);
// Customer 1234: second duplicate pair (₹21,885 x2) at Reliance Digital
transactions.push(
  { id: txnId(), customer_id: 1234, timestamp: '2026-06-02T10:15:00.000Z', merchant: 'Reliance Digital', category: 'Electronics', amount: 21885, currency: 'INR', channel: 'POS', location: 'Mumbai, MH', status: 'SUCCESS', decline_reason: null },
  { id: txnId(), customer_id: 1234, timestamp: '2026-06-02T10:15:22.000Z', merchant: 'Reliance Digital', category: 'Electronics', amount: 21885, currency: 'INR', channel: 'POS', location: 'Mumbai, MH', status: 'SUCCESS', decline_reason: null },
);

// Customer 1110: fraud burst — overnight card-testing sequence
const fraudBase = '2026-06-08T01:';
transactions.push(
  { id: txnId(), customer_id: 1110, timestamp: `${fraudBase}12:00.000Z`, merchant: 'LUXGOODS-ONLINE', category: 'Luxury', amount: 4999, currency: 'INR', channel: 'online', location: 'International', status: 'SUCCESS', decline_reason: null },
  { id: txnId(), customer_id: 1110, timestamp: `${fraudBase}14:30.000Z`, merchant: 'LUXGOODS-ONLINE', category: 'Luxury', amount: 12499, currency: 'INR', channel: 'online', location: 'International', status: 'SUCCESS', decline_reason: null },
  { id: txnId(), customer_id: 1110, timestamp: `${fraudBase}18:00.000Z`, merchant: 'TECHWORLD-STORE', category: 'Electronics', amount: 28999, currency: 'INR', channel: 'online', location: 'International', status: 'SUCCESS', decline_reason: null },
  { id: txnId(), customer_id: 1110, timestamp: `${fraudBase}22:15.000Z`, merchant: 'GLOBALSHOP-UK', category: 'Online Shopping', amount: 22497, currency: 'USD', channel: 'online', location: 'London, UK', status: 'SUCCESS', decline_reason: null },
  { id: txnId(), customer_id: 1110, timestamp: `${fraudBase}25:00.000Z`, merchant: 'LUXGOODS-ONLINE', category: 'Luxury', amount: 23385, currency: 'INR', channel: 'online', location: 'International', status: 'DECLINED', decline_reason: 'SUSPECTED_FRAUD_BLOCK' },
);

// Customer 1543: unfamiliar charge at Reliance Digital
transactions.push(
  { id: txnId(), customer_id: 1543, timestamp: '2026-06-05T16:42:00.000Z', merchant: 'Reliance Digital', category: 'Electronics', amount: 49638, currency: 'INR', channel: 'POS', location: 'Chennai, TN', status: 'SUCCESS', decline_reason: null },
);

// Customer 1006: duplicate Swiggy charge
transactions.push(
  { id: txnId(), customer_id: 1006, timestamp: '2026-06-04T19:30:00.000Z', merchant: 'Swiggy', category: 'Food Delivery', amount: 308, currency: 'INR', channel: 'mobile', location: 'Kolkata, WB', status: 'SUCCESS', decline_reason: null },
  { id: txnId(), customer_id: 1006, timestamp: '2026-06-04T19:30:45.000Z', merchant: 'Swiggy', category: 'Food Delivery', amount: 308, currency: 'INR', channel: 'mobile', location: 'Kolkata, WB', status: 'SUCCESS', decline_reason: null },
);

// ── Generate payment history (18 months per customer) ─────────────────
const payments = [];
let paymentId = 1;

for (const cust of customers) {
  const profile = cust._profile;
  const monthsOfHistory = Math.min(cust._tenure_months, 18);
  const billingDay = cust.billing_cycle_day;

  for (let m = monthsOfHistory; m >= 1; m--) {
    const billingMonth = addMonths(TODAY, -m);
    const bm = billingMonth.slice(0, 7); // "2025-01"
    const dueDate = `${bm}-${String(Math.min(billingDay + 20, 28)).padStart(2, '0')}`;
    const statementAmount = randInt(3000, Math.min(cust.credit_limit * 0.4, 80000));
    const minDue = Math.max(Math.round(statementAmount * 0.05 / 100) * 100, 500);

    let daysLate = 0;
    let amountPaid = statementAmount;
    let paymentStatus = 'on_time';

    if (profile === 'excellent') {
      daysLate = 0;
    } else if (profile === 'good') {
      if (rand() < 0.08) { daysLate = randInt(1, 2); }
    } else if (profile === 'average') {
      if (rand() < 0.2) { daysLate = randInt(1, 10); }
      if (rand() < 0.05) { amountPaid = minDue; paymentStatus = 'partial'; }
    } else if (profile === 'poor') {
      if (rand() < 0.4) { daysLate = randInt(1, 30); }
      if (rand() < 0.15) { amountPaid = minDue; paymentStatus = 'partial'; }
      if (rand() < 0.05) { amountPaid = 0; paymentStatus = 'missed'; daysLate = 30; }
    } else if (profile === 'new') {
      if (rand() < 0.1) { daysLate = randInt(1, 3); }
    }

    if (daysLate > 0 && paymentStatus === 'on_time') paymentStatus = 'late';
    const paidOn = paymentStatus === 'missed' ? null : addDays(dueDate, daysLate);

    payments.push({
      id: paymentId++,
      customer_id: cust.id,
      billing_month: bm,
      statement_amount: statementAmount,
      minimum_due: minDue,
      amount_paid: amountPaid,
      paid_on: paidOn,
      due_date: dueDate,
      days_late: daysLate,
      payment_status: paymentStatus,
    });
  }
}

// Seed: Customer 1234 has a recent late payment (1 day late, most recent month)
// This is the demo scenario — customer complains about late fee, AI waives it
const rohan1234Payments = payments.filter(p => p.customer_id === 1234);
if (rohan1234Payments.length > 0) {
  const latest = rohan1234Payments.reduce((a, b) => a.billing_month > b.billing_month ? a : b);
  latest.days_late = 1;
  latest.payment_status = 'late';
  latest.paid_on = addDays(latest.due_date, 1);
}

// ── Generate fees ─────────────────────────────────────────────────────
const fees = [];
let feeId = 1;

// Every fee in India attracts 18% GST.
function pushFee(fee) {
  fees.push({
    id: feeId++,
    waived: 0,
    waived_on: null,
    waiver_reason: null,
    related_transaction_id: null,
    gst: Math.round(fee.amount * 0.18),
    ...fee,
  });
}

// Late payment fees from payment history
for (const p of payments) {
  if (p.days_late > 0 && p.payment_status !== 'missed') {
    const feeAmount = p.days_late <= 3 ? 500 : p.days_late <= 15 ? 750 : 1000;
    pushFee({
      customer_id: p.customer_id,
      fee_type: 'late_payment',
      amount: feeAmount,
      charged_on: addDays(p.due_date, p.days_late + 1),
      statement_month: p.billing_month,
    });
  }
}

// Annual fees (one per customer, charged on card anniversary)
for (const cust of customers) {
  if (cust._tenure_months >= 12) {
    pushFee({
      customer_id: cust.id,
      fee_type: 'annual',
      amount: cust.annual_fee,
      charged_on: addMonths(cust.card_issued_on, 12),
      statement_month: addMonths(cust.card_issued_on, 12).slice(0, 7),
    });
  }
}

// Finance charges for customers with partial payments
for (const p of payments) {
  if (p.payment_status === 'partial') {
    const unpaid = p.statement_amount - p.amount_paid;
    const financeCharge = Math.round(unpaid * 0.035); // 3.5% per month
    pushFee({
      customer_id: p.customer_id,
      fee_type: 'finance_charge',
      amount: financeCharge,
      charged_on: addDays(p.due_date, 30),
      statement_month: p.billing_month,
    });
  }
}

// Forex markup (3.5%) on every successful international spend
for (const t of transactions) {
  if (t.status === 'SUCCESS' && (t.currency === 'USD' || t.location.includes('International') || t.location.includes('UK'))) {
    // USD amounts are stored as INR-equivalent for simplicity in this demo set.
    pushFee({
      customer_id: t.customer_id,
      fee_type: 'forex_markup',
      amount: Math.round(t.amount * 0.035),
      charged_on: t.timestamp.split('T')[0],
      related_transaction_id: t.id,
      statement_month: t.timestamp.slice(0, 7),
    });
  }
}

// Cash advance fees (2.5%, min ₹500) — mostly average/poor profiles using ATM
for (const cust of customers) {
  if (cust.atm_enabled === 1 && ['average', 'poor'].includes(cust._profile) && rand() < 0.35) {
    const advance = randInt(2, 12) * 1000;
    const on = addDays(TODAY, -randInt(10, 120));
    pushFee({
      customer_id: cust.id,
      fee_type: 'cash_advance',
      amount: Math.max(500, Math.round(advance * 0.025)),
      charged_on: on,
      statement_month: on.slice(0, 7),
    });
  }
}

// Overlimit fees for heavily utilized poor-profile accounts
for (const cust of customers) {
  if (cust._profile === 'poor' && cust.outstanding_total > cust.credit_limit * 0.7 && rand() < 0.6) {
    const on = addDays(TODAY, -randInt(5, 90));
    pushFee({
      customer_id: cust.id,
      fee_type: 'overlimit',
      amount: 600,
      charged_on: on,
      statement_month: on.slice(0, 7),
    });
  }
}

// Occasional card replacement fees
for (const cust of customers) {
  if (rand() < 0.04) {
    const on = addDays(TODAY, -randInt(30, 300));
    pushFee({
      customer_id: cust.id,
      fee_type: 'card_replacement',
      amount: 200,
      charged_on: on,
      statement_month: on.slice(0, 7),
    });
  }
}

// ── Generate EMIs ─────────────────────────────────────────────────────
const emis = [];
let emiId = 1;

// ~15 customers have active EMIs
const emiCandidates = customers.filter(c => c._tenure_months >= 6 && c.card_status === 'active');
const emiCustomers = shuffle(emiCandidates).slice(0, 80);

for (const cust of emiCustomers) {
  const numEmis = rand() < 0.3 ? 2 : 1;
  for (let e = 0; e < numEmis; e++) {
    const merchant = pick(MERCHANTS.filter(m => ['Electronics', 'Online Shopping', 'Fashion', 'Travel'].includes(m.category)));
    const amount = merchant.category === 'Electronics' ? randInt(15000, 80000) :
      merchant.category === 'Travel' ? randInt(10000, 60000) :
      randInt(5000, 30000);
    const tenure = pick([3, 6, 9, 12]);
    const rate = tenure <= 6 ? 14 : 16; // annual rate %
    const monthlyRate = rate / 12 / 100;
    const emi = Math.round((amount * monthlyRate * Math.pow(1 + monthlyRate, tenure)) / (Math.pow(1 + monthlyRate, tenure) - 1));
    const remaining = randInt(1, tenure);
    const startedMonthsAgo = tenure - remaining;
    const txnDate = addMonths(TODAY, -startedMonthsAgo - 1);

    // Create a matching transaction
    const tid = txnId();
    transactions.push({
      id: tid,
      customer_id: cust.id,
      timestamp: randomTimestamp(txnDate, addDays(txnDate, 5)),
      merchant: merchant.name,
      category: merchant.category,
      amount,
      currency: 'INR',
      channel: pick(['online', 'POS']),
      location: merchant.loc,
      status: 'SUCCESS',
      decline_reason: null,
    });

    emis.push({
      id: `EMI-${String(emiId++).padStart(4, '0')}`,
      customer_id: cust.id,
      transaction_id: tid,
      merchant: merchant.name,
      principal_amount: amount,
      tenure_months: tenure,
      interest_rate: rate,
      monthly_installment: emi,
      remaining_installments: remaining,
      processing_fee: Math.round(amount * 0.01),
      foreclosure_charge_pct: 3,
      status: 'active',
      created_on: txnDate,
    });
  }
}

// ── Subscriptions on card autopay (RBI e-mandates / standing instructions) ─
const SUBSCRIPTION_PLANS = [
  { merchant: 'Netflix India', plan: 'Premium 4K', category: 'Entertainment', amount: 649, loc: 'Mumbai, MH' },
  { merchant: 'Netflix India', plan: 'Standard', category: 'Entertainment', amount: 499, loc: 'Mumbai, MH' },
  { merchant: 'Hotstar', plan: 'JioHotstar Super', category: 'Entertainment', amount: 299, loc: 'Mumbai, MH' },
  { merchant: 'Spotify India', plan: 'Premium Individual', category: 'Entertainment', amount: 119, loc: 'Mumbai, MH' },
  { merchant: 'Spotify India', plan: 'Premium Family', category: 'Entertainment', amount: 179, loc: 'Mumbai, MH' },
  { merchant: 'Amazon Prime', plan: 'Prime Monthly', category: 'Online Shopping', amount: 299, loc: 'Mumbai, MH' },
  { merchant: 'Amazon Prime', plan: 'Prime Annual', category: 'Online Shopping', amount: 1499, billing_cycle: 'annual', loc: 'Mumbai, MH' },
  { merchant: 'YouTube Premium', plan: 'Individual', category: 'Entertainment', amount: 149, loc: 'Gurugram, HR' },
  { merchant: 'SonyLIV', plan: 'Premium', category: 'Entertainment', amount: 299, loc: 'Mumbai, MH' },
  { merchant: 'Apple Services', plan: 'iCloud+ 200GB', category: 'Digital Services', amount: 219, loc: 'Bengaluru, KA' },
  { merchant: 'Google One', plan: '100GB storage', category: 'Digital Services', amount: 130, loc: 'Bengaluru, KA' },
  { merchant: 'Microsoft 365', plan: 'Personal', category: 'Digital Services', amount: 489, loc: 'Hyderabad, TS' },
  { merchant: 'Cult.fit', plan: 'Cultpass Elite', category: 'Fitness', amount: 1499, loc: 'Bengaluru, KA' },
  { merchant: 'Swiggy One', plan: 'Membership', category: 'Food Delivery', amount: 99, loc: 'Bengaluru, KA' },
  { merchant: 'Audible', plan: 'Monthly membership', category: 'Entertainment', amount: 199, loc: 'Mumbai, MH' },
  { merchant: 'LinkedIn Premium', plan: 'Career', category: 'Digital Services', amount: 1567, loc: 'Bengaluru, KA' },
  { merchant: 'Times Prime', plan: 'Annual membership', category: 'Digital Services', amount: 1199, billing_cycle: 'annual', loc: 'New Delhi, DL' },
];

const subscriptions = [];
let subSeq = 1;

const planByName = (merchant, plan) =>
  SUBSCRIPTION_PLANS.find((p) => p.merchant === merchant && (!plan || p.plan === plan));

function addSubscription(custId, def, opts = {}) {
  const cycle = def.billing_cycle ?? 'monthly';
  const startedMonthsAgo = opts.startedMonthsAgo ?? randInt(2, 20);
  const startedOn = addMonths(TODAY, -startedMonthsAgo);
  const status = opts.status ?? 'active';
  const cancelledOn = status === 'cancelled' ? addDays(TODAY, -randInt(10, 120)) : null;

  // Charges land on the subscription's anniversary day (capped at 28).
  const chargeDay = String(Math.min(Number(startedOn.slice(8, 10)) || 1, 28)).padStart(2, '0');
  let lastCharged = `${TODAY.slice(0, 7)}-${chargeDay}`;
  if (lastCharged > TODAY) lastCharged = addMonths(lastCharged, -1);
  if (cycle === 'annual') {
    const yearsIn = Math.max(Math.floor(monthsBetween(startedOn, TODAY) / 12), 0);
    lastCharged = addMonths(startedOn, yearsIn * 12);
  }
  if (cancelledOn && lastCharged > cancelledOn) lastCharged = addMonths(lastCharged, cycle === 'annual' ? -12 : -1);
  if (lastCharged < startedOn) lastCharged = startedOn;

  subscriptions.push({
    id: `SUB-${String(subSeq++).padStart(4, '0')}`,
    customer_id: custId,
    merchant: def.merchant,
    plan: def.plan,
    category: def.category,
    amount: def.amount,
    billing_cycle: cycle,
    started_on: startedOn,
    last_charged_on: lastCharged,
    next_charge_on: status === 'active' ? addMonths(lastCharged, cycle === 'annual' ? 12 : 1) : null,
    status,
    cancelled_on: cancelledOn,
  });

  // Recent recurring charges so the mandate lines up with transaction history.
  const chargeCount = status === 'active' && cycle === 'monthly' ? 3 : 1;
  for (let i = 0; i < chargeCount; i++) {
    const date = addMonths(lastCharged, -i * (cycle === 'annual' ? 12 : 1));
    if (date < startedOn) break;
    transactions.push({
      id: txnId(),
      customer_id: custId,
      timestamp: `${date}T0${randInt(6, 9)}:${randInt(10, 59)}:00.000Z`,
      merchant: def.merchant,
      category: def.category,
      amount: def.amount,
      currency: 'INR',
      channel: 'recurring',
      location: def.loc,
      status: 'SUCCESS',
      decline_reason: null,
      mcc: '5968', // Direct marketing — continuity/subscription merchants
    });
  }
}

// Demo customers get a fixed, story-friendly set.
addSubscription(1234, planByName('Netflix India', 'Premium 4K'), { startedMonthsAgo: 14 });
addSubscription(1234, planByName('Spotify India', 'Premium Family'), { startedMonthsAgo: 9 });
addSubscription(1234, planByName('Amazon Prime', 'Prime Annual'), { startedMonthsAgo: 13 });
addSubscription(1234, planByName('Cult.fit'), { startedMonthsAgo: 4 });
addSubscription(1234, planByName('Hotstar'), { startedMonthsAgo: 11, status: 'cancelled' });
addSubscription(1110, planByName('Hotstar'), { startedMonthsAgo: 8 });
addSubscription(1110, planByName('Swiggy One'), { startedMonthsAgo: 3 });
addSubscription(1543, planByName('Netflix India', 'Standard'), { startedMonthsAgo: 12 });
addSubscription(1543, planByName('YouTube Premium'), { startedMonthsAgo: 6 });
addSubscription(1006, planByName('Amazon Prime', 'Prime Monthly'), { startedMonthsAgo: 5 });

// ~60% of the rest of the book has 1-4 subscriptions on autopay.
for (const cust of customers) {
  if (DEMO_CUSTOMERS.has(cust.id)) continue;
  if (rand() > 0.6) continue;
  const count = ['Platinum', 'Signature'].includes(cust.card_variant) ? randInt(2, 4) : randInt(1, 3);
  const seen = new Set();
  for (const def of shuffle(SUBSCRIPTION_PLANS)) {
    if (seen.size >= count) break;
    if (seen.has(def.merchant)) continue;
    seen.add(def.merchant);
    addSubscription(cust.id, def, { status: rand() < 0.12 ? 'cancelled' : 'active' });
  }
}

// ── Reward points per transaction (variant earn rate, exclusions) ─────
const customerById = new Map(customers.map((c) => [c.id, c]));
for (const t of transactions) {
  const cust = customerById.get(t.customer_id);
  t.reward_points = t.status === 'SUCCESS' ? pointsFor(cust.card_variant, t.category, t.amount) : 0;
  t.mcc = t.mcc ?? MCC[t.category] ?? '5999';
  t.reference_no = t.reference_no ?? rrn();
}

// ── Sort transactions by timestamp ────────────────────────────────────
transactions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

// ── Monthly statements (derived from payment history, with breakdown) ──
const statements = [];
let stmtId = 1;
for (const p of payments) {
  const cust = customerById.get(p.customer_id);
  const purchases = Math.round(p.statement_amount * (rand() * 0.25 + 0.72) / 10) * 10;
  const financeCharges = p.payment_status === 'partial' ? Math.round(p.statement_amount * 0.03) : 0;
  const feesCharged = Math.max(p.statement_amount - purchases - financeCharges, 0) > 200
    ? Math.round((p.statement_amount - purchases - financeCharges) * 0.85)
    : 0;
  const gst = Math.round((feesCharged + financeCharges) * 0.18);
  const stmtDate = `${p.billing_month}-${String(Math.min(cust.billing_cycle_day, 28)).padStart(2, '0')}`;
  const monthTxns = transactions.filter(
    (t) => t.customer_id === p.customer_id && t.status === 'SUCCESS' && t.timestamp.slice(0, 7) === p.billing_month,
  );
  statements.push({
    id: stmtId++,
    customer_id: p.customer_id,
    statement_month: p.billing_month,
    statement_date: stmtDate,
    period_start: addMonths(stmtDate, -1),
    period_end: stmtDate,
    due_date: p.due_date,
    purchases,
    fees_charged: feesCharged,
    finance_charges: financeCharges,
    gst,
    total_due: p.statement_amount,
    minimum_due: p.minimum_due,
    reward_points_earned: monthTxns.reduce((s, t) => s + (t.reward_points ?? 0), 0),
    payment_status: p.payment_status,
    paid_on: p.paid_on,
    amount_paid: p.amount_paid,
  });
}

// ── Offers catalog (India card-market staples) ────────────────────────
const offers = [
  { id: 'OFF-001', title: '10% off on Swiggy', description: 'Get 10% instant discount up to ₹150 on orders above ₹499, twice a month.', merchant: 'Swiggy', category: 'Food Delivery', min_variant: 'Classic', valid_till: addDays(TODAY, 51), promo_code: 'SENTINEL10' },
  { id: 'OFF-002', title: '5% cashback on Amazon', description: '5% cashback up to ₹500 per statement cycle on Amazon India.', merchant: 'Amazon India', category: 'Online Shopping', min_variant: 'Gold', valid_till: addDays(TODAY, 82), promo_code: 'AUTO-APPLIED' },
  { id: 'OFF-003', title: 'BookMyShow buy-1-get-1', description: 'Buy one get one free on movie tickets every Saturday, up to ₹250.', merchant: 'BookMyShow', category: 'Entertainment', min_variant: 'Platinum', valid_till: addDays(TODAY, 113), promo_code: 'AUTO-APPLIED' },
  { id: 'OFF-004', title: '1% fuel surcharge waiver', description: 'Fuel surcharge waived on transactions of ₹400–₹5,000 at all fuel stations (max ₹250/cycle).', merchant: 'All fuel stations', category: 'Fuel', min_variant: 'Gold', valid_till: addDays(TODAY, 200), promo_code: 'AUTO-APPLIED' },
  { id: 'OFF-005', title: 'MakeMyTrip ₹2,000 off', description: 'Flat ₹2,000 off on domestic flights above ₹8,000. Once per quarter.', merchant: 'MakeMyTrip', category: 'Travel', min_variant: 'Platinum', valid_till: addDays(TODAY, 67), promo_code: 'SENTINELFLY' },
  { id: 'OFF-006', title: '20% off at Myntra EORS', description: 'Extra 20% off up to ₹1,000 during End of Reason Sale.', merchant: 'Myntra', category: 'Fashion', min_variant: 'Classic', valid_till: addDays(TODAY, 24), promo_code: 'SENTINELEORS' },
  { id: 'OFF-007', title: 'Airport lounge access', description: 'Complimentary domestic lounge visits per quarter on Gold and above.', merchant: 'Dreamfolks lounges', category: 'Travel', min_variant: 'Gold', valid_till: addDays(TODAY, 290), promo_code: 'SHOW-CARD' },
  { id: 'OFF-008', title: 'Zomato Gold for 3 months', description: 'Free Zomato Gold membership on spending ₹50,000 this quarter.', merchant: 'Zomato', category: 'Food Delivery', min_variant: 'Gold', valid_till: addDays(TODAY, 45), promo_code: 'MILESTONE' },
  { id: 'OFF-009', title: '7.5% off on BigBasket', description: '7.5% instant discount up to ₹300 on first order every month.', merchant: 'BigBasket', category: 'Groceries', min_variant: 'Classic', valid_till: addDays(TODAY, 39), promo_code: 'SENTINELBB' },
  { id: 'OFF-010', title: 'Tanishq ₹3,000 gift voucher', description: 'On jewellery purchases above ₹75,000 converted to EMI.', merchant: 'Tanishq', category: 'Jewellery', min_variant: 'Platinum', valid_till: addDays(TODAY, 95), promo_code: 'IN-STORE' },
  { id: 'OFF-011', title: '2x rewards on international spends', description: 'Double reward points on all international transactions this quarter.', merchant: 'International', category: 'International', min_variant: 'Platinum', valid_till: addDays(TODAY, 58), promo_code: 'AUTO-APPLIED' },
  { id: 'OFF-012', title: 'UPI on credit card', description: 'Link your RuPay credit card to UPI and earn rewards on UPI spends too.', merchant: 'All UPI apps', category: 'UPI', min_variant: 'Classic', valid_till: addDays(TODAY, 320), promo_code: 'RUPAY-ONLY' },
  { id: 'OFF-013', title: '10% off at Croma', description: '10% instant discount up to ₹2,000 on electronics above ₹15,000.', merchant: 'Croma', category: 'Electronics', min_variant: 'Gold', valid_till: addDays(TODAY, 35), promo_code: 'SENTINELCROMA' },
  { id: 'OFF-014', title: '15% off on Tata 1mg', description: '15% off up to ₹200 on medicines, once a month.', merchant: 'Tata 1mg', category: 'Healthcare', min_variant: 'Classic', valid_till: addDays(TODAY, 72), promo_code: 'SENTINEL1MG' },
  { id: 'OFF-015', title: 'Cleartrip ₹1,500 off international', description: 'Flat ₹1,500 off on international flights above ₹20,000.', merchant: 'Cleartrip', category: 'Travel', min_variant: 'Platinum', valid_till: addDays(TODAY, 88), promo_code: 'SENTINELINTL' },
  { id: 'OFF-016', title: '25% off dining via EazyDiner', description: 'Up to 25% off at 2,000+ premium restaurants, up to ₹750 per table.', merchant: 'EazyDiner', category: 'Dining', min_variant: 'Platinum', valid_till: addDays(TODAY, 130), promo_code: 'AUTO-APPLIED' },
  { id: 'OFF-017', title: '₹50 off Uber, 4x a month', description: '₹50 off four Uber rides every month when paid with this card.', merchant: 'Uber India', category: 'Transport', min_variant: 'Classic', valid_till: addDays(TODAY, 60), promo_code: 'AUTO-APPLIED' },
  { id: 'OFF-018', title: 'Blinkit free delivery + ₹100 off', description: 'Free delivery and ₹100 off on orders above ₹999, twice a month.', merchant: 'Blinkit', category: 'Groceries', min_variant: 'Gold', valid_till: addDays(TODAY, 42), promo_code: 'SENTINELBLINK' },
  { id: 'OFF-019', title: 'Decathlon ₹500 off', description: '₹500 off on sports gear above ₹2,500, once a quarter.', merchant: 'Decathlon India', category: 'Sports', min_variant: 'Classic', valid_till: addDays(TODAY, 77), promo_code: 'SENTINELFIT' },
  { id: 'OFF-020', title: 'IRCTC convenience fee waiver', description: 'Booking convenience fee waived on train tickets paid via RuPay credit on UPI.', merchant: 'IRCTC', category: 'Travel', min_variant: 'Classic', valid_till: addDays(TODAY, 180), promo_code: 'RUPAY-ONLY' },
];

// ── Rewards ledger (earned per statement month + occasional redemptions) ─
const VARIANT_RANK = { Classic: 0, Gold: 1, Platinum: 2, Signature: 3 };
const rewardsLedger = [];
let rlId = 1;
for (const s of statements) {
  if (s.reward_points_earned > 0) {
    rewardsLedger.push({
      id: rlId++,
      customer_id: s.customer_id,
      entry_type: 'earned',
      points: s.reward_points_earned,
      description: `Points earned on ${s.statement_month} statement spends`,
      entry_date: s.statement_date,
      expiry_date: addMonths(s.statement_date, 24),
    });
  }
}
for (const cust of customers) {
  if (cust._tenure_months >= 12 && rand() < 0.4) {
    const points = randInt(2, 20) * 250;
    rewardsLedger.push({
      id: rlId++,
      customer_id: cust.id,
      entry_type: 'redeemed',
      points: -points,
      description: `Redeemed against statement credit (₹${Math.round(points * 0.25)})`,
      entry_date: addMonths(TODAY, -randInt(1, 10)),
      expiry_date: null,
    });
  }
}

// ── Disputes / chargebacks (RBI lifecycle) ────────────────────────────
const DISPUTE_REASONS = [
  'Unauthorized transaction', 'Duplicate processing',
  'Goods or services not received', 'Amount differs from receipt',
  'Cancelled subscription still charged', 'Defective merchandise returned',
];
const disputes = [];
let dspId = 1;
const dId = () => `DSP-${String(dspId++).padStart(4, '0')}`;

function pushDispute(txn, reason, status, raisedDaysAgo, opts = {}) {
  const raisedOn = addDays(TODAY, -raisedDaysAgo);
  const resolved = status === 'won' || status === 'lost';
  disputes.push({
    id: dId(),
    customer_id: txn.customer_id,
    transaction_id: txn.id,
    merchant: txn.merchant,
    amount: txn.amount,
    reason,
    status, // under_review | provisional_credit | won | lost
    raised_on: raisedOn,
    resolved_on: resolved ? addDays(raisedOn, randInt(15, 45)) : null,
    provisional_credit: status === 'provisional_credit' || status === 'won' ? 1 : 0,
    resolution_note: status === 'won' ? 'Chargeback accepted by acquirer; credit made permanent.'
      : status === 'lost' ? 'Merchant provided valid proof of delivery/authorization.'
      : status === 'provisional_credit' ? 'Provisional credit issued per RBI TAT; merchant response awaited.'
      : 'Under review with the disputes team.',
    ...opts,
  });
}

// Demo customers get disputes in known states tied to their seeded patterns.
const txnsByCustomer = new Map();
for (const t of transactions) {
  if (!txnsByCustomer.has(t.customer_id)) txnsByCustomer.set(t.customer_id, []);
  txnsByCustomer.get(t.customer_id).push(t);
}
const relianceDup = transactions.find((t) => t.customer_id === 1234 && t.merchant === 'Reliance Digital' && t.amount === 21885);
if (relianceDup) pushDispute(relianceDup, 'Duplicate processing', 'provisional_credit', 6);
const unfamiliar1543 = transactions.find((t) => t.customer_id === 1543 && t.merchant === 'Reliance Digital' && t.amount === 49638);
if (unfamiliar1543) pushDispute(unfamiliar1543, 'Unauthorized transaction', 'under_review', 4);
const fraud1110 = transactions.find((t) => t.customer_id === 1110 && t.merchant === 'LUXGOODS-ONLINE' && t.amount === 12499);
if (fraud1110) pushDispute(fraud1110, 'Unauthorized transaction', 'under_review', 2);

// Random historical disputes across the book.
const disputeCandidates = shuffle(customers.filter((c) => !DEMO_CUSTOMERS.has(c.id))).slice(0, 40);
for (const cust of disputeCandidates) {
  const eligible = (txnsByCustomer.get(cust.id) ?? []).filter((t) => t.status === 'SUCCESS' && t.amount >= 500);
  if (!eligible.length) continue;
  const txn = pick(eligible);
  const roll = rand();
  const status = roll < 0.4 ? 'won' : roll < 0.6 ? 'lost' : roll < 0.85 ? 'under_review' : 'provisional_credit';
  pushDispute(txn, pick(DISPUTE_REASONS), status, randInt(3, 150));
}

// ── CIBIL score history (12 months, random walk ending at today's score) ─
const cibilHistory = [];
for (const cust of customers) {
  let score = cust.cibil_score;
  const rows = [];
  for (let m = 0; m < 12; m++) {
    rows.push({ customer_id: cust.id, month: addMonths(TODAY, -m).slice(0, 7), score });
    score = Math.max(300, Math.min(900, score + randInt(-18, 12)));
  }
  cibilHistory.push(...rows.reverse());
}

// ── Spend milestones (annual fee waiver + quarterly bonus) ────────────
const FEE_WAIVER_TARGET = { Classic: 50000, Gold: 150000, Platinum: 300000, Signature: 500000 };
const milestones = [];
let msId = 1;
const stmtsByCustomer = new Map();
for (const s of statements) {
  if (!stmtsByCustomer.has(s.customer_id)) stmtsByCustomer.set(s.customer_id, []);
  stmtsByCustomer.get(s.customer_id).push(s);
}
for (const cust of customers) {
  const stmts = (stmtsByCustomer.get(cust.id) ?? []).sort((a, b) => b.statement_month.localeCompare(a.statement_month));
  const target = FEE_WAIVER_TARGET[cust.card_variant];
  const yearSpend = stmts.slice(0, 12).reduce((s, x) => s + x.purchases, 0);
  const anniversaryMonths = cust._tenure_months % 12;
  milestones.push({
    id: `MS-${String(msId++).padStart(4, '0')}`,
    customer_id: cust.id,
    title: 'Annual fee waiver',
    description: `Spend ₹${target.toLocaleString('en-IN')} in your card year and the ₹${cust.annual_fee.toLocaleString('en-IN')} annual fee is waived.`,
    target_amount: target,
    achieved_amount: Math.min(yearSpend, Math.round(target * 1.4)),
    reward: `₹${cust.annual_fee.toLocaleString('en-IN')} annual fee waived`,
    period_end: addMonths(TODAY, 12 - anniversaryMonths),
    status: yearSpend >= target ? 'achieved' : 'in_progress',
  });
  if (cust.card_variant !== 'Classic') {
    const qTarget = cust.card_variant === 'Gold' ? 75000 : cust.card_variant === 'Platinum' ? 125000 : 200000;
    const qBonus = cust.card_variant === 'Gold' ? 2000 : cust.card_variant === 'Platinum' ? 5000 : 10000;
    const qSpend = stmts.slice(0, 3).reduce((s, x) => s + x.purchases, 0);
    milestones.push({
      id: `MS-${String(msId++).padStart(4, '0')}`,
      customer_id: cust.id,
      title: 'Quarterly bonus points',
      description: `Spend ₹${qTarget.toLocaleString('en-IN')} this quarter to earn ${qBonus.toLocaleString('en-IN')} bonus points.`,
      target_amount: qTarget,
      achieved_amount: Math.min(qSpend, Math.round(qTarget * 1.2)),
      reward: `${qBonus.toLocaleString('en-IN')} bonus points`,
      period_end: addDays(TODAY, 90 - randInt(0, 75)),
      status: qSpend >= qTarget ? 'achieved' : 'in_progress',
    });
  }
}

// ── Lounge visit history (used quota this quarter) ────────────────────
const LOUNGES = [
  'Delhi T3 — Plaza Premium', 'Mumbai T2 — Adani Lounge',
  'Bengaluru T1 — 080 International', 'Hyderabad — Encalm Lounge',
  'Chennai — Travel Club', 'Kolkata — Travel Club',
  'Pune — Bird Lounge', 'Goa Mopa — Encalm Lounge',
];
const loungeVisits = [];
let lvId = 1;
for (const cust of customers) {
  const used = cust.lounge_visits_total - cust.lounge_visits_remaining;
  for (let v = 0; v < used; v++) {
    loungeVisits.push({
      id: lvId++,
      customer_id: cust.id,
      lounge: pick(LOUNGES),
      visit_date: addDays(TODAY, -randInt(2, 88)),
      guests: rand() < 0.25 ? 1 : 0,
    });
  }
}

// ── Reward redemption catalog (India staples) ─────────────────────────
const redemptionCatalog = [
  { id: 'RC-001', title: 'Statement credit', brand: 'Sentinel', category: 'Cashback', points_required: 500, value_inr: 125, min_variant: 'Classic', kind: 'credit', note: 'Any amount above 500 points, 1 pt = ₹0.25' },
  { id: 'RC-002', title: 'Amazon Pay eGift ₹500', brand: 'Amazon Pay', category: 'Shopping', points_required: 2000, value_inr: 500, min_variant: 'Classic', kind: 'voucher', note: 'Delivered to registered email in 24h' },
  { id: 'RC-003', title: 'Flipkart voucher ₹500', brand: 'Flipkart', category: 'Shopping', points_required: 2000, value_inr: 500, min_variant: 'Classic', kind: 'voucher', note: 'Valid for 12 months' },
  { id: 'RC-004', title: 'Swiggy Money ₹250', brand: 'Swiggy', category: 'Food', points_required: 1000, value_inr: 250, min_variant: 'Classic', kind: 'voucher', note: 'Credits to Swiggy wallet' },
  { id: 'RC-005', title: 'BookMyShow voucher ₹300', brand: 'BookMyShow', category: 'Entertainment', points_required: 1200, value_inr: 300, min_variant: 'Classic', kind: 'voucher', note: 'Movies and live events' },
  { id: 'RC-006', title: 'HPCL fuel voucher ₹500', brand: 'HP Pay', category: 'Fuel', points_required: 2100, value_inr: 500, min_variant: 'Gold', kind: 'voucher', note: 'Redeem at any HPCL pump' },
  { id: 'RC-007', title: 'MakeMyTrip holiday ₹2,500', brand: 'MakeMyTrip', category: 'Travel', points_required: 9500, value_inr: 2500, min_variant: 'Gold', kind: 'voucher', note: 'Flights, hotels and holidays' },
  { id: 'RC-008', title: 'Croma e-voucher ₹1,000', brand: 'Croma', category: 'Electronics', points_required: 4000, value_inr: 1000, min_variant: 'Gold', kind: 'voucher', note: 'In-store and online' },
  { id: 'RC-009', title: 'Air India Maharaja points', brand: 'Air India', category: 'Miles', points_required: 5000, value_inr: 1750, min_variant: 'Platinum', kind: 'miles', note: '1:1 transfer, min 5,000 points' },
  { id: 'RC-010', title: 'Tanishq gift card ₹5,000', brand: 'Tanishq', category: 'Jewellery', points_required: 19000, value_inr: 5000, min_variant: 'Signature', kind: 'voucher', note: 'Valid at all Tanishq stores' },
];

// ── Strip internal fields from customers ──────────────────────────────
const cleanCustomers = customers.map(({ _profile, _tenure_months, ...rest }) => rest);

// ── Write files ───────────────────────────────────────────────────────
const write = (name, data) => {
  const p = path.join(DATA, name);
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  console.log(`  ${name}: ${data.length} records`);
};

console.log('Generating Sentinel v2 data...');
write('customers.json', cleanCustomers);
write('transactions.json', transactions);
write('payments.json', payments);
write('fees.json', fees);
write('emis.json', emis);
write('statements.json', statements);
write('offers.json', offers);
write('rewards_ledger.json', rewardsLedger);
write('disputes.json', disputes);
write('cibil_history.json', cibilHistory);
write('milestones.json', milestones);
write('lounge_visits.json', loungeVisits);
write('subscriptions.json', subscriptions);
write('redemption_catalog.json', redemptionCatalog);
console.log('Done.');
