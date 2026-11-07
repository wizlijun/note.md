import { b64, unb64, Claims, LIMITS, fail, id } from './protocol'
const encoder = new TextEncoder()
async function key(secret: string) {
  if (!secret || secret.length < 32) return fail(503, 'service_not_configured')
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}
export async function issueToken(secret: string, spaceId: string, deviceId: string) {
  const claims: Claims = {
    spaceId,
    deviceId,
    exp: Math.floor(Date.now() / 1000) + LIMITS.authSeconds,
    v: 1,
  }
  const payload = b64(encoder.encode(JSON.stringify(claims)))
  return {
    accessToken:
      payload +
      '.' +
      b64(
        new Uint8Array(
          await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload)),
        ),
      ),
    expiresAt: claims.exp,
  }
}
export async function verifyToken(secret: string, authorization: string | null): Promise<Claims> {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 2048)
    return fail(401, 'unauthorized')
  const parts = authorization.slice(7).split('.')
  if (parts.length !== 2) return fail(401, 'unauthorized')
  try {
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await key(secret),
        unb64(parts[1], 64),
        encoder.encode(parts[0]),
      ))
    )
      return fail(401, 'unauthorized')
    const claims = JSON.parse(new TextDecoder().decode(unb64(parts[0], 1000))) as Claims
    if (
      claims.v !== 1 ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= Math.floor(Date.now() / 1000) ||
      claims.exp > Math.floor(Date.now() / 1000) + LIMITS.authSeconds + 5
    )
      return fail(401, 'unauthorized')
    id(claims.spaceId)
    id(claims.deviceId)
    return claims
  } catch {
    return fail(401, 'unauthorized')
  }
}

/** Reject forged space identifiers before routing anonymous refresh/pair requests to a DO. */
export async function sealCredential(
  secret: string,
  spaceId: string,
  kind: 'device' | 'pair',
  nonce: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    encoder.encode(`sumi:credential:${kind}:${spaceId}:${nonce}`),
  )
  return nonce + '.' + b64(new Uint8Array(signature))
}
export async function verifyCredential(
  secret: string,
  spaceId: string,
  kind: 'device' | 'pair',
  value: unknown,
): Promise<boolean> {
  if (typeof value !== 'string' || value.length !== 88) return false
  const [nonce, signature] = value.split('.')
  if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !signature) return false
  try {
    return crypto.subtle.verify(
      'HMAC',
      await key(secret),
      unb64(signature, 32),
      encoder.encode(`sumi:credential:${kind}:${spaceId}:${nonce}`),
    )
  } catch {
    return false
  }
}
