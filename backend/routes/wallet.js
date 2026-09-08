// backend/routes/wallet.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Moderator issue 1: "Cannot key in wallet addresses one by one
//  — what if I have 1000 students?"
//
//  Two separate bottlenecks were hiding inside that question:
//
//    a) Collecting the addresses. Solved by having the student
//       link and prove their own wallet during registration, so
//       the EC never types an address at all.
//
//    b) Putting the addresses on chain. Solved by queueing every
//       eligible voter and sending them to the existing
//       registerVotersBatch() in SRCVoting.sol in chunks — one
//       EC click covers the whole campus.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { describeContractError } = require("../lib/contractError");
const {
  walletLinkMessage, issueNonce, verifySignedNonce, isAddress, toChecksum,
} = require("../lib/walletProof");
const { checkVoterEligibility, normaliseRoster } = require("../lib/eligibility");

// Addresses per transaction. Each new voter costs roughly 25k–30k
// gas (one storage slot plus an event), so 100 sits comfortably
// inside Ganache's default 6,721,975 block gas limit with room to
// spare. Override per call if the target chain allows more.
const DEFAULT_CHUNK = 100;
const MAX_CHUNK = 250;

module.exports = function walletRoutes({ db, getContract, logAudit }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════
  //  STUDENT — prove and link a wallet
  // ═══════════════════════════════════════════════════════════

  // Step 1: ask the server for something to sign.
  // POST /api/wallet/nonce  { student_id, wallet_address }
  router.post("/wallet/nonce", async (req, res) => {
    const { student_id, wallet_address } = req.body;
    if (!student_id || !wallet_address)
      return res.status(400).json({ error: "Student ID and wallet address are both required" });
    if (!isAddress(wallet_address))
      return res.status(400).json({ error: "That is not a valid Ethereum address" });

    const address = toChecksum(wallet_address);

    try {
      // Refuse early if the wallet already belongs to somebody else,
      // rather than letting the student sign and then fail.
      const [taken] = await db.execute(
        "SELECT student_id FROM users WHERE wallet_address=? AND student_id<>?",
        [address, student_id]
      );
      if (taken.length)
        return res.status(409).json({
          error: "This wallet is already linked to another student account. Select a different account in MetaMask.",
        });

      const { nonce, message, expiresAt } = await issueNonce(db, {
        purpose: "wallet_link",
        studentId: student_id,
        walletAddress: address,
        buildMessage: ({ nonce, issuedAt }) =>
          walletLinkMessage({ studentId: student_id, walletAddress: address, nonce, issuedAt }),
      });

      res.json({ success: true, nonce, message, expiresAt });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not start wallet verification" });
    }
  });

  // Step 2: hand back the signature. Used when re-linking from the
  // profile page; registration verifies inline (see accounts.js).
  // POST /api/wallet/link  { student_id, wallet_address, nonce, signature }
  router.post("/wallet/link", async (req, res) => {
    const { student_id, wallet_address, nonce, signature } = req.body;
    if (!student_id || !wallet_address)
      return res.status(400).json({ error: "Student ID and wallet address are both required" });

    try {
      const [uRows] = await db.execute(
        "SELECT id, wallet_address FROM users WHERE student_id=? AND role='student'",
        [student_id]
      );
      if (!uRows.length) return res.status(404).json({ error: "Student account not found" });
      const user = uRows[0];

      // A wallet is the key to a ballot. Once it is written on chain
      // for a live election it cannot be swapped, or the old address
      // would keep its right to vote alongside the new one.
      const [locked] = await db.execute(
        `SELECT e.title FROM voter_registrations vr
           JOIN elections e ON vr.election_id = e.id
          WHERE vr.user_id=? AND vr.status='registered' AND e.status IN ('active','nomination','setup')`,
        [user.id]
      );
      if (locked.length)
        return res.status(403).json({
          error: `Your wallet is already registered on the blockchain for "${locked[0].title}". Ask the Election Committee to release it before changing wallets.`,
        });

      const verdict = await verifySignedNonce(db, {
        nonce, signature, purpose: "wallet_link", studentId: student_id,
        expectedAddress: wallet_address,
      });
      if (!verdict.ok) return res.status(400).json({ error: verdict.error });

      const [taken] = await db.execute(
        "SELECT student_id FROM users WHERE wallet_address=? AND id<>?", [verdict.address, user.id]
      );
      if (taken.length)
        return res.status(409).json({ error: "This wallet is already linked to another student account" });

      await db.execute(
        "UPDATE users SET wallet_address=?, wallet_verified_at=NOW(), wallet_proof_sig=? WHERE id=?",
        [verdict.address, signature, user.id]
      );

      // Any queued (not yet on-chain) registration should point at
      // the new address.
      await db.execute(
        "UPDATE voter_registrations SET wallet_address=? WHERE user_id=? AND status='queued'",
        [verdict.address, user.id]
      );

      await logAudit(user.id, "student", null, "WALLET_VERIFIED",
        `${student_id} proved ownership of ${verdict.address}`, req.ip);

      res.json({ success: true, message: "Wallet verified and linked", wallet_address: verdict.address });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not link wallet" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  EC — bulk on-chain voter registration
  // ═══════════════════════════════════════════════════════════

  // How much work is outstanding for this election?
  // GET /api/ec/elections/:electionId/voters/status
  router.get("/ec/elections/:electionId/voters/status", async (req, res) => {
    const { electionId } = req.params;
    try {
      const [[election]] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
      if (!election) return res.status(404).json({ error: "Election not found" });

      const [counts] = await db.execute(
        `SELECT status, COUNT(*) AS n FROM voter_registrations WHERE election_id=? GROUP BY status`,
        [electionId]
      );
      const summary = { queued: 0, registered: 0, failed: 0, superseded: 0 };
      counts.forEach((r) => { summary[r.status] = Number(r.n); });

      // Approved students on this campus who still have no verified wallet.
      const [[unlinked]] = await db.execute(
        `SELECT COUNT(*) AS n FROM users
          WHERE role='student' AND is_approved=1 AND campus=?
            AND (wallet_address IS NULL OR wallet_verified_at IS NULL)`,
        [election.campus]
      );

      const [[eligible]] = await db.execute(
        `SELECT COUNT(*) AS n FROM users
          WHERE role='student' AND is_approved=1 AND campus=? AND wallet_verified_at IS NOT NULL`,
        [election.campus]
      );

      res.json({
        success: true,
        campus: election.campus,
        summary,
        eligible_with_wallet: Number(eligible.n),
        approved_without_wallet: Number(unlinked.n),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not read voter registration status" });
    }
  });

  // Queue every eligible student on this campus.
  // POST /api/ec/elections/:electionId/voters/queue
  router.post("/ec/elections/:electionId/voters/queue", async (req, res) => {
    const { electionId } = req.params;
    try {
      const [[election]] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
      if (!election) return res.status(404).json({ error: "Election not found" });
      if (election.status === "ended")
        return res.status(403).json({ error: "This election has already closed" });

      // Reg 14(1): registered full-time foundation, undergraduate and
      // postgraduate students of the same campus, minus anyone on
      // leave of absence or on a Distance Learning / External
      // programme. The roster is the source of truth; students with
      // no roster row are left out and reported.
      // Every column is aliased explicitly. A bare `r.*` on a LEFT
      // JOIN would let the roster's own id and student_id overwrite
      // the user's, and silently blank them out when there is no
      // roster row to join to.
      const [candidates] = await db.execute(
        `SELECT u.id            AS user_id,
                u.student_id    AS student_code,
                u.wallet_address,
                r.id            AS roster_id,
                r.is_enrolled, r.on_leave, r.delivery_mode
           FROM users u
           LEFT JOIN student_roster r ON r.student_id = u.student_id
          WHERE u.role='student' AND u.is_approved=1 AND u.is_active=1
            AND u.campus=? AND u.wallet_verified_at IS NOT NULL`,
        [election.campus]
      );

      let queued = 0;
      const skipped = [];

      for (const row of candidates) {
        const roster = row.roster_id ? normaliseRoster(row) : null;
        const verdict = checkVoterEligibility(roster);
        if (!verdict.eligible) {
          skipped.push({ student_id: row.student_code, reasons: verdict.reasons });
          continue;
        }
        await db.execute(
          `INSERT INTO voter_registrations (election_id, user_id, wallet_address, status)
           VALUES (?,?,?, 'queued')
           ON DUPLICATE KEY UPDATE
             wallet_address = IF(status='registered', wallet_address, VALUES(wallet_address)),
             status         = IF(status='registered', 'registered', 'queued')`,
          [electionId, row.user_id, row.wallet_address]
        );
        queued++;
      }

      await logAudit(null, "election_committee", electionId, "VOTERS_QUEUED",
        `Queued ${queued} ${election.campus} voters; ${skipped.length} skipped`, req.ip);

      res.json({
        success: true,
        message: `${queued} voters queued for ${election.campus} Campus`,
        queued,
        skipped,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not queue voters" });
    }
  });

  // Send the queue to the blockchain in chunks.
  // POST /api/ec/elections/:electionId/voters/register-batch  { chunkSize }
  router.post("/ec/elections/:electionId/voters/register-batch", async (req, res) => {
    const { electionId } = req.params;
    const contract = getContract();
    if (!contract) return res.status(503).json({ error: "Blockchain is not connected" });

    const chunkSize = Math.min(Math.max(parseInt(req.body?.chunkSize, 10) || DEFAULT_CHUNK, 1), MAX_CHUNK);

    try {
      const [[election]] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
      if (!election) return res.status(404).json({ error: "Election not found" });

      const [pending] = await db.execute(
        `SELECT vr.id, vr.wallet_address, u.student_id
           FROM voter_registrations vr JOIN users u ON u.id = vr.user_id
          WHERE vr.election_id=? AND vr.status IN ('queued','failed')
          ORDER BY vr.id ASC`,
        [electionId]
      );
      if (!pending.length)
        return res.json({ success: true, message: "Nothing left to register — the queue is empty", batches: [] });

      const batches = [];
      let registered = 0, failed = 0;

      for (let i = 0; i < pending.length; i += chunkSize) {
        const slice = pending.slice(i, i + chunkSize);
        const batchNo = Math.floor(i / chunkSize) + 1;
        const addresses = slice.map((r) => r.wallet_address);
        const ids = slice.map((r) => r.id);

        try {
          const tx = await contract.registerVotersBatch(election.blockchain_id, addresses);
          const receipt = await tx.wait();

          await db.query(
            `UPDATE voter_registrations
                SET status='registered', tx_hash=?, batch_no=?, registered_at=NOW(), error_message=NULL
              WHERE id IN (?)`,
            [receipt.hash, batchNo, ids]
          );
          registered += slice.length;
          batches.push({
            batch: batchNo, count: slice.length, status: "registered",
            tx_hash: receipt.hash, gas_used: receipt.gasUsed?.toString() ?? null,
          });
        } catch (err) {
          const msg = describeContractError(err, "Transaction failed").slice(0, 250);
          await db.query(
            "UPDATE voter_registrations SET status='failed', batch_no=?, error_message=? WHERE id IN (?)",
            [batchNo, msg, ids]
          );
          failed += slice.length;
          batches.push({ batch: batchNo, count: slice.length, status: "failed", error: msg });
        }
      }

      await logAudit(null, "election_committee", electionId, "VOTERS_REGISTERED_BATCH",
        `${registered} registered on chain in ${batches.length} transaction(s); ${failed} failed`, req.ip);

      res.json({
        success: true,
        message: `${registered} voters registered on the blockchain in ${batches.length} transaction(s)` +
                 (failed ? `. ${failed} failed — retry to send them again.` : "."),
        registered, failed, chunkSize, batches,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: describeContractError(err, "Batch registration failed") });
    }
  });

  // Release a student's on-chain slot so they can re-link a wallet
  // (for example, a lost MetaMask account before voting opens).
  // POST /api/ec/elections/:electionId/voters/:userId/release
  router.post("/ec/elections/:electionId/voters/:userId/release", async (req, res) => {
    const { electionId, userId } = req.params;
    try {
      const [[election]] = await db.execute("SELECT status FROM elections WHERE id=?", [electionId]);
      if (!election) return res.status(404).json({ error: "Election not found" });
      if (election.status === "active")
        return res.status(403).json({
          error: "Voting is open. A registered address cannot be released while a ballot is live.",
        });

      await db.execute(
        "UPDATE voter_registrations SET status='superseded' WHERE election_id=? AND user_id=?",
        [electionId, userId]
      );
      await logAudit(null, "election_committee", electionId, "VOTER_RELEASED",
        `Released on-chain slot for user #${userId}`, req.ip);
      res.json({ success: true, message: "Slot released. The student may now link a different wallet." });
    } catch (err) {
      res.status(500).json({ error: "Could not release the registration" });
    }
  });

  // Per-student registration view for the EC "All students" table.
  // GET /api/ec/elections/:electionId/voters
  router.get("/ec/elections/:electionId/voters", async (req, res) => {
    const { electionId } = req.params;
    const { status, search } = req.query;
    try {
      let sql = `SELECT vr.*, u.student_id, u.full_name, u.faculty, u.campus
                   FROM voter_registrations vr JOIN users u ON u.id = vr.user_id
                  WHERE vr.election_id=?`;
      const params = [electionId];
      if (status) { sql += " AND vr.status=?"; params.push(status); }
      if (search) {
        sql += " AND (u.student_id LIKE ? OR u.full_name LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
      }
      sql += " ORDER BY vr.status ASC, u.student_id ASC LIMIT 500";
      const [rows] = await db.execute(sql, params);
      res.json({ success: true, voters: rows });
    } catch (err) {
      res.status(500).json({ error: "Could not fetch voter registrations" });
    }
  });

  return router;
};
