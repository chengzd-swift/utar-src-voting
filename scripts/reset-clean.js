// scripts/reset-clean.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Returns the system to a clean, first-run state so the whole
//  workflow can be tested from nothing.
//
//      node scripts/reset-clean.js
//
//  What it removes
//    every election, nomination, endorsement, candidate, voter
//    registration, profile change request, roster row, student
//    account, audit entry and Election Committee session.
//
//  What it keeps
//    the three Election Committee accounts, reset to the default
//    password EC123 with a forced change on first sign-in — the
//    same state a freshly installed system would be in.
//
//  Ballots already on the blockchain are not touched, because they
//  cannot be. Redeploy the contract for an empty chain:
//      npx hardhat run scripts/deploy.js --network localhost
//  Do that BEFORE this script, so the fresh contract address is in
//  place when the system starts.
// ─────────────────────────────────────────────────────────────
require("dotenv").config();
const mysql = require("mysql2/promise");

// Child rows first, so foreign keys never block the delete.
const TABLES = [
  "nomination_endorsements",
  "nominations",
  "candidates",
  "voter_registrations",
  "profile_change_requests",
  "elections",
  "student_roster",
  "auth_nonces",
  "ec_sessions",
  "audit_log",
];

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "utar_src_voting",
    multipleStatements: false,
  });

  console.log("🧹 Clearing the database…\n");

  for (const t of TABLES) {
    try {
      const [r] = await db.query(`DELETE FROM \`${t}\``);
      console.log(`   ${String(r.affectedRows).padStart(4)} removed from ${t}`);
    } catch (e) {
      // ec_sessions only exists once the server has booted at least
      // once, and auth_nonces may be absent on an older schema.
      if (e.code === "ER_NO_SUCH_TABLE") console.log(`      – ${t} (not present yet)`);
      else throw e;
    }
  }

  const [stu] = await db.query("DELETE FROM users WHERE role='student'");
  console.log(`   ${String(stu.affectedRows).padStart(4)} removed from users (students)`);

  // Put the committee accounts back to their out-of-the-box state.
  // PENDING_HASH is the marker seedPasswords() looks for on boot, so
  // the server sets them to EC123 the next time it starts.
  const [ec] = await db.query(
    "UPDATE users SET password_hash='PENDING_HASH', must_change_pw=1 WHERE role='election_committee'"
  );
  console.log(`   ${String(ec.affectedRows).padStart(4)} Election Committee accounts reset to the default password`);

  const [[left]] = await db.query("SELECT COUNT(*) n FROM users");
  const [rows] = await db.query("SELECT student_id, full_name FROM users ORDER BY student_id");
  console.log(`\n✅ Clean. ${left.n} account${left.n === 1 ? "" : "s"} remain:`);
  rows.forEach((r) => console.log(`   ${r.student_id}  ${r.full_name}`));

  console.log(`
Next
  1  npx hardhat run scripts/deploy.js --network localhost     (empty chain)
  2  node backend/server.js                                    (sets EC123)
  3  Sign in at /eclogin.html as EC001 · EC123 — you will be
     asked to set a new password straight away.
`);

  await db.end();
}

main().then(() => process.exit(0))
      .catch((e) => { console.error("\n❌ Reset failed:", e.message); process.exit(1); });
