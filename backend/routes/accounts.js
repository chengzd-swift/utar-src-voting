// backend/routes/accounts.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Two moderator issues are answered here.
//
//  Issue 1 (partly): registration now links and verifies the
//  student's MetaMask wallet in the same form, so the EC never
//  types an address. Registration is also matched against the
//  DSA student roster, so approving a thousand accounts is not a
//  thousand manual clicks either.
//
//  Issue 3: students could not correct a typo in their email or
//  student ID after submitting. They can now edit their own
//  details, under a policy that keeps the EC's verification
//  meaningful:
//
//    • Contact details            — always editable.
//    • Identity, before approval  — editable directly.
//    • Identity, after approval   — raises a change request the
//                                   EC reviews; the account keeps
//                                   working in the meantime.
//    • Name and faculty, once the student is an approved
//      candidate — locked, because those strings are already
//      written into the blockchain candidate record.
//    • Student ID, after approval — locked; it is the identity
//      the roster match and the audit trail hang on.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const bcrypt = require("bcrypt");
const { verifySignedNonce, isAddress, toChecksum } = require("../lib/walletProof");
const {
  CAMPUSES, checkVoterEligibility, checkNomineeEligibility, normaliseRoster,
} = require("../lib/eligibility");

const SALT = 10;

// Fields a student may change, and how each is treated.
const FIELD_POLICY = {
  phone:      { tier: "open" },
  full_name:  { tier: "identity", label: "Full name" },
  email:      { tier: "identity", label: "Email" },
  faculty:    { tier: "identity", label: "Faculty" },
  campus:     { tier: "identity", label: "Campus" },
  student_id: { tier: "anchor",   label: "Student ID" },
};

module.exports = function accountRoutes({ db, logAudit }) {
  const router = express.Router();

  // ── Shared helper: is this student locked into a candidacy? ──
  async function hasLiveCandidacy(userId) {
    const [rows] = await db.execute(
      `SELECT n.id FROM nominations n
        WHERE n.student_id=? AND n.status IN ('pending','approved') LIMIT 1`,
      [userId]
    );
    return rows.length > 0;
  }

  async function rosterFor(studentId) {
    const [rows] = await db.execute("SELECT * FROM student_roster WHERE student_id=?", [studentId]);
    return rows.length ? normaliseRoster(rows[0]) : null;
  }

  // ═══════════════════════════════════════════════════════════
  //  REGISTRATION
  // ═══════════════════════════════════════════════════════════

  // Look up a student ID before the form is submitted, so the page
  // can pre-fill the roster's name, faculty and campus and tell the
  // student straight away whether they are eligible.
  // GET /api/auth/roster-check/:studentId
  router.get("/auth/roster-check/:studentId", async (req, res) => {
    try {
      const roster = await rosterFor(req.params.studentId);
      if (!roster)
        return res.json({
          success: true, found: false,
          message: "This student ID is not in the current roster. You can still register — the Election Committee will verify you manually.",
        });

      const voter = checkVoterEligibility(roster);
      const nominee = checkNomineeEligibility(roster);
      res.json({
        success: true, found: true,
        student: {
          full_name: roster.full_name, email: roster.email, faculty: roster.faculty,
          campus: roster.campus, study_level: roster.study_level,
          is_international: roster.is_international,
        },
        can_vote: voter.eligible, vote_blockers: voter.reasons,
        can_stand: nominee.eligible, stand_blockers: nominee.reasons,
      });
    } catch (err) {
      res.status(500).json({ error: "Roster lookup failed" });
    }
  });

  // POST /api/auth/register
  // { student_id, full_name, email, phone, faculty, campus, password,
  //   wallet_address?, wallet_nonce?, wallet_signature? }
  router.post("/auth/register", async (req, res) => {
    const {
      student_id, full_name, email, phone, faculty, campus, password,
      wallet_address, wallet_nonce, wallet_signature,
    } = req.body;

    if (!student_id || !full_name || !email || !faculty || !password)
      return res.status(400).json({ error: "Student ID, name, email, faculty and password are all required" });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });

    try {
      const [existing] = await db.execute(
        "SELECT id FROM users WHERE student_id=? OR email=?", [student_id, email]
      );
      if (existing.length)
        return res.status(409).json({ error: "That student ID or email is already registered" });

      // ── Wallet proof, if one was supplied ──────────────────
      let verifiedWallet = null;
      if (wallet_address) {
        if (!isAddress(wallet_address))
          return res.status(400).json({ error: "That is not a valid Ethereum address" });

        const verdict = await verifySignedNonce(db, {
          nonce: wallet_nonce, signature: wallet_signature,
          purpose: "wallet_link", studentId: student_id, expectedAddress: wallet_address,
        });
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        const [taken] = await db.execute("SELECT id FROM users WHERE wallet_address=?", [verdict.address]);
        if (taken.length)
          return res.status(409).json({ error: "This wallet is already linked to another student account" });

        verifiedWallet = verdict.address;
      }

      // ── Roster match decides approval ──────────────────────
      const roster = await rosterFor(student_id);

      // The roster is authoritative on campus, and it used to overwrite
      // whatever the student chose — so a Sungai Long student could
      // complete the Kampar form and end up with a Sungai Long account
      // without ever being told. Campus decides which election you vote
      // in, so a mismatch is worth stopping and explaining rather than
      // silently correcting.
      if (roster && CAMPUSES.includes(campus) && roster.campus !== campus) {
        return res.status(409).json({
          error: `${roster.full_name} is registered at ${roster.campus} Campus, not ${campus} Campus. `
               + `Please go back and register from the ${roster.campus} Campus portal — that is the election you vote in.`,
          correct_campus: roster.campus,
        });
      }

      let isApproved = 0, rosterMatched = 0, note = null;
      let finalFaculty = faculty;
      let finalCampus = CAMPUSES.includes(campus) ? campus : "Kampar";
      let studyLevel = "undergraduate";
      let isInternational = 0;

      if (!roster) {
        note = "Student ID not found in the DSA roster — awaiting manual verification";
      } else if (roster.email.toLowerCase() !== String(email).toLowerCase()) {
        note = "Email does not match the roster record — awaiting manual verification";
        // The roster is authoritative for everything except the
        // contact email the student wants to be reached on.
        finalFaculty = roster.faculty; finalCampus = roster.campus;
        studyLevel = roster.study_level; isInternational = roster.is_international ? 1 : 0;
        rosterMatched = 1;
      } else {
        const verdict = checkVoterEligibility(roster);
        finalFaculty = roster.faculty; finalCampus = roster.campus;
        studyLevel = roster.study_level; isInternational = roster.is_international ? 1 : 0;
        rosterMatched = 1;
        if (verdict.eligible) {
          isApproved = 1;
          note = "Auto-verified against the DSA student roster";
        } else {
          note = `Not eligible to vote — ${verdict.reasons.join("; ")}`;
        }
      }

      const hash = await bcrypt.hash(password, SALT);
      const [result] = await db.execute(
        `INSERT INTO users
           (student_id, full_name, email, phone, faculty, campus, study_level, is_international,
            password_hash, wallet_address, wallet_verified_at, wallet_proof_sig,
            role, is_active, is_approved, roster_matched, approval_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'student', 1, ?, ?, ?)`,
        [
          student_id, full_name, email, phone || null, finalFaculty, finalCampus, studyLevel, isInternational,
          hash, verifiedWallet, verifiedWallet ? new Date() : null, verifiedWallet ? wallet_signature : null,
          isApproved, rosterMatched, note,
        ]
      );

      await logAudit(result.insertId, "student", null, "REGISTER",
        `${student_id} registered — ${isApproved ? "auto-verified" : "pending review"}${verifiedWallet ? `, wallet ${verifiedWallet}` : ", no wallet yet"}`,
        req.ip);

      res.json({
        success: true,
        auto_approved: !!isApproved,
        wallet_linked: !!verifiedWallet,
        message: isApproved
          ? "Account verified against the student roster. You can sign in now."
          : "Registration received. The Election Committee will review it shortly.",
        note,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  STUDENT PROFILE
  // ═══════════════════════════════════════════════════════════

  // GET /api/profile/:userId
  router.get("/profile/:userId", async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT id, student_id, full_name, email, phone, faculty, campus, study_level,
                is_international, wallet_address, wallet_verified_at, role,
                is_approved, roster_matched, approval_note, created_at
           FROM users WHERE id=?`,
        [req.params.userId]
      );
      if (!rows.length) return res.status(404).json({ error: "Account not found" });
      const user = rows[0];

      const candidacyLock = await hasLiveCandidacy(user.id);
      const [pendingChanges] = await db.execute(
        "SELECT id, field_name, old_value, new_value, status, review_note, created_at FROM profile_change_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 20",
        [user.id]
      );
      const [walletLock] = await db.execute(
        `SELECT e.title FROM voter_registrations vr JOIN elections e ON e.id = vr.election_id
          WHERE vr.user_id=? AND vr.status='registered' AND e.status IN ('setup','nomination','active')`,
        [user.id]
      );

      // Tell the page exactly what it may offer, instead of the page
      // guessing and the server disagreeing.
      const editable = {
        phone: true,
        full_name: !candidacyLock,
        email: true,
        faculty: !candidacyLock,
        campus: !candidacyLock,
        student_id: !user.is_approved,
        wallet_address: walletLock.length === 0,
      };
      const needsReview = {
        full_name: !!user.is_approved, email: !!user.is_approved,
        faculty: !!user.is_approved, campus: !!user.is_approved,
      };

      res.json({
        success: true,
        user,
        editable,
        needs_review: needsReview,
        locks: {
          candidacy: candidacyLock,
          wallet_election: walletLock.length ? walletLock[0].title : null,
        },
        change_requests: pendingChanges,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load profile" });
    }
  });

  // PUT /api/profile/:userId
  // { full_name?, email?, phone?, faculty?, campus?, student_id?, reason? }
  router.put("/profile/:userId", async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    try {
      const [rows] = await db.execute("SELECT * FROM users WHERE id=? AND role='student'", [userId]);
      if (!rows.length) return res.status(404).json({ error: "Account not found" });
      const user = rows[0];
      const candidacyLock = await hasLiveCandidacy(user.id);

      const applied = [];   // changed immediately
      const queued = [];    // sent to the EC
      const refused = [];   // not permitted

      for (const [field, policy] of Object.entries(FIELD_POLICY)) {
        if (!(field in req.body)) continue;
        const next = req.body[field] === "" ? null : req.body[field];
        const current = user[field] ?? null;
        if (String(next ?? "") === String(current ?? "")) continue;

        // ── Validation ────────────────────────────────────────
        if (field === "email") {
          if (!next || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) {
            refused.push({ field, reason: "Enter a valid email address" }); continue;
          }
          const [clash] = await db.execute("SELECT id FROM users WHERE email=? AND id<>?", [next, userId]);
          if (clash.length) { refused.push({ field, reason: "That email belongs to another account" }); continue; }
        }
        if (field === "campus" && !CAMPUSES.includes(next)) {
          refused.push({ field, reason: "Campus must be Kampar or Sungai Long" }); continue;
        }
        if (field === "student_id") {
          if (user.is_approved) {
            refused.push({
              field,
              reason: "Your student ID is locked once your account is verified. Contact the Election Committee at dsa@utar.edu.my if it is wrong.",
            });
            continue;
          }
          const [clash] = await db.execute("SELECT id FROM users WHERE student_id=? AND id<>?", [next, userId]);
          if (clash.length) { refused.push({ field, reason: "That student ID belongs to another account" }); continue; }
        }
        if ((field === "full_name" || field === "faculty") && candidacyLock) {
          refused.push({
            field,
            reason: "Locked while your nomination is under review or approved — this name is already on the blockchain candidate record",
          });
          continue;
        }

        // ── Route the change ──────────────────────────────────
        if (policy.tier === "open" || !user.is_approved) {
          await db.execute(`UPDATE users SET ${field}=? WHERE id=?`, [next, userId]);
          applied.push({ field, from: current, to: next });
        } else {
          const [dupe] = await db.execute(
            "SELECT id FROM profile_change_requests WHERE user_id=? AND field_name=? AND status='pending'",
            [userId, field]
          );
          if (dupe.length) {
            await db.execute(
              "UPDATE profile_change_requests SET new_value=?, reason=?, created_at=NOW() WHERE id=?",
              [next, reason || null, dupe[0].id]
            );
          } else {
            await db.execute(
              "INSERT INTO profile_change_requests (user_id, field_name, old_value, new_value, reason) VALUES (?,?,?,?,?)",
              [userId, field, current, next, reason || null]
            );
          }
          queued.push({ field: policy.label || field, from: current, to: next });
        }
      }

      // If a pending account corrected its student ID, re-run the
      // roster match — it may now verify automatically.
      let reVerified = false;
      if (applied.some((a) => a.field === "student_id") && !user.is_approved) {
        const roster = await rosterFor(req.body.student_id);
        if (roster) {
          const verdict = checkVoterEligibility(roster);
          await db.execute(
            `UPDATE users SET faculty=?, campus=?, study_level=?, is_international=?,
                    roster_matched=1, is_approved=?, approval_note=? WHERE id=?`,
            [roster.faculty, roster.campus, roster.study_level, roster.is_international ? 1 : 0,
             verdict.eligible ? 1 : 0,
             verdict.eligible ? "Auto-verified against the DSA student roster after correction"
                              : `Not eligible to vote — ${verdict.reasons.join("; ")}`,
             userId]
          );
          reVerified = verdict.eligible;
        }
      }

      if (applied.length || queued.length) {
        const summary = [
          ...applied.map((a) => `${a.field}: "${a.from ?? "—"}" → "${a.to ?? "—"}"`),
          ...queued.map((q) => `${q.field} (pending EC review)`),
        ].join("; ");
        await logAudit(user.id, "student", null, "PROFILE_UPDATED", summary.slice(0, 500), req.ip);
      }

      res.json({
        success: true,
        applied, queued, refused,
        re_verified: reVerified,
        message: buildProfileMessage(applied, queued, refused, reVerified),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not save your changes" });
    }
  });

  function buildProfileMessage(applied, queued, refused, reVerified) {
    const parts = [];
    if (applied.length) parts.push(`${applied.length} change${applied.length > 1 ? "s" : ""} saved`);
    if (queued.length) parts.push(`${queued.length} sent to the Election Committee for review`);
    if (refused.length) parts.push(`${refused.length} could not be changed`);
    if (reVerified) parts.push("your account is now verified against the roster");
    if (!parts.length) return "Nothing changed";
    return parts.join(", ") + ".";
  }

  // DELETE /api/profile/:userId/change-requests/:id — withdraw a request
  router.delete("/profile/:userId/change-requests/:id", async (req, res) => {
    try {
      const [r] = await db.execute(
        "DELETE FROM profile_change_requests WHERE id=? AND user_id=? AND status='pending'",
        [req.params.id, req.params.userId]
      );
      if (!r.affectedRows) return res.status(404).json({ error: "No pending request to withdraw" });
      res.json({ success: true, message: "Request withdrawn" });
    } catch (err) {
      res.status(500).json({ error: "Could not withdraw the request" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  EC — review profile change requests
  // ═══════════════════════════════════════════════════════════

  // GET /api/ec/profile-requests?status=pending
  router.get("/ec/profile-requests", async (req, res) => {
    const { status = "pending" } = req.query;
    try {
      const [rows] = await db.execute(
        `SELECT p.*, u.student_id, u.full_name, u.campus
           FROM profile_change_requests p JOIN users u ON u.id = p.user_id
          WHERE p.status=? ORDER BY p.created_at ASC`,
        [status]
      );
      res.json({ success: true, requests: rows });
    } catch (err) {
      res.status(500).json({ error: "Could not fetch change requests" });
    }
  });

  // POST /api/ec/profile-requests/:id/approve
  router.post("/ec/profile-requests/:id/approve", async (req, res) => {
    try {
      const [rows] = await db.execute("SELECT * FROM profile_change_requests WHERE id=?", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "Request not found" });
      const reqRow = rows[0];
      if (reqRow.status !== "pending") return res.status(400).json({ error: "This request was already reviewed" });
      if (!Object.prototype.hasOwnProperty.call(FIELD_POLICY, reqRow.field_name))
        return res.status(400).json({ error: "Unsupported field" });

      await db.execute(`UPDATE users SET ${reqRow.field_name}=? WHERE id=?`, [reqRow.new_value, reqRow.user_id]);
      await db.execute(
        "UPDATE profile_change_requests SET status='approved', reviewed_at=NOW(), review_note=? WHERE id=?",
        [req.body?.note || null, reqRow.id]
      );
      await logAudit(reqRow.user_id, "election_committee", null, "PROFILE_CHANGE_APPROVED",
        `${reqRow.field_name}: "${reqRow.old_value ?? "—"}" → "${reqRow.new_value}"`, req.ip);

      res.json({ success: true, message: "Change approved and applied" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not approve the change" });
    }
  });

  // POST /api/ec/profile-requests/:id/reject   { note }
  router.post("/ec/profile-requests/:id/reject", async (req, res) => {
    try {
      const [r] = await db.execute(
        "UPDATE profile_change_requests SET status='rejected', reviewed_at=NOW(), review_note=? WHERE id=? AND status='pending'",
        [req.body?.note || null, req.params.id]
      );
      if (!r.affectedRows) return res.status(404).json({ error: "No pending request with that ID" });
      await logAudit(null, "election_committee", null, "PROFILE_CHANGE_REJECTED",
        `Request #${req.params.id}: ${req.body?.note || "no reason given"}`, req.ip);
      res.json({ success: true, message: "Change rejected" });
    } catch (err) {
      res.status(500).json({ error: "Could not reject the change" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  EC — student roster import
  // ═══════════════════════════════════════════════════════════

  // What has been imported so far, newest first.
  // GET /api/ec/roster/imports
  //
  // Every roster row carries the label of the import that last wrote it,
  // so the history is reconstructed from the roster itself rather than
  // kept in a second table that could drift out of step with it. A row
  // re-imported by a later file counts towards that later batch, which
  // is what the EC wants to see: what each import actually left behind.
  router.get("/ec/roster/imports", async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT imported_batch AS batch,
                COUNT(*)                                          AS students,
                SUM(campus='Kampar')                              AS kampar,
                SUM(campus='Sungai Long')                         AS sungai_long,
                MIN(created_at)                                   AS first_seen,
                MAX(updated_at)                                   AS imported_at
           FROM student_roster
          WHERE imported_batch IS NOT NULL
          GROUP BY imported_batch
          ORDER BY imported_at DESC
          LIMIT 50`
      );
      res.json({
        success: true,
        imports: rows.map((r) => ({
          ...r,
          students: Number(r.students),
          kampar: Number(r.kampar),
          sungai_long: Number(r.sungai_long),
        })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load the import history" });
    }
  });

  // The students a given import left on the roster.
  // GET /api/ec/roster/imports/:batch
  router.get("/ec/roster/imports/:batch", async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT student_id, full_name, email, faculty, campus, study_level,
                is_international, is_enrolled, on_leave, delivery_mode,
                sat_first_exam, trimesters_left, updated_at
           FROM student_roster
          WHERE imported_batch = ?
          ORDER BY campus, student_id
          LIMIT 500`,
        [req.params.batch]
      );
      res.json({ success: true, batch: req.params.batch, students: rows.map(normaliseRoster) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load that import" });
    }
  });

  // POST /api/ec/roster/import   { batch, rows: [ {...}, ... ] }
  // Accepts the DSA export. Existing rows are updated, so the EC can
  // re-import mid-election when someone's status changes.
  router.post("/ec/roster/import", async (req, res) => {
    const { rows, batch } = req.body;
    if (!Array.isArray(rows) || !rows.length)
      return res.status(400).json({ error: "Provide at least one roster row" });
    if (rows.length > 20000)
      return res.status(413).json({ error: "Split the file into batches of 20,000 rows or fewer" });

    const label = batch || `import-${new Date().toISOString().slice(0, 19)}`;
    let inserted = 0;
    const rejected = [];

    try {
      for (const [i, row] of rows.entries()) {
        if (!row.student_id || !row.full_name || !row.campus) {
          rejected.push({ line: i + 1, reason: "student_id, full_name and campus are required" });
          continue;
        }
        if (!CAMPUSES.includes(row.campus)) {
          rejected.push({ line: i + 1, reason: `Unknown campus "${row.campus}"` });
          continue;
        }
        await db.execute(
          `INSERT INTO student_roster
             (student_id, full_name, email, faculty, campus, study_level, is_international,
              delivery_mode, sat_first_exam, trimesters_left, on_leave, academic_probation,
              criminal_offence, disciplinary_guilty, disciplinary_open, fees_in_arrears,
              president_waiver, deemed_unfit, unfit_reason, is_enrolled, imported_batch)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             full_name=VALUES(full_name), email=VALUES(email), faculty=VALUES(faculty),
             campus=VALUES(campus), study_level=VALUES(study_level),
             is_international=VALUES(is_international), delivery_mode=VALUES(delivery_mode),
             sat_first_exam=VALUES(sat_first_exam), trimesters_left=VALUES(trimesters_left),
             on_leave=VALUES(on_leave), academic_probation=VALUES(academic_probation),
             criminal_offence=VALUES(criminal_offence), disciplinary_guilty=VALUES(disciplinary_guilty),
             disciplinary_open=VALUES(disciplinary_open), fees_in_arrears=VALUES(fees_in_arrears),
             president_waiver=VALUES(president_waiver), deemed_unfit=VALUES(deemed_unfit),
             unfit_reason=VALUES(unfit_reason), is_enrolled=VALUES(is_enrolled),
             imported_batch=VALUES(imported_batch)`,
          [
            String(row.student_id).trim(), row.full_name, row.email || "", row.faculty || "",
            row.campus, row.study_level || "undergraduate", num(row.is_international),
            row.delivery_mode || "on_campus", num(row.sat_first_exam, 1),
            parseInt(row.trimesters_left, 10) || 6, num(row.on_leave), num(row.academic_probation),
            num(row.criminal_offence), num(row.disciplinary_guilty), num(row.disciplinary_open),
            num(row.fees_in_arrears), num(row.president_waiver), num(row.deemed_unfit),
            row.unfit_reason || null, num(row.is_enrolled, 1), label,
          ]
        );
        inserted++;
      }

      await logAudit(null, "election_committee", null, "ROSTER_IMPORTED",
        `${inserted} roster rows imported as "${label}"; ${rejected.length} rejected`, req.ip);

      res.json({
        success: true,
        message: `${inserted} student records imported.` + (rejected.length ? ` ${rejected.length} rows were skipped.` : ""),
        imported: inserted, rejected, batch: label,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Roster import failed" });
    }
  });

  // Re-run the roster match over every account still awaiting review.
  // POST /api/ec/roster/reconcile
  router.post("/ec/roster/reconcile", async (req, res) => {
    try {
      const [pending] = await db.execute(
        "SELECT id, student_id, email FROM users WHERE role='student' AND is_approved=0"
      );
      let approved = 0, stillPending = 0;

      for (const u of pending) {
        const roster = await rosterFor(u.student_id);
        if (!roster) { stillPending++; continue; }
        const verdict = checkVoterEligibility(roster);
        if (!verdict.eligible) {
          await db.execute("UPDATE users SET roster_matched=1, approval_note=? WHERE id=?",
            [`Not eligible to vote — ${verdict.reasons.join("; ")}`, u.id]);
          stillPending++; continue;
        }
        await db.execute(
          `UPDATE users SET is_approved=1, roster_matched=1, faculty=?, campus=?, study_level=?,
                  is_international=?, approval_note='Auto-verified against the DSA student roster'
            WHERE id=?`,
          [roster.faculty, roster.campus, roster.study_level, roster.is_international ? 1 : 0, u.id]
        );
        approved++;
      }

      await logAudit(null, "election_committee", null, "ROSTER_RECONCILED",
        `${approved} accounts auto-verified; ${stillPending} still need a decision`, req.ip);

      res.json({
        success: true,
        message: `${approved} account${approved === 1 ? "" : "s"} verified automatically. ${stillPending} still need a decision.`,
        approved, still_pending: stillPending,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Reconcile failed" });
    }
  });

  function num(v, dflt = 0) {
    if (v === undefined || v === null || v === "") return dflt;
    if (typeof v === "string") return ["1", "true", "yes", "y"].includes(v.toLowerCase()) ? 1 : 0;
    return v ? 1 : 0;
  }

  return router;
};
