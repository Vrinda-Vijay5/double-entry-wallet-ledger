import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  idempotencyKey,
  registerUser,
  request,
  resetDatabase,
  shutdownTestResources,
  testApp,
  testPool,
  uniqueEmail,
} from '../setup/helpers';

describe('auth', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await shutdownTestResources();
  });

  const app = () => testApp();

  describe('register', () => {
    it('creates an account and returns a token pair', async () => {
      const email = uniqueEmail();
      const res = await request(app())
        .post('/v1/auth/register')
        .set('Idempotency-Key', idempotencyKey())
        .send({ email, password: 'correct-horse-battery-staple' });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ email, role: 'customer' });
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('never stores the password in plaintext', async () => {
      const password = 'correct-horse-battery-staple';
      const user = await registerUser({ password });

      const { rows } = await testPool().query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [user.id],
      );
      const hash = rows[0]!.password_hash;

      expect(hash).not.toContain(password);
      expect(hash.startsWith('$argon2id$')).toBe(true);
    });

    it('rejects a duplicate email case-insensitively', async () => {
      const email = uniqueEmail();
      await registerUser({ email });

      const res = await request(app())
        .post('/v1/auth/register')
        .set('Idempotency-Key', idempotencyKey())
        .send({ email: email.toUpperCase(), password: 'another-long-password' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('email_taken');
    });

    it('enforces a minimum password length', async () => {
      const res = await request(app())
        .post('/v1/auth/register')
        .set('Idempotency-Key', idempotencyKey())
        .send({ email: uniqueEmail(), password: 'short' });

      expect(res.status).toBe(400);
    });
  });

  describe('login', () => {
    it('issues tokens for correct credentials', async () => {
      const user = await registerUser();
      const res = await request(app())
        .post('/v1/auth/login')
        .send({ email: user.email, password: user.password });

      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');
    });

    it('gives the same error for a wrong password and an unknown email', async () => {
      const user = await registerUser();

      const wrongPassword = await request(app())
        .post('/v1/auth/login')
        .send({ email: user.email, password: 'definitely-not-the-password' });

      const unknownEmail = await request(app())
        .post('/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'definitely-not-the-password' });

      // Identical responses: login must not be an account-enumeration oracle.
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });
  });

  describe('access tokens', () => {
    it('rejects a request with no token', async () => {
      const res = await request(app()).get('/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('rejects a garbage token', async () => {
      const res = await request(app())
        .get('/v1/auth/me')
        .set('Authorization', 'Bearer not.a.jwt');
      expect(res.status).toBe(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
      const forged = jwt.sign({ role: 'admin', typ: 'access' }, 'a-different-secret-entirely', {
        subject: '00000000-0000-4000-8000-000000000001',
        issuer: 'ledger-api',
        audience: 'ledger-clients',
        expiresIn: '15m',
      });

      const res = await request(app())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('rejects an alg:none token', async () => {
      // Classic JWT bypass: unsigned token claiming admin.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: '00000000-0000-4000-8000-000000000001',
          role: 'admin',
          typ: 'access',
          iss: 'ledger-api',
          aud: 'ledger-clients',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      const res = await request(app())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${header}.${payload}.`);
      expect(res.status).toBe(401);
    });
  });

  describe('refresh rotation', () => {
    it('rotates the refresh token and returns a new pair', async () => {
      const user = await registerUser();

      const res = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.refreshToken).not.toBe(user.refreshToken);
      expect(typeof res.body.accessToken).toBe('string');

      // The new token works.
      const next = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: res.body.refreshToken });
      expect(next.status).toBe(200);
    });

    it('REJECTS reuse of an already-rotated token', async () => {
      const user = await registerUser();

      const rotated = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });
      expect(rotated.status).toBe(200);

      // Replaying the original token must fail.
      const replay = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });

      expect(replay.status).toBe(401);
      expect(replay.body.error.message).toMatch(/already been used/);
    });

    it('revokes the ENTIRE family when reuse is detected', async () => {
      const user = await registerUser();

      const gen2 = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });
      const gen3 = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: gen2.body.refreshToken });
      expect(gen3.status).toBe(200);

      // An attacker replays the stolen generation-1 token.
      const replay = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });
      expect(replay.status).toBe(401);

      // The legitimate client's current token is now dead too. That is the
      // point: a replay means the chain leaked, so the whole family burns and
      // the real user is forced to log in again.
      const afterBreach = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: gen3.body.refreshToken });
      expect(afterBreach.status).toBe(401);
    });

    it('rejects an unknown refresh token', async () => {
      const res = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: 'totally-made-up-token-value-here' });
      expect(res.status).toBe(401);
    });

    it('rejects an expired refresh token', async () => {
      const user = await registerUser();
      await testPool().query(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 day' WHERE user_id = $1`,
        [user.id],
      );

      const res = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/expired/);
    });

    it('mints exactly one successor when the same token is refreshed concurrently', async () => {
      const user = await registerUser();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app())
            .post('/v1/auth/refresh')
            .send({ refreshToken: user.refreshToken }),
        ),
      );

      const ok = responses.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
    });
  });

  describe('logout', () => {
    it('revokes every refresh token for the user', async () => {
      const user = await registerUser();

      const res = await request(app())
        .post('/v1/auth/logout')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('Idempotency-Key', idempotencyKey())
        .send({});
      expect(res.status).toBe(200);

      const refresh = await request(app())
        .post('/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken });
      expect(refresh.status).toBe(401);
    });
  });
});
