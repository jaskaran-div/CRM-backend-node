import bcrypt from "bcryptjs";

// BCrypt, compatible with Spring's BCryptPasswordEncoder ($2a$) and the pgcrypto-generated hashes
// already in the database. Argon2 would be stronger but Spring could not verify it, which would
// break rollback; bcrypt stays until the Spring backend is retired.
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash || !/^\$2[aby]\$\d{2}\$/.test(hash)) return false;
  return bcrypt.compare(plain, hash);
}

export async function hashPassword(plain: string, cost: number): Promise<string> {
  // bcryptjs emits $2b$; normalise to $2a$ so Spring's encoder (which accepts both) and any
  // tooling expecting the existing prefix see a consistent format.
  const hash = await bcrypt.hash(plain, cost);
  return hash.replace(/^\$2b\$/, "$2a$");
}

// A real hash of a random string, compared against when the email does not exist so that unknown
// accounts take as long to reject as wrong passwords (no user enumeration by timing).
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(Math.random().toString(36), 10);
  return dummyHash;
}
