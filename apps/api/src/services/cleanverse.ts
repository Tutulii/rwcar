import { createCipheriv } from 'node:crypto';
import type { ApiConfig } from '../config.js';
import { UpstreamError } from '../errors.js';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ApassRecord {
  active: boolean;
  tier: number | null;
  subTier: number | null;
  status: number | null;
  expiresAt: string | null;
  group: string | null;
  subGroup: string | null;
  countries: string[];
  raw: JsonObject;
}

export interface ApassVerification {
  code: number | null;
  allowed: boolean;
  raw: JsonObject;
}

export interface AssetApplication {
  issued: boolean;
  paused: boolean;
  pauseKnown: boolean;
  status: string | null;
  chain: string | null;
  tokenAddress: string | null;
  raw: JsonObject;
}

export interface SupportedAsset {
  chain: string;
  tokenAddress: string;
  raw: JsonObject;
}

export interface ValidatorMutation {
  chain: string;
  address: string;
  txHash: string;
  raw: JsonObject;
}

export class CleanverseClient {
  constructor(private readonly config: ApiConfig, private readonly fetcher: typeof fetch = fetch) {}

  encryptBody(body: JsonObject): { data: string } {
    const key = Buffer.from(this.config.CLEANVERSE_API_KEY, 'base64');
    if (![16, 24, 32].includes(key.length)) throw new Error('Cleanverse API key must decode to an AES key');
    const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
    return { data: encrypted.toString('base64') };
  }

  private async request(path: string, init: RequestInit = {}): Promise<JsonObject> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await this.fetcher(`${this.config.CLEANVERSE_BASE_URL}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'api-id': this.config.CLEANVERSE_API_ID,
            ...init.headers,
          },
        });
        const json = asObject(await response.json().catch(() => ({})));
        if (response.status === 429 || response.status >= 500) {
          lastError = new UpstreamError('Cleanverse', String(json.message ?? `HTTP ${response.status}`), { upstreamCode: json.code, retryable: true });
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
            continue;
          }
        }
        if (!response.ok || (json.code !== undefined && json.code !== '0000' && json.code !== 0)) {
          throw new UpstreamError('Cleanverse', String(json.message ?? `HTTP ${response.status}`), { upstreamCode: json.code, retryable: false });
        }
        return json;
      } catch (error) {
        lastError = error;
        if (error instanceof UpstreamError && error.details?.retryable !== true) throw error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
      } finally {
        clearTimeout(timeout);
      }
    }
    if (lastError instanceof UpstreamError) throw lastError;
    throw new UpstreamError('Cleanverse', lastError instanceof Error ? lastError.message : 'Request failed');
  }

  private post(path: string, body: JsonObject) {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async queryApass(chain: string, address: string): Promise<ApassRecord> {
    const response = await this.post('/query_apass', { chain, address });
    const data = asObject(response.data);
    const status = readNumber(data.status);
    const expiration = readNumber(data.expirationTime ?? data.expiration_time);
    const expirationMs = expiration ? expiration * (expiration < 10_000_000_000 ? 1000 : 1) : null;
    const active = status === 1 && (!expirationMs || expirationMs > Date.now());
    const group = typeof data.group === 'string' && data.group ? data.group : null;
    const subGroupValue = data.subGroup ?? data.sub_group;
    const subGroup = typeof subGroupValue === 'string' && subGroupValue ? subGroupValue : null;
    const countries = Array.isArray(data.countries) ? data.countries.filter((value): value is string => typeof value === 'string') : [];
    return {
      active,
      tier: readNumber(data.tier),
      subTier: readNumber(data.subTier ?? data.sub_tier),
      status,
      expiresAt: expirationMs ? new Date(expirationMs).toISOString() : null,
      group,
      subGroup,
      countries,
      raw: data,
    };
  }

  async verifyApass(chain: string, atoken: string, address: string): Promise<ApassVerification> {
    const response = await this.post('/verify_apass', { chain, atoken, address });
    const data = asObject(response.data);
    const code = readNumber(data.code ?? response.code);
    return { code, allowed: code === 4, raw: data };
  }

  async queryAssetApplication(requestId: string): Promise<AssetApplication> {
    const response = await this.request(`/atoken/query_apply_status/${encodeURIComponent(requestId)}`, { method: 'GET' });
    const data = asObject(response.data);
    const callbackValue = data.callback ?? data.callbackData ?? data.callback_data;
    let callback = asObject(callbackValue);
    if (typeof callbackValue === 'string') {
      try { callback = asObject(JSON.parse(callbackValue)); } catch { callback = {}; }
    }
    const details = { ...callback, ...data };
    const statusValue = details.applyStatus ?? details.apply_status ?? details.status;
    const status = typeof statusValue === 'string' ? statusValue.toUpperCase() : null;
    const chainValue = details.chain ?? details.network ?? details.chainName ?? details.chain_name;
    const chain = typeof chainValue === 'string' && chainValue ? chainValue.toLowerCase() : null;
    const tokenValue = details.atokenAddress ?? details.aTokenAddress ?? details.atoken_address
      ?? details.tokenAddress ?? details.token_address ?? asObject(details.atoken).address;
    const tokenAddress = typeof tokenValue === 'string' && /^0x[a-fA-F0-9]{40}$/.test(tokenValue)
      ? tokenValue.toLowerCase()
      : null;
    const pauseValue = details.paused ?? details.isPaused ?? details.is_paused;
    const pauseKnown = typeof pauseValue === 'boolean' || pauseValue === 0 || pauseValue === 1 || pauseValue === '0' || pauseValue === '1';
    const paused = pauseKnown ? pauseValue === true || pauseValue === 1 || pauseValue === '1' : true;
    return {
      issued: status === 'ISSUED',
      paused,
      pauseKnown,
      status,
      chain,
      tokenAddress,
      raw: data,
    };
  }

  async querySupportedAssets(chain: string): Promise<JsonObject[]> {
    const response = await this.post('/query_deposit_atoken_list', { chain });
    const data = asObject(response.data);
    return Array.isArray(data.tokens) ? data.tokens.map(asObject) : [];
  }

  async querySupportedAsset(chain: string, atoken: string): Promise<SupportedAsset | null> {
    const normalized = atoken.toLowerCase();
    const tokens = await this.querySupportedAssets(chain);
    const match = tokens.find((entry) => {
      const address = asObject(entry.atoken).address;
      return typeof address === 'string' && address.toLowerCase() === normalized;
    });
    if (!match) return null;
    const address = asObject(match.atoken).address;
    if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
    return {
      chain: chain.toLowerCase(),
      tokenAddress: address.toLowerCase(),
      raw: match,
    };
  }

  async grantValidatorRegistrar(chain: string, address: string, ownerSignature: string): Promise<ValidatorMutation> {
    const response = await this.post('/validator/grant', this.encryptBody({
      chain,
      address,
      owner_signature: ownerSignature,
    }));
    const data = asObject(response.data);
    const txHash = String(data.tx_hash ?? data.txHash ?? '');
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      throw new UpstreamError('Cleanverse', 'Registrar grant succeeded without a valid transaction hash', { retryable: false });
    }
    return {
      chain: String(data.chain ?? chain).toLowerCase(),
      address: String(data.address ?? address).toLowerCase(),
      txHash: txHash.toLowerCase(),
      raw: data,
    };
  }

  async registerValidatorPool(
    chain: string,
    contractAddress: string,
    rule: JsonObject,
    ownerSignature: string,
  ): Promise<ValidatorMutation> {
    const response = await this.post('/validator/register', this.encryptBody({
      chain,
      contract_address: contractAddress,
      rule,
      owner_signature: ownerSignature,
    }));
    const data = asObject(response.data);
    const txHash = String(data.tx_hash ?? data.txHash ?? '');
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      throw new UpstreamError('Cleanverse', 'Pool registration succeeded without a valid transaction hash', { retryable: false });
    }
    return {
      chain: String(data.chain ?? chain).toLowerCase(),
      address: String(data.contract_address ?? data.address ?? contractAddress).toLowerCase(),
      txHash: txHash.toLowerCase(),
      raw: data,
    };
  }
}
