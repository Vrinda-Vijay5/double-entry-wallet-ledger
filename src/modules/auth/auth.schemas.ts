import { z } from 'zod';

/**
 * Password policy: length over composition rules. NIST 800-63B explicitly
 * recommends against mandatory character-class rules, which push users toward
 * predictable patterns like "Password1!" while adding little entropy.
 */
const password = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(200, 'password must be at most 200 characters');

export const RegisterSchema = z.object({
  email: z.string().email().max(320).transform((v) => v.trim().toLowerCase()),
  password,
});

export const LoginSchema = z.object({
  email: z.string().email().max(320).transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(10).max(500),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
