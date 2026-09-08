// backend/lib/ecAuth.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Session authentication for the Election Committee routes.
//
//  Until now the EC panel was gated only by a sessionStorage check in
//  the browser, which anybody can set. Every /api/ec/* endpoint was
//  reachable with a bare curl — the whole student roster readable, a
//  fake roster importable, voters registerable — by anyone who could
//  reach the server. On localhost that is invisible; on a real domain
//  it is the whole database.
//
//  A token is issued when an Election Committee member signs in, and
//  every /api/ec/* request must carry it. Tokens live in the database
//  rather than in memory so a server restart does not sign everyone
//  out, and so they can be revoked.
// ─────────────────────────────────────────────────────────────
const crypto = require("crypto");

const SESSION_HOURS = 12;

/** Create the session table once, at boot. */
async function ensureSessionTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ec_sessions (
      token       CHAR(64)    NOT NULL PRIMARY KEY,
      user_id     INT         NOT NULL,
      created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at  DATETIME    NOT NULL,
      ip_address  VARCHAR(45),
      INDEX idx_ec_sessions_expiry (expires_at)
    )`);
}

/** Issue a token for a signed-in Election Committee member. */
async function createSession(db, userId, ip) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  await db.execute(
    "INSERT INTO ec_sessions (token, user_id, expires_at, ip_address) VALUES (?,?,?,?)",
    [token, userId, expires, ip || null]
  );
  // Opportunistic cleanup — no cron needed for a table this small.
  db.execute("DELETE FROM ec_sessions WHERE expires_at < NOW()").catch(() => {});
  return { token, expiresAt: expires };
}

async function destroySession(db, token) {
  if (token) await db.execute("DELETE FROM ec_sessions WHERE token=?", [token]);
}

function bearer(req) {
  const h = req.get("authorization") || "";
  const m = h.match(/^Bearer\s+([A-Fa-f0-9]{64})$/);
  return m ? m[1] : null;
}

/**
 * Express middleware guarding the Election Committee API.
 * Mount it on the /api/ec prefix, before the routes themselves.
 */
function requireEC(db) {
  return async function (req, res, next) {
    const token = bearer(req);
    if (!token)
      return res.status(401).json({ error: "Election Committee sign-in required", code: "EC_AUTH_REQUIRED" });
    try {
      const [rows] = await db.execute(
        `SELECT s.user_id, u.role, u.full_name, u.student_id, u.is_active
           FROM ec_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token=? AND s.expires_at > NOW()`,
        [token]
      );
      if (!rows.length)
        return res.status(401).json({ error: "Your session has expired. Please sign in again.", code: "EC_AUTH_EXPIRED" });

      const session = rows[0];
      // The role is re-read on every request rather than trusted from
      // the token, so revoking an account takes effect immediately.
      if (session.role !== "election_committee" || !session.is_active)
        return res.status(403).json({ error: "This account is not an active Election Committee member", code: "EC_AUTH_FORBIDDEN" });

      req.ec = { userId: session.user_id, staffId: session.student_id, name: session.full_name };
      next();
    } catch (err) {
      console.error("EC auth check failed:", err.message);
      res.status(500).json({ error: "Could not verify your session" });
    }
  };
}

module.exports = { ensureSessionTable, createSession, destroySession, requireEC, bearer };
