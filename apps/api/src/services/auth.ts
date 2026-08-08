import { PrivyClient } from '@privy-io/node';
import type { FastifyRequest } from 'fastify';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';

export type AuthClaims = { userId: string; appId: string; sessionId?: string; wallets: string[] };

export function createAuthService(config: ApiConfig) {
  const privy = new PrivyClient({
    appId: config.PRIVY_APP_ID,
    appSecret: config.PRIVY_APP_SECRET,
    ...(config.PRIVY_JWT_VERIFICATION_KEY ? { jwtVerificationKey: config.PRIVY_JWT_VERIFICATION_KEY } : {}),
  });
  const walletCache = new Map<string, { expires: number; wallets: string[] }>();

  return {
    async authenticate(request: FastifyRequest): Promise<AuthClaims> {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new AppError(401, 'AUTH_REQUIRED', 'A Privy access token is required');
      try {
        const claims = await privy.utils().auth().verifyAuthToken(header.slice(7));
        let cached = walletCache.get(claims.user_id);
        if (!cached || cached.expires < Date.now()) {
          const user = await privy.users()._get(claims.user_id);
          const wallets = user.linked_accounts.flatMap((account) => {
            const candidate = account as { address?: unknown };
            return typeof candidate.address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(candidate.address)
              ? [candidate.address.toLowerCase()]
              : [];
          });
          cached = { wallets, expires: Date.now() + 30_000 };
          walletCache.set(claims.user_id, cached);
        }
        return { userId: claims.user_id, appId: claims.app_id, sessionId: claims.session_id, wallets: cached.wallets };
      } catch {
        throw new AppError(401, 'INVALID_AUTH_TOKEN', 'The Privy access token is invalid or expired');
      }
    },
    assertWallet(claims: AuthClaims, wallet: string) {
      if (!claims.wallets.includes(wallet.toLowerCase())) {
        throw new AppError(403, 'WALLET_NOT_LINKED', 'The requested actor is not linked to this Privy session');
      }
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
