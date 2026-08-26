const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return base64ToBytes(padded);
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

export async function hashPassword(
  password: string,
  salt: string,
  iterations: number,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${password}\u0000${pepper}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64UrlDecode(salt),
      iterations,
    },
    key,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

export async function verifyPassword(
  password: string,
  salt: string,
  iterations: number,
  pepper: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = base64UrlDecode(await hashPassword(password, salt, iterations, pepper));
  const expected = base64UrlDecode(expectedHash);
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function signJson(value: unknown, secret: string): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(value)));
  const signature = base64UrlEncode(await hmac(secret, body));
  return `${body}.${signature}`;
}

export async function verifySignedJson<T>(token: string, secret: string): Promise<T | null> {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) return null;
  const expected = await hmac(secret, body);
  const actual = base64UrlDecode(signature);
  if (
    expected.byteLength !== actual.byteLength ||
    !crypto.subtle.timingSafeEqual(expected, actual)
  ) {
    return null;
  }
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(body))) as T;
  } catch {
    return null;
  }
}
