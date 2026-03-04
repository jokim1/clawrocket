import crypto from 'crypto';

export function hashOpaqueToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashRequestBody(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
