// backend/lib/walletProof.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Proof of wallet ownership.
//
//  Typing an address into a box proves nothing: anyone can type
//  anyone else's address, and a student could hand in an address
//  they do not control. Instead the student signs a short text
//  message with the private key behind the address. The server
//  recovers the signer from the signature and compares it to the
//  address being claimed.
//
//  Signing is off-chain: it costs no gas, moves no funds and
//  authorises no transaction. It is the digital counterpart of
//  producing your student ID card at the DSA counter.
// ─────────────────────────────────────────────────────────────

const { ethers } = require("ethers");   // ethers v6, same as server.js
const crypto = require("crypto");

const NONCE_TTL_MINUTES = 10;

/**
 * Build the exact text a student signs to prove wallet ownership.
 * The student ID is inside the message, so a signature captured
 * from one account cannot be replayed on another.
 */
function walletLinkMessage({ studentId, walletAddress, nonce, issuedAt }) {
  return [
    "UTAR SRC Voting System",
    "Wallet ownership verification",
    "",
    `Student ID : ${studentId}`,
    `Wallet     : ${walletAddress}`,
    `Nonce      : ${nonce}`,
    `Issued     : ${issuedAt}`,
    "",
    "Signing this message proves that you control this wallet.",
    "It costs no gas, transfers nothing and casts no vote.",
  ].join("\n");
}

/**
 * Build the text an endorser signs to confirm that they are
 * proposing, seconding or supporting a nominee (Reg 20).
 */
function endorsementMessage({
  endorserName, endorserStudentId, roleLabel,
  nomineeName, nomineeStudentId, position,
  electionTitle, campus, nonce, issuedAt,
}) {
  return [
    "UTAR SRC Election — Nomination endorsement",
    "",
    `Election  : ${electionTitle} (${campus} Campus)`,
    `Post      : ${position}`,
    `Nominee   : ${nomineeName} (${nomineeStudentId})`,
    "",
    `I, ${endorserName} (${endorserStudentId}), confirm that I am acting as`,
    `${roleLabel} for the nominee named above.`,
    "",
    "I understand that under Regulation XIII Reg 20(3) I may propose,",
    "second or support only one nominee for this post.",
    "",
    `Nonce  : ${nonce}`,
    `Issued : ${issuedAt}`,
  ].join("\n");
}

/**
 * Create and persist a single-use challenge.
 * @returns {{nonce:string, message:string, expiresAt:Date}}
 */
async function issueNonce(db, { purpose, studentId, walletAddress = null, contextId = null, buildMessage }) {
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + NONCE_TTL_MINUTES * 60000);
  const message = buildMessage({ nonce, issuedAt });

  await db.execute(
    `INSERT INTO auth_nonces (nonce, purpose, student_id, wallet_address, context_id, message, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    [nonce, purpose, studentId, walletAddress, contextId, message, expiresAt]
  );

  // Opportunistic cleanup so the table does not grow without bound.
  db.execute("DELETE FROM auth_nonces WHERE expires_at < NOW() - INTERVAL 1 DAY").catch(() => {});

  return { nonce, message, expiresAt };
}

/**
 * Consume a nonce and verify the signature against it.
 *
 * @returns {{ok:true, address:string, message:string} | {ok:false, error:string}}
 */
async function verifySignedNonce(db, { nonce, signature, purpose, studentId, expectedAddress = null }) {
  if (!nonce || !signature) {
    return { ok: false, error: "A signing challenge and a signature are both required" };
  }

  const [rows] = await db.execute("SELECT * FROM auth_nonces WHERE nonce=? AND purpose=?", [nonce, purpose]);
  if (!rows.length) return { ok: false, error: "Signing challenge not recognised. Request a new one." };

  const rec = rows[0];
  if (rec.used_at) return { ok: false, error: "This signing challenge has already been used. Request a new one." };
  if (new Date(rec.expires_at) < new Date())
    return { ok: false, error: "Signing challenge expired. Request a new one." };
  if (String(rec.student_id) !== String(studentId))
    return { ok: false, error: "Signing challenge was issued to a different student" };

  let recovered;
  try {
    recovered = ethers.verifyMessage(rec.message, signature);
  } catch {
    return { ok: false, error: "Signature could not be read. Please sign the message again." };
  }

  const claimed = rec.wallet_address || expectedAddress;
  if (claimed && recovered.toLowerCase() !== String(claimed).toLowerCase()) {
    return {
      ok: false,
      error: "The signature was produced by a different wallet than the one selected in MetaMask",
    };
  }

  // Burn the nonce: one challenge, one use.
  await db.execute("UPDATE auth_nonces SET used_at=NOW() WHERE id=?", [rec.id]);

  return { ok: true, address: ethers.getAddress(recovered), message: rec.message };
}

/** True if the string is a well-formed EVM address. */
function isAddress(value) {
  try {
    ethers.getAddress(value);
    return true;
  } catch {
    return false;
  }
}

/** Checksummed form, or null. */
function toChecksum(value) {
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

module.exports = {
  NONCE_TTL_MINUTES,
  walletLinkMessage,
  endorsementMessage,
  issueNonce,
  verifySignedNonce,
  isAddress,
  toChecksum,
};
