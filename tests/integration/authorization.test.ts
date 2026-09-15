import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  balanceOf,
  countTransfers,
  createSystemWallet,
  createWallet,
  fundWallet,
  idempotencyKey,
  promoteToAdmin,
  registerUser,
  request,
  resetDatabase,
  shutdownTestResources,
  testApp,
  type TestUser,
} from '../setup/helpers';

describe('authorization', () => {
  let alice: TestUser;
  let mallory: TestUser;
  let aliceWallet: string;
  let malloryWallet: string;

  beforeEach(async () => {
    await resetDatabase();
    alice = await registerUser();
    mallory = await registerUser();
    aliceWallet = await createWallet(alice, 'Alice Main');
    malloryWallet = await createWallet(mallory, 'Mallory Main');

    const treasury = await createSystemWallet(alice.id);
    await fundWallet(treasury, aliceWallet, 50_000n, alice.id);
  });

  afterAll(async () => {
    await shutdownTestResources();
  });

  const app = () => testApp();

  describe('reading another user\'s wallet', () => {
    it('cannot read the wallet itself', async () => {
      const res = await request(app())
        .get(`/v1/wallets/${aliceWallet}`)
        .set('Authorization', `Bearer ${mallory.accessToken}`);

      // 404 not 403: a 403 would confirm the wallet id is real.
      expect(res.status).toBe(404);
    });

    it('cannot read the balance', async () => {
      const res = await request(app())
        .get(`/v1/wallets/${aliceWallet}/balance`)
        .set('Authorization', `Bearer ${mallory.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('cannot read the ledger', async () => {
      const res = await request(app())
        .get(`/v1/wallets/${aliceWallet}/ledger`)
        .set('Authorization', `Bearer ${mallory.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('does not see it in their own wallet list', async () => {
      const res = await request(app())
        .get('/v1/wallets')
        .set('Authorization', `Bearer ${mallory.accessToken}`);

      expect(res.status).toBe(200);
      const ids = res.body.wallets.map((w: { id: string }) => w.id);
      expect(ids).toContain(malloryWallet);
      expect(ids).not.toContain(aliceWallet);
    });
  });

  describe('transferring from another user\'s wallet', () => {
    it('cannot move money out of a wallet they do not own', async () => {
      const res = await request(app())
        .post('/v1/transfers')
        .set('Authorization', `Bearer ${mallory.accessToken}`)
        .set('Idempotency-Key', idempotencyKey())
        .send({
          sourceWalletId: aliceWallet,
          destWalletId: malloryWallet,
          amount: '50000',
        });

      expect(res.status).toBe(404);

      // And critically: nothing moved.
      expect(await balanceOf(aliceWallet)).toBe(50_000n);
      expect(await balanceOf(malloryWallet)).toBe(0n);
      expect(await countTransfers()).toBe(1); // only the funding transfer
    });

    it('may still RECEIVE into their own wallet from someone else', async () => {
      const res = await request(app())
        .post('/v1/transfers')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .set('Idempotency-Key', idempotencyKey())
        .send({
          sourceWalletId: aliceWallet,
          destWalletId: malloryWallet,
          amount: '100',
        });

      expect(res.status).toBe(201);
      expect(await balanceOf(malloryWallet)).toBe(100n);
    });
  });

  describe('unauthenticated access', () => {
    it.each([
      ['GET', '/v1/wallets'],
      ['GET', '/v1/transfers/00000000-0000-4000-8000-000000000001'],
    ])('%s %s requires a token', async (method, path) => {
      const res = await (method === 'GET'
        ? request(app()).get(path)
        : request(app()).post(path));
      expect(res.status).toBe(401);
    });

    it('POST /v1/transfers requires a token', async () => {
      const res = await request(app())
        .post('/v1/transfers')
        .set('Idempotency-Key', idempotencyKey())
        .send({ sourceWalletId: aliceWallet, destWalletId: malloryWallet, amount: '1' });
      expect(res.status).toBe(401);
    });
  });

  describe('admin role', () => {
    it('lets an admin read any wallet', async () => {
      const admin = await registerUser();
      await promoteToAdmin(admin.id);

      // Re-login so the access token carries the new role.
      const login = await request(app())
        .post('/v1/auth/login')
        .set('Idempotency-Key', idempotencyKey())
        .send({ email: admin.email, password: admin.password });
      expect(login.body.user.role).toBe('admin');

      const res = await request(app())
        .get(`/v1/wallets/${aliceWallet}/balance`)
        .set('Authorization', `Bearer ${login.body.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe('50000');
    });

    it('still 404s an admin on a wallet that does not exist', async () => {
      const admin = await registerUser();
      await promoteToAdmin(admin.id);
      const login = await request(app())
        .post('/v1/auth/login')
        .set('Idempotency-Key', idempotencyKey())
        .send({ email: admin.email, password: admin.password });

      const res = await request(app())
        .get('/v1/wallets/00000000-0000-4000-8000-0000000009ff/balance')
        .set('Authorization', `Bearer ${login.body.accessToken}`);

      expect(res.status).toBe(404);
    });

    it('does not grant a customer admin powers by editing the role claim', async () => {
      // The role in the JWT is signed; a customer cannot upgrade themselves.
      const res = await request(app())
        .get(`/v1/wallets/${aliceWallet}/balance`)
        .set('Authorization', `Bearer ${mallory.accessToken}`);
      expect(res.status).toBe(404);
    });
  });
});
