// Auction rules live here. Operational flags come from the environment.
// Real card charging stays off until PAYMENTS_ENABLED=1 and an approved
// processor is plugged into the payment-provider interface. Do not add Stripe:
// Stripe's service agreement prohibits bidding-fee / penny auctions.

export type RateRule = { limit: number; windowSec: number };

export type Config = {
  siteName: string;
  companyName: string;
  supportEmail: string;
  jurisdiction: string;
  siteUrl: string;
  creditsPerBid: number;
  nominalBidPriceCents: number;
  priceIncrementCents: number;
  resetThresholdMs: number;
  resetToMs: number;
  allowConsecutiveBids: boolean;
  bidPacks: number[];
  shippingCents: number;
  signupBonusCredits: number;
  closerIntervalMs: number;
  paymentsEnabled: boolean;
  demoMode: boolean;
  paymentProvider: 'mock';
  sessionTtlMs: number;
  verifyTokenTtlMs: number;
  resetTokenTtlMs: number;
  minPasswordLength: number;
  legalDraftVersion: string;
  rateLimits: { bid: RateRule; login: RateRule; signup: RateRule };
};

function flag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const prod = process.env.NODE_ENV === 'production';
  const base: Config = {
    siteName: 'PennyBid',
    companyName: process.env.COMPANY_NAME || 'PennyBid Demo Co.',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@pennybid.example',
    jurisdiction: process.env.JURISDICTION || 'Delaware, USA',
    siteUrl: (process.env.SITE_URL || 'http://127.0.0.1:4317').replace(/\/$/, ''),
    creditsPerBid: 1,
    nominalBidPriceCents: 50,
    priceIncrementCents: 1,
    resetThresholdMs: 10_000,
    resetToMs: 10_000,
    allowConsecutiveBids: false,
    bidPacks: [10, 25, 50, 100],
    shippingCents: 799,
    signupBonusCredits: 20,
    closerIntervalMs: 200,
    paymentsEnabled: flag('PAYMENTS_ENABLED', false),
    demoMode: flag('DEMO_MODE', !prod),
    paymentProvider: 'mock',
    sessionTtlMs: 14 * 24 * 60 * 60 * 1000,
    verifyTokenTtlMs: 24 * 60 * 60 * 1000,
    resetTokenTtlMs: 60 * 60 * 1000,
    minPasswordLength: 8,
    legalDraftVersion: '2026-10-28-draft',
    rateLimits: {
      bid: { limit: 60, windowSec: 60 },
      login: { limit: 10, windowSec: 900 },
      signup: { limit: 5, windowSec: 3600 },
    },
  };
  return {
    ...base,
    ...overrides,
    rateLimits: { ...base.rateLimits, ...(overrides.rateLimits || {}) },
  };
}

export const config = loadConfig();
