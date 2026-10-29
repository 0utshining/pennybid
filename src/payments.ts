import crypto from 'crypto';
import { safeEqual } from './auth';

/**
 * Generic payment provider. The only implementation shipped here is `mock`.
 * Stripe is intentionally not integrated: bidding-fee auctions are a prohibited business.
 * Real charging stays disabled until the operator sets PAYMENTS_ENABLED and replaces
 * this provider with one whose contract allows penny auctions.
 */
export type CheckoutRequest = {
  orderId: number;
  amountCents: number;
  kind: string;
  userId: number;
  description: string;
};

export type WebhookEvent = {
  id: string;
  type: 'payment.succeeded' | 'payment.failed';
  orderId: number;
  amountCents: number;
  providerRef: string;
};

export interface PaymentProvider {
  readonly name: string;
  createPayment(req: CheckoutRequest): Promise<{ providerRef: string; checkoutPath: string }>;
  sign(rawBody: string): string;
  verify(rawBody: Buffer | string, signature: string | undefined): boolean;
  parseEvent(rawBody: Buffer | string): WebhookEvent;
}

export function createMockProvider(secret: string): PaymentProvider {
  if (!secret || secret.length < 8) throw new Error('PAYMENT_WEBHOOK_SECRET must be at least 8 characters');
  const sign = (rawBody: string) => crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    name: 'mock',
    async createPayment(req) {
      return {
        providerRef: `mock_${req.orderId}`,
        checkoutPath: `/pay/mock/${req.orderId}`,
      };
    },
    sign,
    verify(rawBody, signature) {
      if (!signature) return false;
      const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
      const expected = sign(raw);
      return safeEqual(signature.trim(), expected);
    },
    parseEvent(rawBody) {
      const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
      const body = JSON.parse(raw) as Partial<WebhookEvent>;
      if (!body || (body.type !== 'payment.succeeded' && body.type !== 'payment.failed')) {
        throw new Error('invalid event type');
      }
      if (typeof body.id !== 'string' || !body.id || body.id.length > 200) throw new Error('invalid event id');
      if (!Number.isInteger(body.orderId) || (body.orderId as number) <= 0) throw new Error('invalid order');
      if (!Number.isInteger(body.amountCents) || (body.amountCents as number) < 0) throw new Error('invalid amount');
      if (typeof body.providerRef !== 'string') throw new Error('invalid provider ref');
      return {
        id: body.id,
        type: body.type,
        orderId: body.orderId as number,
        amountCents: body.amountCents as number,
        providerRef: body.providerRef.slice(0, 200),
      };
    },
  };
}

export function getProvider(name: string, secret: string): PaymentProvider {
  if (name !== 'mock') {
    throw new Error(
      `Payment provider "${name}" is not implemented. Only the mock provider ships with this build. ` +
      'Do not wire Stripe — it prohibits bidding-fee auctions. Keep PAYMENTS_ENABLED unset until counsel and a processor approve the business.',
    );
  }
  return createMockProvider(secret);
}
