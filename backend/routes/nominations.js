// backend/routes/nominations.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Moderator issue 2: "Students can key in proposer / seconder by
//  themselves, which weakens the integrity of the system."
//
//  In v4 the nominee typed four free-text strings. Nothing checked
//  that the people existed, that they agreed, that they were on
//  the right campus, or that they had not already endorsed a rival.
//
//  Two things were wrong, and only one of them is fixed by asking
//  the EC to verify. Verification by hand does not scale, and it
//  still cannot tell a real endorsement from an invented one —
//  the EC has no way to know whether Lee Wei Ming actually agreed.
//
//  v5 removes the free text entirely.
//
//    1. The nominee enters four student IDs. Nothing else. The
//       system resolves the names itself, so no invented person
//       can enter the record.
//    2. Reg 20 is checked mechanically at that moment: same
//       campus, eligible as a voter, not the nominee, all four
//       distinct, and not already endorsing someone else for the
//       same post.
//    3. Each endorser then signs in to their own account and
//       confirms. That is the digital form of Reg 20(2)'s "present
//       in person and produce their Student Identity Cards" — the
//       endorsement is authenticated with credentials the nominee
//       does not hold, ideally a MetaMask signature.
//    4. Only when all four have confirmed does the nomination
//       reach the EC. The EC still decides; it just no longer has
//       to do the checking.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const bcrypt = require("bcrypt");
const { endorsementMessage, issueNonce, verifySignedNonce } = require("../lib/walletProof");
const { describeContractError } = require("../lib/contractError");
const {
  ENDORSER_ROLES, ENDORSER_LABELS, SRC_POSITIONS,
  checkVoterEligibility, checkNomineeEligibility, checkPositionEligibility,
  canWithdraw, normaliseRoster,
} = require("../lib/eligibility");

module.exports = function nominationRoutes({ db, getContract, logAudit }) {
  const router = express.Router();

  async function rosterFor(studentId) {
    const [rows] = await db.execute("SELECT * FROM student_roster WHERE student_id=?", [studentId]);
    return rows.length ? normaliseRoster(rows[0]) : null;
  }

  /**
   * Reg 20(2)+(3) for one endorser.
   * Returns the resolved user row, or an explanation of the refusal.
   */
  async function resolveEndorser({ studentCode, role, election, nominee, position, takenIds }) {
    const label = ENDORSER_LABELS[role];
    const code = String(studentCode || "").trim();

    if (!code) return { ok: false, error: `${label}: student ID is required` };

    const [rows] = await db.execute(
      "SELECT id, student_id, full_name, faculty, campus, is_approved, wallet_address FROM users WHERE student_id=? AND role='student'",
      [code]
    );
    if (!rows.length)
      return { ok: false, error: `${label} ${code}: no student account with that ID. They must register on the system first.` };
    const person = rows[0];

    if (person.id === nominee.id)
      return { ok: false, error: `${label}: you cannot endorse your own nomination` };
    if (takenIds.has(person.id))
      return { ok: false, error: `${label} ${code}: this student is already listed in another role on this form` };
    if (!person.is_approved)
      return { ok: false, error: `${label} ${code} (${person.full_name}): account is not yet verified by the Election Committee` };

    // Reg 20(2) — same campus as the nominee and the election.
    if (person.campus !== election.campus)
      return { ok: false, error: `${label} ${code} (${person.full_name}): is registered at ${person.campus} Campus, but this election is for ${election.campus} Campus (Reg 20(2))` };

    // Reg 20(2) — must satisfy the eligibility of a voter.
    const roster = await rosterFor(person.student_id);
    const verdict = checkVoterEligibility(roster);
    if (!verdict.eligible)
      return { ok: false, error: `${label} ${code} (${person.full_name}): not eligible — ${verdict.reasons.join("; ")}` };

    // Reg 20(3) — only one nominee per post.
    const [clash] = await db.execute(
      `SELECT ne.endorser_role, u.full_name AS nominee_name, u.student_id AS nominee_code
         FROM nomination_endorsements ne
         JOIN nominations n ON n.id = ne.nomination_id
         JOIN users u ON u.id = n.student_id
        WHERE ne.election_id=? AND ne.position=? AND ne.endorser_user_id=?
          AND ne.status IN ('invited','confirmed')`,
      [election.id, position, person.id]
    );
    if (clash.length)
      return {
        ok: false,
        error: `${label} ${code} (${person.full_name}): already listed as ${ENDORSER_LABELS[clash[0].endorser_role]} for ${clash[0].nominee_name} (${clash[0].nominee_code}) for the post of ${position}. Reg 20(3) allows only one nominee per post.`,
      };

    // A candidate for a post must not endorse a rival for that same
    // post. Reg 20(3) stops one person backing two nominees; this is
    // the same conflict seen from the other side — someone contesting
    // the seat cannot also be proposing whoever they are running
    // against.
    const [rival] = await db.execute(
      `SELECT position FROM nominations
        WHERE election_id=? AND student_id=? AND position=?
          AND status IN ('awaiting_endorsement','pending','approved')`,
      [election.id, person.id, position]
    );
    if (rival.length)
      return {
        ok: false,
        error: `${label} ${code} (${person.full_name}): is standing for ${position} in this election, so they cannot endorse another nominee for the same post.`,
      };

    return { ok: true, person };
  }

  // ═══════════════════════════════════════════════════════════
  //  NOMINEE — submit a nomination
  // ═══════════════════════════════════════════════════════════

  // POST /api/nominations
  // { election_id, student_user_id, position, faculty_scope?, manifesto,
  //   proposer, seconder, supporter_1, supporter_2 }   ← student IDs
  router.post("/nominations", async (req, res) => {
    const {
      election_id, student_user_id, position, faculty_scope, manifesto,
      proposer, seconder, supporter_1, supporter_2,
    } = req.body;

    if (!election_id || !student_user_id || !position)
      return res.status(400).json({ error: "Election, nominee and position are all required" });
    if (!SRC_POSITIONS.includes(position))
      return res.status(400).json({ error: "That is not an SRC post under Reg 2(1)" });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [[election]] = await conn.execute("SELECT * FROM elections WHERE id=?", [election_id]);
      if (!election) { await conn.rollback(); return res.status(404).json({ error: "Election not found" }); }
      if (election.status !== "nomination") {
        await conn.rollback();
        return res.status(403).json({ error: "Nominations are not open for this election" });
      }
      if (election.nomination_end && new Date(election.nomination_end) < new Date()) {
        await conn.rollback();
        return res.status(403).json({ error: "The nomination period has closed" });
      }

      const [[nominee]] = await conn.execute(
        "SELECT * FROM users WHERE id=? AND role='student'", [student_user_id]
      );
      if (!nominee) { await conn.rollback(); return res.status(404).json({ error: "Nominee account not found" }); }
      if (!nominee.is_approved) {
        await conn.rollback();
        return res.status(403).json({ error: "Your account is still awaiting verification by the Election Committee" });
      }
      if (nominee.campus !== election.campus) {
        await conn.rollback();
        return res.status(403).json({ error: `You are registered at ${nominee.campus} Campus and cannot stand in the ${election.campus} Campus election` });
      }

      // Reg 4 — is the nominee eligible to stand at all?
      const nomineeRoster = await rosterFor(nominee.student_id);
      const eligibility = checkNomineeEligibility(nomineeRoster);
      if (!eligibility.eligible) {
        await conn.rollback();
        return res.status(403).json({
          error: "You are not eligible to stand for the SRC",
          reasons: eligibility.reasons,
        });
      }
      const posCheck = checkPositionEligibility(position, nominee);
      if (!posCheck.eligible) {
        await conn.rollback();
        return res.status(403).json({ error: posCheck.reasons.join("; ") });
      }

      // The mirror of the rival-endorsement rule in resolveEndorser():
      // someone already backing a nominee for this post cannot then
      // stand for it themselves.
      const [backing] = await conn.execute(
        `SELECT u.full_name AS nominee_name, ne.endorser_role
           FROM nomination_endorsements ne
           JOIN nominations n ON n.id = ne.nomination_id
           JOIN users u ON u.id = n.student_id
          WHERE ne.election_id=? AND ne.position=? AND ne.endorser_user_id=?
            AND ne.status IN ('invited','confirmed')`,
        [election_id, position, student_user_id]
      );
      if (backing.length) {
        await conn.rollback();
        return res.status(409).json({
          error: `You are already listed as ${ENDORSER_LABELS[backing[0].endorser_role]} for ${backing[0].nominee_name} for the post of ${position}. Withdraw that endorsement before standing for the same post.`,
        });
      }

      // Reg 20(1) — one post per nominee. The generated unique key on
      // nominations enforces this too; this check gives a clear message.
      const [existing] = await conn.execute(
        `SELECT position, status FROM nominations
          WHERE election_id=? AND student_id=? AND status IN ('awaiting_endorsement','pending','approved')`,
        [election_id, student_user_id]
      );
      if (existing.length) {
        await conn.rollback();
        return res.status(409).json({
          error: `You already have a nomination for ${existing[0].position} in this election. Reg 20(1) allows only one post.`,
        });
      }

      // ── Resolve all four endorsers before writing anything ──
      const supplied = { proposer, seconder, supporter_1, supporter_2 };
      const takenIds = new Set();
      const resolved = {};
      for (const role of ENDORSER_ROLES) {
        const outcome = await resolveEndorser({
          studentCode: supplied[role], role, election, nominee, position, takenIds,
        });
        if (!outcome.ok) { await conn.rollback(); return res.status(400).json({ error: outcome.error }); }
        takenIds.add(outcome.person.id);
        resolved[role] = outcome.person;
      }

      // ── Write nomination + four invitations ────────────────
      const [ins] = await conn.execute(
        `INSERT INTO nominations
           (election_id, student_id, position, campus, faculty_scope, manifesto, status)
         VALUES (?,?,?,?,?,?, 'awaiting_endorsement')`,
        [election_id, student_user_id, position, election.campus,
         position === "Faculty/Institute Representative" ? (faculty_scope || nominee.faculty) : null,
         manifesto || null]
      );
      const nominationId = ins.insertId;

      for (const role of ENDORSER_ROLES) {
        await conn.execute(
          `INSERT INTO nomination_endorsements
             (nomination_id, election_id, position, endorser_user_id, endorser_role, status)
           VALUES (?,?,?,?,?, 'invited')`,
          [nominationId, election_id, position, resolved[role].id, role]
        );
      }

      await conn.commit();

      await logAudit(student_user_id, "student", election_id, "NOMINATION_SUBMITTED",
        `${nominee.student_id} nominated for ${position}; endorsement requests sent to ` +
        ENDORSER_ROLES.map((r) => resolved[r].student_id).join(", "), req.ip);

      res.json({
        success: true,
        nomination_id: nominationId,
        message: "Nomination created. It reaches the Election Committee once all four endorsers confirm.",
        endorsers: ENDORSER_ROLES.map((role) => ({
          role, label: ENDORSER_LABELS[role],
          student_id: resolved[role].student_id,
          full_name: resolved[role].full_name,
          status: "invited",
        })),
      });
    } catch (err) {
      await conn.rollback();
      if (err.code === "ER_DUP_ENTRY")
        return res.status(409).json({
          error: "One of these endorsers was claimed for this post a moment ago. Refresh and choose someone else.",
        });
      console.error(err);
      res.status(500).json({ error: "Could not submit the nomination" });
    } finally {
      conn.release();
    }
  });

  // Replace an endorser who declined, while nominations are open.
  // PUT /api/nominations/:nominationId/endorsers/:role   { student_id }
  router.put("/nominations/:nominationId/endorsers/:role", async (req, res) => {
    const { nominationId, role } = req.params;
    const { student_id, requested_by } = req.body;
    if (!ENDORSER_ROLES.includes(role)) return res.status(400).json({ error: "Unknown endorser role" });

    try {
      const [[nom]] = await db.execute(
        `SELECT n.*, u.full_name AS nominee_name, u.student_id AS nominee_code, u.campus AS nominee_campus, u.id AS nominee_id
           FROM nominations n JOIN users u ON u.id = n.student_id WHERE n.id=?`,
        [nominationId]
      );
      if (!nom) return res.status(404).json({ error: "Nomination not found" });
      if (requested_by && Number(requested_by) !== Number(nom.nominee_id))
        return res.status(403).json({ error: "Only the nominee can change their own endorsers" });
      if (nom.status !== "awaiting_endorsement")
        return res.status(403).json({ error: "Endorsers can only be changed while the nomination is still collecting endorsements" });

      const [[election]] = await db.execute("SELECT * FROM elections WHERE id=?", [nom.election_id]);
      if (election.status !== "nomination")
        return res.status(403).json({ error: "The nomination period is closed" });

      const [[current]] = await db.execute(
        "SELECT * FROM nomination_endorsements WHERE nomination_id=? AND endorser_role=?",
        [nominationId, role]
      );
      if (current && current.status === "confirmed")
        return res.status(403).json({ error: `Your ${ENDORSER_LABELS[role]} has already confirmed and cannot be swapped out` });

      // Who else is already on this form?
      const [others] = await db.execute(
        "SELECT endorser_user_id FROM nomination_endorsements WHERE nomination_id=? AND endorser_role<>? AND status IN ('invited','confirmed')",
        [nominationId, role]
      );
      const takenIds = new Set(others.map((o) => o.endorser_user_id));

      const outcome = await resolveEndorser({
        studentCode: student_id, role, election,
        nominee: { id: nom.nominee_id }, position: nom.position, takenIds,
      });
      if (!outcome.ok) return res.status(400).json({ error: outcome.error });

      if (current) {
        await db.execute(
          `UPDATE nomination_endorsements
              SET endorser_user_id=?, status='invited', verification_method=NULL, wallet_address=NULL,
                  signed_message=NULL, signature=NULL, decline_reason=NULL, responded_at=NULL
            WHERE id=?`,
          [outcome.person.id, current.id]
        );
      } else {
        await db.execute(
          `INSERT INTO nomination_endorsements (nomination_id, election_id, position, endorser_user_id, endorser_role, status)
           VALUES (?,?,?,?,?, 'invited')`,
          [nominationId, nom.election_id, nom.position, outcome.person.id, role]
        );
      }

      await logAudit(nom.nominee_id, "student", nom.election_id, "ENDORSER_REPLACED",
        `${nom.nominee_code} set ${ENDORSER_LABELS[role]} to ${outcome.person.student_id}`, req.ip);

      res.json({
        success: true,
        message: `${ENDORSER_LABELS[role]} changed to ${outcome.person.full_name}. They now need to confirm.`,
        endorser: { student_id: outcome.person.student_id, full_name: outcome.person.full_name },
      });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY")
        return res.status(409).json({ error: "That student is already endorsing another nominee for this post (Reg 20(3))" });
      console.error(err);
      res.status(500).json({ error: "Could not change the endorser" });
    }
  });

  // Check one endorser against one election, before the form is sent.
  // GET /api/nominations/endorser-check?election_id=&student_id=&position=&nominee_id=
  //
  // The form used to preview endorsers with /api/auth/roster-check,
  // which knows nothing about the election — so a Sungai Long student
  // previewed as perfectly fine and was only refused on submit, after
  // the nominee had filled in the whole form. This runs the same rules
  // the submit runs, so what the student is told is what will happen.
  router.get("/nominations/endorser-check", async (req, res) => {
    const { election_id, student_id, position, nominee_id } = req.query;
    const code = String(student_id || "").trim();
    if (!election_id || !code) return res.status(400).json({ error: "election_id and student_id are required" });

    try {
      const [[election]] = await db.execute("SELECT * FROM elections WHERE id=?", [election_id]);
      if (!election) return res.status(404).json({ error: "Election not found" });

      const [rows] = await db.execute(
        "SELECT id, student_id, full_name, faculty, campus, is_approved FROM users WHERE student_id=? AND role='student'",
        [code]
      );

      // No account yet. The roster still knows their campus, and a
      // cross-campus name is worth refusing on those grounds — it is
      // the more useful answer than "they have not signed up".
      if (!rows.length) {
        const roster = await rosterFor(code);
        if (roster && roster.campus !== election.campus)
          return res.json({ ok: false, reason: `${roster.full_name} (${code}) is registered at ${roster.campus} Campus, but this election is for ${election.campus} Campus (Reg 20(2)).` });
        if (!roster)
          return res.json({ ok: false, reason: `No student with ID ${code} is in the roster or on this system.` });
        return res.json({ ok: false, reason: `${roster.full_name} (${code}) has not registered on this system yet, so they cannot confirm an endorsement.` });
      }

      const person = rows[0];
      if (nominee_id && Number(person.id) === Number(nominee_id))
        return res.json({ ok: false, reason: "You cannot endorse your own nomination." });
      if (!person.is_approved)
        return res.json({ ok: false, reason: `${person.full_name} (${code}) is not yet verified by the Election Committee.` });
      if (person.campus !== election.campus)
        return res.json({ ok: false, reason: `${person.full_name} (${code}) is registered at ${person.campus} Campus, but this election is for ${election.campus} Campus (Reg 20(2)).` });

      const roster = await rosterFor(person.student_id);
      const verdict = checkVoterEligibility(roster);
      if (!verdict.eligible)
        return res.json({ ok: false, reason: `${person.full_name} (${code}) is not eligible to vote — ${verdict.reasons.join("; ")}` });

      if (position) {
        const [clash] = await db.execute(
          `SELECT u.full_name AS nominee_name FROM nomination_endorsements ne
             JOIN nominations n ON n.id = ne.nomination_id
             JOIN users u ON u.id = n.student_id
            WHERE ne.election_id=? AND ne.position=? AND ne.endorser_user_id=?
              AND ne.status IN ('invited','confirmed')`,
          [election_id, position, person.id]
        );
        if (clash.length)
          return res.json({ ok: false, reason: `${person.full_name} (${code}) is already endorsing ${clash[0].nominee_name} for ${position}. Reg 20(3) allows only one nominee per post.` });

        const [rival] = await db.execute(
          `SELECT id FROM nominations WHERE election_id=? AND student_id=? AND position=?
             AND status IN ('awaiting_endorsement','pending','approved')`,
          [election_id, person.id, position]
        );
        if (rival.length)
          return res.json({ ok: false, reason: `${person.full_name} (${code}) is standing for ${position} themselves, so they cannot endorse a rival for the same post.` });
      }

      res.json({ ok: true, full_name: person.full_name, faculty: person.faculty, campus: person.campus });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not check that endorser" });
    }
  });

  // Can this student stand at all, and have they already?
  // GET /api/nominations/can-stand/:userId?election_id=
  //
  // Drives the nomination form: a student who may not stand, or who has
  // already submitted, should see the reason rather than a form that
  // will be refused.
  router.get("/nominations/can-stand/:userId", async (req, res) => {
    try {
      const [[student]] = await db.execute(
        "SELECT id, student_id, full_name, campus FROM users WHERE id=? AND role='student'",
        [req.params.userId]
      );
      if (!student) return res.status(404).json({ error: "Student not found" });

      const roster = await rosterFor(student.student_id);
      const verdict = checkNomineeEligibility(roster);

      let existing = null;
      if (req.query.election_id) {
        const [[nom]] = await db.execute(
          `SELECT position, status FROM nominations
            WHERE election_id=? AND student_id=? AND status IN ('awaiting_endorsement','pending','approved')`,
          [req.query.election_id, student.id]
        );
        if (nom) existing = { position: nom.position, status: nom.status };
      }

      res.json({
        success: true,
        can_stand: verdict.eligible,
        reasons: verdict.reasons,
        already_nominated: existing,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not check your eligibility to stand" });
    }
  });

  // Which posts may this student actually stand for?
  // GET /api/nominations/positions/:userId
  //
  // The nomination form used to offer all ten posts under Reg 2(1) and
  // let the student find out only on submit that, say, the
  // International Representative post was never open to them — after
  // they had already chased down four endorsers. This answers the same
  // question up front, using the same checkPositionEligibility() and
  // the same users row the submit above enforces with, so the form and
  // the server can never disagree about who may stand for what.
  router.get("/nominations/positions/:userId", async (req, res) => {
    try {
      const [[nominee]] = await db.execute(
        "SELECT id, study_level, is_international, faculty, campus FROM users WHERE id=? AND role='student'",
        [req.params.userId]
      );
      if (!nominee) return res.status(404).json({ error: "Student account not found" });

      // Reg 2(1)(g): the Faculty/Institute Representative seat belongs to
      // one faculty, not to the campus at large — an FICT student stands
      // for FICT and nobody else. The stored position string stays
      // "Faculty/Institute Representative" (the nomination record carries
      // the faculty separately in faculty_scope, and the candidate list on
      // chain is grouped by that exact post name), so this only names the
      // seat the student would actually be standing for.
      const facultyAbbr = (nominee.faculty || "").match(/\(([^)]+)\)\s*$/);
      const facultyScope = facultyAbbr ? facultyAbbr[1] : nominee.faculty || null;

      const positions = SRC_POSITIONS.map((position) => {
        const verdict = checkPositionEligibility(position, nominee);
        const scoped =
          position === "Faculty/Institute Representative" && verdict.eligible && facultyScope;
        // Reg 2(1)(h) likewise: the Campus Wide Representative sits on this
        // campus's SRC. Standing in another campus's election is already
        // refused on submit (nominee.campus must equal election.campus);
        // this names the campus on the form so the student sees it first.
        const campusScoped =
          position === "Campus Wide Representative" && verdict.eligible && nominee.campus;
        return {
          position,
          label: scoped ? `${position} — ${facultyScope}`
               : campusScoped ? `${position} — ${nominee.campus}`
               : position,
          faculty_scope: scoped ? nominee.faculty : null,
          campus_scope: campusScoped ? nominee.campus : null,
          eligible: verdict.eligible,
          reason: verdict.reasons[0] || null,
        };
      });
      res.json({ success: true, positions, faculty: nominee.faculty || null, campus: nominee.campus || null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load the list of posts" });
    }
  });

  // Nominee's own view, with live endorsement state.
  // GET /api/nominations/student/:userId
  router.get("/nominations/student/:userId", async (req, res) => {
    try {
      const [noms] = await db.execute(
        `SELECT n.*, e.title AS election_title, e.academic_year, e.campus AS election_campus,
                e.polling_date, e.status AS election_status
           FROM nominations n JOIN elections e ON e.id = n.election_id
          WHERE n.student_id=? ORDER BY n.created_at DESC`,
        [req.params.userId]
      );

      for (const n of noms) {
        const [ends] = await db.execute(
          `SELECT ne.endorser_role, ne.status, ne.verification_method, ne.responded_at,
                  ne.decline_reason, u.student_id, u.full_name
             FROM nomination_endorsements ne JOIN users u ON u.id = ne.endorser_user_id
            WHERE ne.nomination_id=? ORDER BY FIELD(ne.endorser_role,'proposer','seconder','supporter_1','supporter_2')`,
          [n.id]
        );
        n.endorsements = ends.map((e) => ({ ...e, label: ENDORSER_LABELS[e.endorser_role] }));
        n.confirmed_count = ends.filter((e) => e.status === "confirmed").length;
        n.can_withdraw = n.status !== "withdrawn" && canWithdraw(n.polling_date).allowed;
      }

      res.json({ success: true, nominations: noms });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load your nominations" });
    }
  });

  // The endorsements this student has GIVEN to other people.
  // GET /api/endorsements/given/:userId
  //
  // "My Nomination History" only ever showed nominations where the
  // student is the nominee, so someone who had proposed a friend saw
  // no trace of it and read their own nomination card as describing
  // that role. These are the other half of the picture.
  router.get("/endorsements/given/:userId", async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT ne.endorser_role, ne.status, ne.responded_at,
                n.id AS nomination_id, n.position, n.status AS nomination_status,
                u.full_name AS nominee_name, u.student_id AS nominee_code,
                e.title AS election_title, e.campus
           FROM nomination_endorsements ne
           JOIN nominations n ON n.id = ne.nomination_id
           JOIN users u ON u.id = n.student_id
           JOIN elections e ON e.id = ne.election_id
          WHERE ne.endorser_user_id = ?
          ORDER BY ne.created_at DESC`,
        [req.params.userId]
      );
      res.json({
        success: true,
        endorsements: rows.map((r) => ({ ...r, label: ENDORSER_LABELS[r.endorser_role] })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load the endorsements you have given" });
    }
  });

  // Reg 21 — withdrawal, but not inside three days of polling day.
  // POST /api/nominations/:nominationId/withdraw  { requested_by }
  router.post("/nominations/:nominationId/withdraw", async (req, res) => {
    try {
      const [[nom]] = await db.execute(
        `SELECT n.*, e.polling_date, e.title, e.status AS election_status
           FROM nominations n JOIN elections e ON e.id=n.election_id WHERE n.id=?`,
        [req.params.nominationId]
      );
      if (!nom) return res.status(404).json({ error: "Nomination not found" });
      if (req.body?.requested_by && Number(req.body.requested_by) !== Number(nom.student_id))
        return res.status(403).json({ error: "Only the nominee can withdraw their own nomination" });
      if (nom.status === "withdrawn") return res.status(400).json({ error: "Already withdrawn" });

      // Once the poll is open the ballot is fixed. Ballots already cast
      // for this candidate are on the blockchain and cannot be undone,
      // so a withdrawal at this point would misrepresent the result.
      if (nom.election_status === "active" || nom.election_status === "ended")
        return res.status(403).json({
          error: "Voting has opened for this election. A candidate cannot be withdrawn from a live ballot — contact the Election Committee.",
        });

      const verdict = canWithdraw(nom.polling_date);
      if (!verdict.allowed) return res.status(403).json({ error: verdict.reasons[0] });

      await db.execute(
        "UPDATE nominations SET status='withdrawn', withdrawn_at=NOW() WHERE id=?", [nom.id]
      );
      await db.execute(
        "UPDATE nomination_endorsements SET status='revoked' WHERE nomination_id=? AND status IN ('invited','confirmed')",
        [nom.id]
      );
      // An approved nomination already has a candidate on the ballot.
      // Withdrawing has to take them off it, or they keep appearing to
      // voters. The on-chain entry cannot be removed — nothing on a
      // blockchain can — but a candidate the ballot no longer offers
      // can no longer be voted for.
      await db.execute(
        "UPDATE candidates SET is_approved=0 WHERE nomination_id=?", [nom.id]
      );
      await logAudit(nom.student_id, "student", nom.election_id, "NOMINATION_WITHDRAWN",
        `Nomination #${nom.id} for ${nom.position} withdrawn`, req.ip);

      res.json({ success: true, message: "Nomination withdrawn. Your endorsers are free to endorse someone else." });
    } catch (err) {
      res.status(500).json({ error: "Could not withdraw the nomination" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  ENDORSER — confirm or decline
  // ═══════════════════════════════════════════════════════════

  // GET /api/endorsements/pending/:userId
  router.get("/endorsements/pending/:userId", async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT ne.id, ne.endorser_role, ne.status, ne.responded_at, ne.verification_method,
                n.id AS nomination_id, n.position, n.manifesto, n.status AS nomination_status,
                e.title AS election_title, e.campus, e.academic_year, e.nomination_end,
                nu.full_name AS nominee_name, nu.student_id AS nominee_code, nu.faculty AS nominee_faculty
           FROM nomination_endorsements ne
           JOIN nominations n ON n.id = ne.nomination_id
           JOIN elections e  ON e.id = ne.election_id
           JOIN users nu     ON nu.id = n.student_id
          WHERE ne.endorser_user_id=? AND ne.status IN ('invited','confirmed','declined')
          ORDER BY FIELD(ne.status,'invited','confirmed','declined'), ne.created_at DESC`,
        [req.params.userId]
      );
      res.json({
        success: true,
        requests: rows.map((r) => ({ ...r, label: ENDORSER_LABELS[r.endorser_role] })),
        pending_count: rows.filter((r) => r.status === "invited").length,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load your endorsement requests" });
    }
  });

  // Ask for the exact text to sign.
  // POST /api/endorsements/:id/nonce   { user_id }
  router.post("/endorsements/:id/nonce", async (req, res) => {
    try {
      const [[row]] = await db.execute(
        `SELECT ne.*, n.position, e.title AS election_title, e.campus,
                nu.full_name AS nominee_name, nu.student_id AS nominee_code,
                eu.full_name AS endorser_name, eu.student_id AS endorser_code, eu.wallet_address
           FROM nomination_endorsements ne
           JOIN nominations n ON n.id = ne.nomination_id
           JOIN elections e  ON e.id = ne.election_id
           JOIN users nu     ON nu.id = n.student_id
           JOIN users eu     ON eu.id = ne.endorser_user_id
          WHERE ne.id=?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ error: "Endorsement request not found" });
      if (req.body?.user_id && Number(req.body.user_id) !== Number(row.endorser_user_id))
        return res.status(403).json({ error: "This endorsement request belongs to another student" });
      if (row.status !== "invited") return res.status(400).json({ error: "This request has already been answered" });
      if (!row.wallet_address)
        return res.status(400).json({
          error: "You have no verified wallet yet. Link one on your profile page, or confirm with your password instead.",
        });

      const { nonce, message, expiresAt } = await issueNonce(db, {
        purpose: "endorsement",
        studentId: row.endorser_code,
        walletAddress: row.wallet_address,
        contextId: row.id,
        buildMessage: ({ nonce, issuedAt }) =>
          endorsementMessage({
            endorserName: row.endorser_name, endorserStudentId: row.endorser_code,
            roleLabel: ENDORSER_LABELS[row.endorser_role],
            nomineeName: row.nominee_name, nomineeStudentId: row.nominee_code,
            position: row.position, electionTitle: row.election_title, campus: row.campus,
            nonce, issuedAt,
          }),
      });

      res.json({ success: true, nonce, message, expiresAt, wallet_address: row.wallet_address });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not prepare the endorsement" });
    }
  });

  // POST /api/endorsements/:id/confirm
  // { user_id, method:'wallet_signature'|'password', nonce?, signature?, password? }
  router.post("/endorsements/:id/confirm", async (req, res) => {
    const { user_id, method, nonce, signature, password } = req.body;
    try {
      const [[row]] = await db.execute(
        `SELECT ne.*, n.status AS nomination_status, n.position AS nom_position,
                eu.student_id AS endorser_code, eu.password_hash, eu.wallet_address,
                e.status AS election_status
           FROM nomination_endorsements ne
           JOIN nominations n ON n.id = ne.nomination_id
           JOIN elections e  ON e.id = ne.election_id
           JOIN users eu     ON eu.id = ne.endorser_user_id
          WHERE ne.id=?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ error: "Endorsement request not found" });
      if (user_id && Number(user_id) !== Number(row.endorser_user_id))
        return res.status(403).json({ error: "This endorsement request belongs to another student" });
      if (row.status !== "invited") return res.status(400).json({ error: "This request has already been answered" });
      if (row.election_status !== "nomination")
        return res.status(403).json({ error: "The nomination period has closed" });

      let verification = null, signedMessage = null, usedSignature = null, wallet = null;

      if (method === "password") {
        // Fallback for a student with no wallet yet. Weaker than a
        // signature, so it is recorded as such for the EC to see.
        if (!password) return res.status(400).json({ error: "Enter your password to confirm" });
        const ok = await bcrypt.compare(password, row.password_hash);
        if (!ok) return res.status(401).json({ error: "Incorrect password" });
        verification = "password";
      } else {
        const verdict = await verifySignedNonce(db, {
          nonce, signature, purpose: "endorsement", studentId: row.endorser_code,
          expectedAddress: row.wallet_address,
        });
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });
        verification = "wallet_signature";
        signedMessage = verdict.message;
        usedSignature = signature;
        wallet = verdict.address;
      }

      await db.execute(
        `UPDATE nomination_endorsements
            SET status='confirmed', verification_method=?, wallet_address=?, signed_message=?,
                signature=?, ip_address=?, responded_at=NOW()
          WHERE id=?`,
        [verification, wallet, signedMessage, usedSignature, req.ip, row.id]
      );

      // All four in? Then the nomination goes to the EC.
      const [[tally]] = await db.execute(
        `SELECT SUM(status='confirmed') AS confirmed, COUNT(*) AS total
           FROM nomination_endorsements WHERE nomination_id=?`,
        [row.nomination_id]
      );
      const complete = Number(tally.confirmed) === 4 && Number(tally.total) === 4;
      if (complete) {
        await db.execute(
          "UPDATE nominations SET status='pending', endorsements_completed_at=NOW() WHERE id=? AND status='awaiting_endorsement'",
          [row.nomination_id]
        );
      }

      await logAudit(row.endorser_user_id, "student", row.election_id, "ENDORSEMENT_CONFIRMED",
        `${row.endorser_code} confirmed as ${ENDORSER_LABELS[row.endorser_role]} for nomination #${row.nomination_id} (${verification})`,
        req.ip);

      res.json({
        success: true,
        complete,
        confirmed: Number(tally.confirmed),
        message: complete
          ? "Endorsement confirmed. All four are in, so the nomination has gone to the Election Committee."
          : `Endorsement confirmed. ${4 - Number(tally.confirmed)} more to go.`,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not confirm the endorsement" });
    }
  });

  // POST /api/endorsements/:id/decline   { user_id, reason }
  router.post("/endorsements/:id/decline", async (req, res) => {
    try {
      const [[row]] = await db.execute(
        `SELECT ne.*, eu.student_id AS endorser_code FROM nomination_endorsements ne
           JOIN users eu ON eu.id = ne.endorser_user_id WHERE ne.id=?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ error: "Endorsement request not found" });
      if (req.body?.user_id && Number(req.body.user_id) !== Number(row.endorser_user_id))
        return res.status(403).json({ error: "This endorsement request belongs to another student" });
      if (row.status !== "invited") return res.status(400).json({ error: "This request has already been answered" });

      await db.execute(
        "UPDATE nomination_endorsements SET status='declined', decline_reason=?, ip_address=?, responded_at=NOW() WHERE id=?",
        [req.body?.reason || null, req.ip, row.id]
      );
      await logAudit(row.endorser_user_id, "student", row.election_id, "ENDORSEMENT_DECLINED",
        `${row.endorser_code} declined to act as ${ENDORSER_LABELS[row.endorser_role]} for nomination #${row.nomination_id}`,
        req.ip);

      res.json({ success: true, message: "Declined. The nominee can now ask someone else." });
    } catch (err) {
      res.status(500).json({ error: "Could not record your response" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  EC — review, with the endorsement evidence attached
  // ═══════════════════════════════════════════════════════════

  // GET /api/ec/elections/:electionId/nominations?status=&search=
  router.get("/ec/elections/:electionId/nominations", async (req, res) => {
    const { electionId } = req.params;
    const { status, search } = req.query;
    try {
      let sql = `SELECT n.*, u.full_name AS student_name, u.student_id AS student_code,
                        u.faculty AS student_faculty, u.email AS student_email, u.campus AS student_campus
                   FROM nominations n JOIN users u ON u.id = n.student_id
                  WHERE n.election_id=?`;
      const params = [electionId];
      if (status) { sql += " AND n.status=?"; params.push(status); }
      if (search) {
        sql += " AND (u.full_name LIKE ? OR u.student_id LIKE ? OR n.position LIKE ?)";
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      sql += " ORDER BY FIELD(n.status,'pending','awaiting_endorsement','approved','rejected','withdrawn'), n.created_at ASC";
      const [rows] = await db.execute(sql, params);

      for (const n of rows) {
        const [ends] = await db.execute(
          `SELECT ne.endorser_role, ne.status, ne.verification_method, ne.responded_at,
                  ne.signature, ne.wallet_address, ne.decline_reason, ne.ip_address,
                  u.student_id, u.full_name, u.campus, u.faculty
             FROM nomination_endorsements ne JOIN users u ON u.id = ne.endorser_user_id
            WHERE ne.nomination_id=?
            ORDER BY FIELD(ne.endorser_role,'proposer','seconder','supporter_1','supporter_2')`,
          [n.id]
        );
        n.endorsements = ends.map((e) => ({
          ...e,
          label: ENDORSER_LABELS[e.endorser_role],
          signature_short: e.signature ? `${e.signature.slice(0, 12)}…${e.signature.slice(-8)}` : null,
        }));
        n.confirmed_count = ends.filter((e) => e.status === "confirmed").length;
        n.endorsement_complete = n.confirmed_count === 4;
      }

      res.json({ success: true, nominations: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not fetch nominations" });
    }
  });

  // Approve → write the candidate to the blockchain.
  // POST /api/ec/nominations/:nominationId/approve
  router.post("/ec/nominations/:nominationId/approve", async (req, res) => {
    const { nominationId } = req.params;
    try {
      const [[nom]] = await db.execute(
        `SELECT n.*, u.full_name, u.faculty, u.student_id AS student_code
           FROM nominations n JOIN users u ON u.id = n.student_id WHERE n.id=?`,
        [nominationId]
      );
      if (!nom) return res.status(404).json({ error: "Nomination not found" });
      if (nom.status !== "pending")
        return res.status(400).json({
          error: nom.status === "awaiting_endorsement"
            ? "This nomination is still waiting for its endorsers to confirm"
            : "This nomination has already been reviewed",
        });

      // The Reg 20(1) guard. Even if a nomination somehow reached
      // 'pending' another way, it cannot become a candidate without
      // four confirmed endorsements.
      const [[tally]] = await db.execute(
        "SELECT SUM(status='confirmed') AS confirmed FROM nomination_endorsements WHERE nomination_id=?",
        [nominationId]
      );
      if (Number(tally.confirmed) !== 4)
        return res.status(403).json({
          error: `Reg 20(1) requires one proposer, one seconder and two supporters. Only ${Number(tally.confirmed)} of 4 have confirmed.`,
        });

      const [[election]] = await db.execute("SELECT * FROM elections WHERE id=?", [nom.election_id]);
      if (election.status === "active" || election.status === "ended")
        return res.status(403).json({ error: "Voting has started — the candidate list is closed" });

      let blockchainId = null;
      const contract = getContract();
      if (contract) {
        const tx = await contract.addCandidate(election.blockchain_id, nom.full_name, nom.faculty, nom.position);
        const receipt = await tx.wait();
        const evt = receipt.logs
          .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
          .find((e) => e?.name === "CandidateAdded");
        blockchainId = evt ? Number(evt.args.candidateId) : null;
      }

      await db.execute(
        `INSERT INTO candidates (election_id, nomination_id, blockchain_id, full_name, faculty, position, manifesto, is_approved)
         VALUES (?,?,?,?,?,?,?,1)`,
        [nom.election_id, nominationId, blockchainId, nom.full_name, nom.faculty, nom.position, nom.manifesto || null]
      );
      await db.execute("UPDATE nominations SET status='approved', reviewed_at=NOW() WHERE id=?", [nominationId]);

      await logAudit(null, "election_committee", nom.election_id, "NOMINATION_APPROVED",
        `Approved ${nom.student_code} for ${nom.position} with 4 confirmed endorsements`, req.ip);

      res.json({
        success: true,
        message: `${nom.full_name} approved and added to the blockchain`,
        blockchainId,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: describeContractError(err, "Could not approve the nomination") });
    }
  });

  return router;
};
