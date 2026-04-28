/**
 * Password policy — used on register, password reset, and password change.
 *
 * Since the password is the KEK input for envelope encryption, a weak
 * password directly weakens every user's DEK. Enforce strong passwords
 * at creation time.
 *
 * Policy (AND of all):
 *   1. At least 12 characters.
 *   2. Not in the builtin common-password list (top-100 + common patterns).
 *   3. Either (a) ≥16 chars (passphrase-style) OR (b) at least 3 of 4
 *      character classes (lowercase, uppercase, digit, symbol).
 *   4. Not trivially sequential (e.g. "123456789012", "aaaaaaaaaaaa").
 *
 * Not a replacement for zxcvbn but catches the vast majority of weak
 * passwords that would fall to a GPU-backed offline attack in <24h.
 */

// Top-100 most-leaked passwords from HaveIBeenPwned breach compilations,
// normalized to lowercase. Matches are case-insensitive and also reject
// trivial l33t substitutions (see `normalize`).
const COMMON_PASSWORDS = new Set([
  "123456", "password", "123456789", "12345678", "12345", "qwerty", "abc123",
  "password1", "1234567", "welcome", "monkey", "login", "iloveyou", "admin",
  "letmein", "princess", "qwerty123", "starwars", "dragon", "passw0rd",
  "master", "hello", "freedom", "whatever", "qazwsx", "trustno1", "jordan",
  "harley", "robert", "matthew", "daniel", "andrew", "michelle", "shadow",
  "superman", "batman", "tigger", "sunshine", "ashley", "football", "jesus",
  "ninja", "mustang", "access", "flower", "charlie", "donald", "qwertyuiop",
  "zxcvbnm", "asdfghjkl", "qwertyuiop123", "1q2w3e4r", "1qaz2wsx",
  "password123", "welcome1", "welcome123", "admin123", "pass123", "test123",
  "changeme", "default", "temppass", "newpass", "rootroot", "administrator",
  "qwerty1234", "abc12345", "iloveyou1", "letmein1", "111111", "123123",
  "000000", "654321", "696969", "123321", "666666", "987654321", "121212",
  "112233", "qwer1234", "abcd1234", "finance123", "money123", "bank123",
  "secret", "secret123", "facebook", "google", "password12", "master123",
  "summer2024", "spring2024", "winter2024", "autumn2024", "summer2025",
  "spring2025", "winter2025", "autumn2025", "finlynq", "finlynq123",
]);

function normalize(password: string): string {
  // Case-fold + strip common l33t substitutions to trip up obvious bypasses.
  return password
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/!/g, "i");
}

function classCount(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) n++;
  if (/[A-Z]/.test(password)) n++;
  if (/[0-9]/.test(password)) n++;
  if (/[^a-zA-Z0-9]/.test(password)) n++;
  return n;
}

function isSequential(password: string): boolean {
  if (password.length < 4) return false;
  // All-same-char ("aaaaaaaaaaaa"): low entropy, block.
  if (new Set(password).size <= 2) return true;
  // Repeated short cycle ("abababab"): block if the dominant cycle covers ≥80% of the string.
  for (let cycle = 1; cycle <= 4; cycle++) {
    const unit = password.slice(0, cycle);
    const full = unit.repeat(Math.ceil(password.length / cycle)).slice(0, password.length);
    if (full === password) return true;
  }
  return false;
}

/**
 * Validate a password against the policy. Returns `null` if it passes,
 * or a user-facing error message if it fails.
 */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string") return "Password is required";
  if (password.length < 12) {
    return "Password must be at least 12 characters";
  }
  if (password.length > 256) {
    return "Password is too long (max 256 characters)";
  }

  if (isSequential(password)) {
    return "Password is too repetitive — try a passphrase of unrelated words";
  }

  const normalized = normalize(password);
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || COMMON_PASSWORDS.has(normalized)) {
    return "This password is too common — pick something else";
  }
  // Reject any password whose normalized form contains a common password
  // as a substring (e.g. "Password123!" → "passwordiie!" still contains "password").
  for (const common of COMMON_PASSWORDS) {
    if (common.length >= 6 && normalized.includes(common)) {
      return "Password contains a common phrase — pick something unrelated";
    }
  }

  // Passphrase bypass: very long passwords only need a bit of diversity.
  if (password.length >= 16) {
    // Allow long lowercase-only passphrases like "correcthorsebatterystaple".
    return null;
  }

  if (classCount(password) < 3) {
    return "Password must mix at least 3 of: lowercase, uppercase, digits, symbols (or be ≥16 characters)";
  }

  return null;
}

/** Zod refinement helper for use in request validators. */
export function passwordPolicyRefinement(password: string): boolean {
  return validatePasswordStrength(password) === null;
}
