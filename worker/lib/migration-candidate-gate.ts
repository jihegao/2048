import { sha256, verifySignedJson } from './crypto';
import { migrationBinding } from './migration';

const AUTHORIZATION_HEADER = 'X-2048-Migration-Authorization';
const MAX_BODY_BYTES = 64 * 1024;
const AUTHENTICATION_DOMAIN = '2048-closed-candidate-auth-v1\u0000';
interface CandidateRequest {
  purpose: '2048-closed-candidate-v1';
  audience: '2048-new-production';
  versionId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  method: string;
  url: string;
  bodyDigest: string;
}

// This authorizes only one exact, short-lived operator request. Ordinary clients
// never reach application middleware, assets, D1, or a Durable Object.
export async function authorizedCandidateRequest(
  request: Request,
  env: Env,
): Promise<Request | null> {
  if (
    migrationBinding(env, 'MIGRATION_CANDIDATE_ENABLED') !== 'true' ||
    migrationBinding(env, 'MIGRATION_AUDIENCE') !== '2048-new-production'
  )
    return null;
  const token = request.headers.get(AUTHORIZATION_HEADER);
  if (!token || token.length > 12000) return null;
  const key = migrationBinding(env, 'IMPORT_SIGNING_KEY');
  const metadata = migrationBinding(env, 'CF_VERSION_METADATA') as { id?: string } | undefined;
  if (typeof key !== 'string' || !key || !metadata?.id) return null;
  let proof: CandidateRequest | null;
  try {
    proof = await verifySignedJson<CandidateRequest>(token, AUTHENTICATION_DOMAIN + key);
  } catch {
    return null;
  }
  const now = Date.now();
  if (
    !proof ||
    proof.purpose !== '2048-closed-candidate-v1' ||
    proof.audience !== '2048-new-production' ||
    proof.versionId !== metadata.id ||
    typeof proof.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{22,64}$/u.test(proof.nonce) ||
    !Number.isSafeInteger(proof.issuedAt) ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.issuedAt > now + 5000 ||
    proof.expiresAt <= now ||
    proof.expiresAt <= proof.issuedAt ||
    proof.expiresAt - proof.issuedAt > 60000 ||
    proof.method !== request.method ||
    proof.url !== request.url ||
    typeof proof.bodyDigest !== 'string'
  )
    return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.clone().body?.getReader();
  if (reader) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Both tee branches must be cancelled; awaiting only the clone would
        // wait forever for the unconsumed original branch.
        void Promise.allSettled([reader.cancel(), request.body?.cancel()]);
        return null;
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if ((await sha256(bytes)) !== proof.bodyDigest) return null;
  const headers = new Headers(request.headers);
  headers.delete(AUTHORIZATION_HEADER);
  return new Request(request, { headers });
}
