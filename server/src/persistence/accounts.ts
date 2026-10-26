import { db } from "./core.ts";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
  github_id?: string | null;
  google_id?: string | null;
  proxy_url?: string | null;
  jump_server?: string | null;
  os_uid?: number | null;
  password_changed_at?: number | null;
  email_verified?: number | null;
  verify_token?: string | null;
  verify_expires?: number | null;
  verify_code_hash?: string | null;
  verify_attempts?: number | null;
  verify_locked_until?: number | null;
  verify_sent_at?: number | null;
  banned_at?: number | null;
  ban_reason?: string | null;
  canonical_email?: string | null;
  reset_code_hash?: string | null;
  reset_expires?: number | null;
  reset_attempts?: number | null;
  reset_locked_until?: number | null;
  reset_sent_at?: number | null;
}

export interface ResetState {
  id: string;
  email: string;
  has_password: boolean;
  github_id: string | null;
  google_id: string | null;
  reset_code_hash: string | null;
  reset_expires: number | null;
  reset_attempts: number | null;
  reset_locked_until: number | null;
  reset_sent_at: number | null;
}

const SANDBOX_UID_BASE = 40000;

export const userDao = {
  create(u: UserRow): void {
    db.prepare(
      "INSERT INTO users (id, email, password_hash, created_at, github_id, google_id, canonical_email, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      u.id,
      u.email,
      u.password_hash,
      u.created_at,
      u.github_id ?? null,
      u.google_id ?? null,
      u.canonical_email ?? null,
      u.email_verified ?? null,
    );
  },
  byEmail(email: string): UserRow | undefined {
    return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  },
  byCanonicalEmail(canonical: string): UserRow | undefined {
    return db.prepare("SELECT * FROM users WHERE canonical_email = ?").get(canonical) as UserRow | undefined;
  },
  byId(id: string): UserRow | undefined {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  },
  byGithubId(githubId: string): UserRow | undefined {
    return db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as UserRow | undefined;
  },
  byGoogleId(googleId: string): UserRow | undefined {
    return db.prepare("SELECT * FROM users WHERE google_id = ?").get(googleId) as UserRow | undefined;
  },
  linkGithub(id: string, githubId: string): void {
    db.prepare("UPDATE users SET github_id = ? WHERE id = ?").run(githubId, id);
  },
  linkGoogle(id: string, googleId: string): void {
    db.prepare("UPDATE users SET google_id = ? WHERE id = ?").run(googleId, id);
  },
  reserveVerificationSend(email: string, reservedAt: number, previousAtOrBefore: number): { id: string; email: string } | undefined {
    return db.prepare(
      "UPDATE users SET verify_sent_at = ? " +
        "WHERE email = ? AND email_verified = 0 " +
        "AND (verify_sent_at IS NULL OR verify_sent_at <= ?) " +
        "RETURNING id, email",
    ).get(reservedAt, email, previousAtOrBefore) as { id: string; email: string } | undefined;
  },
  commitVerificationPair(
    id: string,
    reservedAt: number,
    tokenHash: string,
    codeHash: string,
    expires: number,
  ): number {
    return Number(db.prepare(
      "UPDATE users SET verify_token = ?, verify_code_hash = ?, verify_expires = ?, " +
        "verify_attempts = 0, verify_locked_until = NULL " +
        "WHERE id = ? AND email_verified = 0 AND verify_sent_at = ?",
    ).run(tokenHash, codeHash, expires, id, reservedAt).changes);
  },
  markVerified(id: string): void {
    db.prepare(
      "UPDATE users SET email_verified = 1, verify_token = NULL, verify_code_hash = NULL, verify_expires = NULL, verify_attempts = 0, verify_locked_until = NULL, verify_sent_at = NULL WHERE id = ?",
    ).run(id);
  },
  claimPendingVerification(id: string): number {
    return Number(
      db.prepare(
        "UPDATE users SET email_verified = 1, verify_token = NULL, verify_code_hash = NULL, verify_expires = NULL, verify_attempts = 0, verify_locked_until = NULL, verify_sent_at = NULL WHERE id = ? AND email_verified = 0",
      ).run(id).changes,
    );
  },
  verifyByToken(tokenHash: string, now: number): string | null {
    const row = db.prepare("SELECT id, email FROM users WHERE verify_token = ? AND verify_expires > ?").get(tokenHash, now) as { id: string; email: string } | undefined;
    if (!row) return null;
    return this.claimPendingVerification(row.id) === 1 ? row.email : null;
  },
  verifyStateByEmail(email: string): { id: string; email_verified: number | null; verify_code_hash: string | null; verify_expires: number | null; verify_attempts: number | null; verify_locked_until: number | null; verify_sent_at: number | null } | undefined {
    return db.prepare(
      "SELECT id, email_verified, verify_code_hash, verify_expires, verify_attempts, verify_locked_until, verify_sent_at FROM users WHERE email = ?",
    ).get(email) as { id: string; email_verified: number | null; verify_code_hash: string | null; verify_expires: number | null; verify_attempts: number | null; verify_locked_until: number | null; verify_sent_at: number | null } | undefined;
  },
  bumpVerifyAttempt(id: string, now: number, lockUntil: number, max: number): number {
    const row = db.prepare(
      "UPDATE users SET " +
        "verify_attempts = CASE WHEN verify_locked_until IS NOT NULL AND verify_locked_until <= ? THEN 1 ELSE COALESCE(verify_attempts, 0) + 1 END, " +
        "verify_locked_until = CASE " +
        "WHEN verify_locked_until IS NOT NULL AND verify_locked_until <= ? THEN NULL " +
        "WHEN COALESCE(verify_attempts, 0) + 1 >= ? THEN ? ELSE verify_locked_until END " +
        "WHERE id = ? AND email_verified = 0 RETURNING verify_attempts",
    ).get(now, now, max, lockUntil, id) as { verify_attempts: number } | undefined;
    return row ? Number(row.verify_attempts) : max + 1;
  },
  emailVerifiedState(id: string): number | null {
    const row = db.prepare("SELECT email_verified FROM users WHERE id = ?").get(id) as { email_verified: number | null } | undefined;
    return row ? row.email_verified : 1;
  },
  authEpochMatches(id: string, expected: number): boolean {
    return Boolean(db.prepare(
      "SELECT 1 AS ok FROM users WHERE id = ? AND COALESCE(password_changed_at, 0) = ? LIMIT 1",
    ).get(id, expected));
  },
  resetStateByEmail(email: string): ResetState | undefined {
    const row = db.prepare(
      "SELECT id, email, (password_hash IS NOT NULL AND password_hash <> '') AS has_password, " +
        "github_id, google_id, reset_code_hash, reset_expires, reset_attempts, reset_locked_until, reset_sent_at " +
        "FROM users WHERE email = ?",
    ).get(email) as (Omit<ResetState, "has_password"> & { has_password: number }) | undefined;
    return row ? { ...row, has_password: row.has_password === 1 } : undefined;
  },
  reserveResetSend(email: string, reservedAt: number, previousAtOrBefore: number): { id: string; email: string } | undefined {
    return db.prepare(
      "UPDATE users SET reset_sent_at = ? " +
        "WHERE email = ? AND (reset_sent_at IS NULL OR reset_sent_at <= ?) " +
        "RETURNING id, email",
    ).get(reservedAt, email, previousAtOrBefore) as { id: string; email: string } | undefined;
  },
  commitResetCode(id: string, reservedAt: number, codeHash: string, expires: number): number {
    return Number(db.prepare(
      "UPDATE users SET reset_code_hash = ?, reset_expires = ?, reset_attempts = 0, reset_locked_until = NULL " +
        "WHERE id = ? AND reset_sent_at = ?",
    ).run(codeHash, expires, id, reservedAt).changes);
  },
  bumpResetAttempt(id: string, now: number, lockUntil: number, max: number): number {
    const row = db.prepare(
      "UPDATE users SET " +
        "reset_attempts = CASE WHEN reset_locked_until IS NOT NULL AND reset_locked_until <= ? THEN 1 ELSE COALESCE(reset_attempts, 0) + 1 END, " +
        "reset_locked_until = CASE " +
        "WHEN reset_locked_until IS NOT NULL AND reset_locked_until <= ? THEN NULL " +
        "WHEN COALESCE(reset_attempts, 0) + 1 >= ? THEN ? ELSE reset_locked_until END " +
        "WHERE id = ? AND reset_code_hash IS NOT NULL RETURNING reset_attempts",
    ).get(now, now, max, lockUntil, id) as { reset_attempts: number } | undefined;
    return row ? Number(row.reset_attempts) : max + 1;
  },
  completeReset(id: string, expectCodeHash: string, passwordHash: string, changedAt: number): boolean {
    return db.prepare(
      "UPDATE users SET password_hash = ?, password_changed_at = ?, email_verified = 1, " +
        "verify_token = NULL, verify_code_hash = NULL, verify_expires = NULL, verify_attempts = 0, verify_locked_until = NULL, verify_sent_at = NULL, " +
        "reset_code_hash = NULL, reset_expires = NULL, reset_attempts = 0, reset_locked_until = NULL, reset_sent_at = NULL " +
        "WHERE id = ? AND reset_code_hash = ?",
    ).run(passwordHash, changedAt, id, expectCodeHash).changes === 1;
  },
  ban(id: string, reason: string | null): string | null {
    const row = db.prepare("SELECT email, password_changed_at FROM users WHERE id = ?").get(id) as
      | { email: string; password_changed_at: number | null }
      | undefined;
    if (!row) return null;
    const stamp = Math.max(Date.now(), (row.password_changed_at ?? 0) + 1);
    db.prepare("UPDATE users SET banned_at = ?, ban_reason = ?, password_changed_at = ? WHERE id = ?").run(
      Date.now(),
      reason || null,
      stamp,
      id,
    );
    return row.email;
  },
  unban(id: string): void {
    db.prepare("UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?").run(id);
  },
  banInfo(id: string): { bannedAt: number; reason: string | null } | null {
    const row = db.prepare("SELECT banned_at, ban_reason FROM users WHERE id = ?").get(id) as
      | { banned_at: number | null; ban_reason: string | null }
      | undefined;
    if (!row || row.banned_at == null) return null;
    return { bannedAt: row.banned_at, reason: row.ban_reason };
  },
  updatePassword(id: string, passwordHash: string, changedAt: number, expect?: { passwordHash: string; pwc: number }): boolean {
    if (expect) {
      const r = db
        .prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ? AND password_hash = ? AND COALESCE(password_changed_at, 0) = ?")
        .run(passwordHash, changedAt, id, expect.passwordHash, expect.pwc);
      return r.changes === 1;
    }
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(passwordHash, changedAt, id);
    return true;
  },
  setEgress(id: string, proxyUrl: string | null, jumpServer: string | null): void {
    db.prepare("UPDATE users SET proxy_url = ?, jump_server = ? WHERE id = ?").run(
      proxyUrl || null,
      jumpServer || null,
      id,
    );
  },
  sandboxUid(id: string): number {
    const row = db.prepare("SELECT os_uid FROM users WHERE id = ?").get(id) as { os_uid?: number | null } | undefined;
    if (row?.os_uid) return row.os_uid;
    const max = (db.prepare("SELECT MAX(os_uid) AS m FROM users").get() as { m: number | null }).m;
    const next = Math.max(SANDBOX_UID_BASE, (max ?? SANDBOX_UID_BASE - 1) + 1);
    db.prepare("UPDATE users SET os_uid = ? WHERE id = ?").run(next, id);
    return next;
  },
};

export interface ProviderKeyRow {
  user_id: string;
  provider: string;
  enc_key: string;
  hint: string;
  updated_at: number;
}

export const keyDao = {
  upsert(row: ProviderKeyRow): void {
    db.prepare(
      `INSERT INTO provider_keys (user_id, provider, enc_key, hint, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET enc_key=excluded.enc_key, hint=excluded.hint, updated_at=excluded.updated_at`,
    ).run(row.user_id, row.provider, row.enc_key, row.hint, row.updated_at);
  },
  get(userId: string, provider: string): ProviderKeyRow | undefined {
    return db
      .prepare("SELECT * FROM provider_keys WHERE user_id = ? AND provider = ?")
      .get(userId, provider) as ProviderKeyRow | undefined;
  },
  list(userId: string): ProviderKeyRow[] {
    return db.prepare("SELECT * FROM provider_keys WHERE user_id = ?").all(userId) as unknown as ProviderKeyRow[];
  },
  delete(userId: string, provider: string): void {
    db.prepare("DELETE FROM provider_keys WHERE user_id = ? AND provider = ?").run(userId, provider);
  },
};

export interface OrcaCredentialRow {
  user_id: string;
  source: string;
  scope: string | null;
  generation: number;
  needs_reauth: number;
  updated_at: number;
}

/**
 * Credential metadata for the OrcaRouter provider: which adapter produced the stored
 * key, its generation, and whether a relay 401 marked it for reauthentication. The
 * secret itself stays in `provider_keys`.
 */
export const orcaCredentialDao = {
  get(userId: string): OrcaCredentialRow | undefined {
    return db
      .prepare("SELECT * FROM orca_credentials WHERE user_id = ?")
      .get(userId) as OrcaCredentialRow | undefined;
  },
  rotate(userId: string, source: string, scope: string | null): number {
    const current = orcaCredentialDao.get(userId);
    const generation = (current?.generation ?? 0) + 1;
    db.prepare(
      `INSERT INTO orca_credentials (user_id, source, scope, generation, needs_reauth, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET source=excluded.source, scope=excluded.scope,
         generation=excluded.generation, needs_reauth=0, updated_at=excluded.updated_at`,
    ).run(userId, source, scope, generation, Date.now());
    return generation;
  },
  markNeedsReauth(userId: string, generation: number): boolean {
    // Only the exact rejected generation flips: a late failure from an old request
    // must never poison a credential that was just reauthorized.
    const out = db
      .prepare("UPDATE orca_credentials SET needs_reauth = 1 WHERE user_id = ? AND generation = ?")
      .run(userId, generation);
    return Number(out.changes) > 0;
  },
  clear(userId: string): void {
    db.prepare("DELETE FROM orca_credentials WHERE user_id = ?").run(userId);
  },
};

export interface SshTargetRow {
  id: string;
  user_id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  enc_key: string;
  host_fp: string | null;
  key_protected: number;
  created_at: number;
  unconfined?: number;
}

export const sshTargetDao = {
  create(row: SshTargetRow): void {
    db.prepare(
      `INSERT INTO ssh_targets (id, user_id, label, host, port, username, enc_key, host_fp, key_protected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.user_id, row.label, row.host, row.port, row.username, row.enc_key, row.host_fp, row.key_protected, row.created_at);
  },
  listForUser(userId: string): SshTargetRow[] {
    return db
      .prepare("SELECT * FROM ssh_targets WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as unknown as SshTargetRow[];
  },
  byId(userId: string, id: string): SshTargetRow | undefined {
    return db.prepare("SELECT * FROM ssh_targets WHERE id = ? AND user_id = ?").get(id, userId) as SshTargetRow | undefined;
  },
  setFingerprint(id: string, fp: string): void {
    db.prepare("UPDATE ssh_targets SET host_fp = ? WHERE id = ?").run(fp, id);
  },
  setUnconfined(userId: string, id: string, on: boolean): void {
    db.prepare("UPDATE ssh_targets SET unconfined = ? WHERE id = ? AND user_id = ?").run(on ? 1 : 0, id, userId);
  },
  delete(userId: string, id: string): void {
    db.prepare("DELETE FROM ssh_targets WHERE id = ? AND user_id = ?").run(id, userId);
  },
};

export interface WebauthnCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  label: string;
  transports: string | null;
  created_at: number;
}

export const webauthnCredentialDao = {
  create(row: WebauthnCredentialRow): void {
    db.prepare(
      `INSERT INTO webauthn_credentials (id, user_id, credential_id, label, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.user_id, row.credential_id, row.label, row.transports, row.created_at);
  },
  listForUser(userId: string): WebauthnCredentialRow[] {
    return db
      .prepare("SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as unknown as WebauthnCredentialRow[];
  },
  delete(userId: string, id: string): void {
    db.prepare("DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?").run(id, userId);
  },
};

export interface ConnectorRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  workspace_root: string;
  capabilities_json: string;
  last_seen_at: number | null;
  created_at: number;
  unconfined?: number;
}

export const connectorDao = {
  create(row: ConnectorRow): void {
    db.prepare(
      `INSERT INTO connectors (id, user_id, name, token_hash, workspace_root, capabilities_json, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.user_id,
      row.name,
      row.token_hash,
      row.workspace_root,
      row.capabilities_json,
      row.last_seen_at,
      row.created_at,
    );
  },
  listForUser(userId: string): ConnectorRow[] {
    return db
      .prepare("SELECT * FROM connectors WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as unknown as ConnectorRow[];
  },
  byId(userId: string, id: string): ConnectorRow | undefined {
    return db.prepare("SELECT * FROM connectors WHERE id = ? AND user_id = ?").get(id, userId) as
      | ConnectorRow
      | undefined;
  },
  byTokenHash(tokenHash: string): ConnectorRow | undefined {
    return db.prepare("SELECT * FROM connectors WHERE token_hash = ?").get(tokenHash) as ConnectorRow | undefined;
  },
  setLastSeen(id: string, ts: number): void {
    db.prepare("UPDATE connectors SET last_seen_at = ? WHERE id = ?").run(ts, id);
  },
  setUnconfined(userId: string, id: string, unconfined: boolean): void {
    db.prepare("UPDATE connectors SET unconfined = ? WHERE id = ? AND user_id = ?").run(unconfined ? 1 : 0, id, userId);
  },
  delete(userId: string, id: string): void {
    db.prepare("DELETE FROM connectors WHERE id = ? AND user_id = ?").run(id, userId);
  },
};

export interface ConnectorPairingRow {
  id: string;
  user_id: string;
  name: string;
  workspace_root: string;
  code_hash: string;
  expires_at: number;
  redeemed_at: number | null;
  connector_id: string | null;
  created_at: number;
}

export const connectorPairingDao = {
  create(row: ConnectorPairingRow): void {
    db.prepare(
      `INSERT INTO connector_pairings (id, user_id, name, workspace_root, code_hash, expires_at, redeemed_at, connector_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.user_id,
      row.name,
      row.workspace_root,
      row.code_hash,
      row.expires_at,
      row.redeemed_at,
      row.connector_id,
      row.created_at,
    );
  },
  byCodeHash(codeHash: string): ConnectorPairingRow | undefined {
    return db.prepare("SELECT * FROM connector_pairings WHERE code_hash = ?").get(codeHash) as
      | ConnectorPairingRow
      | undefined;
  },
  markRedeemed(id: string, connectorId: string, redeemedAt: number): void {
    db.prepare("UPDATE connector_pairings SET redeemed_at = ?, connector_id = ? WHERE id = ?").run(
      redeemedAt,
      connectorId,
      id,
    );
  },
  deleteExpired(now: number): void {
    db.prepare("DELETE FROM connector_pairings WHERE expires_at < ? AND redeemed_at IS NULL").run(now);
  },
};
