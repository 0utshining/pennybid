import { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'bad_request') {
    super(message);
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues[0]?.message || 'Invalid input';
    throw new HttpError(400, msg.slice(0, 200), 'invalid_input');
  }
  return result.data;
}

const clean = (max: number) => z.string().trim().min(1).max(max).transform((s) => s.replace(/[\u0000-\u001F\u007F]/g, ''));

export const emailSchema = z.string().trim().email('Enter a valid email').max(200).transform((s) => s.toLowerCase());
export const passwordSchema = (min: number) => z.string().min(min, `Password must be at least ${min} characters`).max(200);
export const loginPasswordSchema = z.string().min(1, 'Password is required').max(200);
export const nameSchema = clean(40);
export const nextSchema = z.string().optional();

export const addressSchema = z.object({
  name: clean(80),
  line1: clean(120),
  line2: z.string().trim().max(120).optional().transform((s) => s || ''),
  city: clean(80),
  region: clean(80),
  postal: z.string().trim().min(2).max(20),
  country: z.string().trim().min(2).max(56),
});
export type Address = z.infer<typeof addressSchema>;

export const signupSchema = (minPw: number) => z.object({
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema(minPw),
  next: nextSchema,
  _csrf: z.string().optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
  next: nextSchema,
  _csrf: z.string().optional(),
});

export const forgotSchema = z.object({
  email: emailSchema,
  _csrf: z.string().optional(),
});

export const resetSchema = (minPw: number) => z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema(minPw),
  _csrf: z.string().optional(),
});

export const disputeSchema = z.object({
  subject: clean(120),
  message: z.string().trim().min(1, 'Describe the problem').max(2000),
  auction_id: z.string().optional(),
  _csrf: z.string().optional(),
});

export const reviewSchema = z.object({
  auction_id: z.coerce.number().int().positive(),
  body: z.string().trim().min(8, 'Write at least a sentence').max(600),
  rating: z.coerce.number().int().min(1).max(5),
  _csrf: z.string().optional(),
});

export const productSchema = z.object({
  name: clean(120),
  description: z.string().trim().max(2000).optional().transform((s) => s || ''),
  retail: z.coerce.number().min(0).max(1_000_000),
  inventory: z.coerce.number().int().min(0).max(1_000_000),
});

export const scheduleSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  start: z.string().min(10).max(40),
  minutes: z.coerce.number().int().min(1).max(10_080),
  tz: z.coerce.number().int().min(-14 * 60).max(14 * 60).optional().default(0),
});

export const shipSchema = z.object({
  status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled']),
  tracking: z.string().trim().max(80).optional().transform((s) => s || ''),
  carrier: z.string().trim().max(40).optional().transform((s) => s || ''),
});

export const creditRefundSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  credits: z.coerce.number().int().positive().max(100_000),
  note: z.string().trim().min(1, 'A reason is required').max(500),
});

export const orderRefundSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});

export const noteSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  status: z.enum(['open', 'investigating', 'resolved']).optional(),
  refund: z.coerce.number().int().min(0).max(100_000).optional(),
});

export const testimonialModSchema = z.object({
  status: z.enum(['approved', 'rejected', 'pending']),
});
