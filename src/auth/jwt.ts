import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";

// Token compatibility with the Spring backend (jjwt 0.12):
//  * key = UTF-8 bytes of JWT_SECRET (Keys.hmacShaKeyFor)
//  * algorithm chosen from key length exactly like jjwt's signWith(SecretKey):
//      >= 64 bytes HS512, >= 48 bytes HS384, otherwise HS256
//  * claims: sub = email, role, iat, exp (+8h)
// Tokens issued by either backend are accepted by the other, so cutover and rollback do not
// force users to log in again.
export type HsAlg = "HS256" | "HS384" | "HS512";

export function algorithmForKey(secret: Buffer): HsAlg {
  if (secret.length >= 64) return "HS512";
  if (secret.length >= 48) return "HS384";
  return "HS256";
}

export interface TokenClaims {
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

export class JwtService {
  private readonly key: Buffer;
  private readonly alg: HsAlg;

  constructor(secret: string, private readonly expirationMs: number) {
    this.key = Buffer.from(secret, "utf8");
    this.alg = algorithmForKey(this.key);
  }

  generateToken(email: string, role: string, nowMs = Date.now()): string {
    const iat = Math.floor(nowMs / 1000);
    return jwt.sign(
      { sub: email, role, iat, exp: Math.floor((nowMs + this.expirationMs) / 1000) },
      this.key,
      { algorithm: this.alg },
    );
  }

  /** Returns claims for a valid, unexpired token signed with our key; otherwise null. */
  verify(token: string): TokenClaims | null {
    try {
      const claims = jwt.verify(token, this.key, { algorithms: ["HS256", "HS384", "HS512"] });
      if (typeof claims !== "object" || typeof claims.sub !== "string" || !claims.sub) return null;
      return claims as TokenClaims;
    } catch {
      return null;
    }
  }
}

export class RefreshTokenService {
  private readonly expiryMs: number;

  constructor(private readonly secret: string, expiryDays: number) {
    this.expiryMs = expiryDays * 24 * 60 * 60 * 1000;
  }

  generateRawToken(): string {
    // 32 random bytes = 64 hex chars
    return randomBytes(32).toString("hex");
  }

  hashToken(raw: string): string {
    return createHash("sha256").update(raw + this.secret).digest("hex");
  }

  expiresAt(): Date {
    return new Date(Date.now() + this.expiryMs);
  }
}
