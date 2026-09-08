// backend/lib/eligibility.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Regulation XIII, encoded once and reused everywhere.
//
//  Every place that needs to ask "may this person vote?" or
//  "may this person stand or endorse?" calls into here, so the
//  registration page, the nomination form, the endorsement
//  confirmation and the EC panel can never drift apart.
//
//  References are to the Student Representative Council
//  Regulations (Regulation XIII) and the SRC Election 2026/2027
//  Nomination Notice issued by the Department of Student Affairs.
// ─────────────────────────────────────────────────────────────

const CAMPUSES = ["Kampar", "Sungai Long"];

// Reg 2(1) — the posts that make up each campus SRC.
const SRC_POSITIONS = [
  "Chairperson",
  "Vice Chairperson",
  "Secretary",
  "Treasurer",
  "Auditor 1",
  "Auditor 2",
  "Faculty/Institute Representative",
  "Campus Wide Representative",
  "International Representative",
  "Postgraduate Representative",
];

// Reg 20(1) — one proposer, one seconder and two supporters.
const ENDORSER_ROLES = ["proposer", "seconder", "supporter_1", "supporter_2"];

const ENDORSER_LABELS = {
  proposer: "Proposer",
  seconder: "Seconder",
  supporter_1: "Supporter 1",
  supporter_2: "Supporter 2",
};

/**
 * Reg 14(1) — eligibility to vote.
 * All registered full-time foundation, undergraduate and
 * postgraduate students may vote, except students on leave of
 * absence and students on Distance Learning / External
 * Programmes.
 *
 * @param {object} roster row from student_roster
 * @returns {{eligible:boolean, reasons:string[]}}
 */
function checkVoterEligibility(roster) {
  const reasons = [];
  if (!roster) {
    return { eligible: false, reasons: ["Not found in the official student roster"] };
  }
  if (!roster.is_enrolled) {
    reasons.push("Not currently an enrolled student");
  }
  if (roster.on_leave) {
    reasons.push("Reg 14(1)(a): currently on leave of absence");
  }
  if (roster.delivery_mode !== "on_campus") {
    reasons.push("Reg 14(1)(b): pursuing a Distance Learning or External Programme");
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Reg 4 — eligibility for SRC membership and for nomination.
 * A nominee must first satisfy Reg 14 (they must be a voter),
 * then clear the additional bars in Reg 4(a)–(j).
 *
 * @param {object} roster row from student_roster
 * @returns {{eligible:boolean, reasons:string[]}}
 */
function checkNomineeEligibility(roster) {
  const voter = checkVoterEligibility(roster);
  const reasons = [...voter.reasons];
  if (!roster) return { eligible: false, reasons };

  // Reg 4(b) — has not yet sat for the first University examination.
  if (!roster.sat_first_exam) {
    reasons.push("Reg 4(b): has not sat for the first examination in the University");
  }
  // Reg 4(c) — must have more than two long trimesters remaining.
  if (Number(roster.trimesters_left) <= 2) {
    reasons.push("Reg 4(c): two or fewer long trimesters remain to complete the programme");
  }
  // Reg 4(e)
  if (roster.academic_probation) {
    reasons.push("Reg 4(e): currently on academic probation");
  }
  // Reg 4(f) — no President's waiver is available for this one.
  if (roster.criminal_offence) {
    reasons.push("Reg 4(f): has committed a criminal offence");
  }
  // Reg 4(g)/(gg)/(h)/(i) — waivable in writing by the President.
  if (roster.disciplinary_guilty && !roster.president_waiver) {
    reasons.push("Reg 4(g): found guilty of a disciplinary offence (no written approval from the President on file)");
  }
  if (roster.disciplinary_open && !roster.president_waiver) {
    reasons.push("Reg 4(h): undergoing disciplinary proceedings (no written approval from the President on file)");
  }
  if (roster.fees_in_arrears && !roster.president_waiver) {
    reasons.push("Reg 4(i): in arrears of fees (no written approval from the President on file)");
  }
  // Reg 4(j)
  if (roster.deemed_unfit) {
    reasons.push(`Reg 4(j): deemed unfit by the University${roster.unfit_reason ? ` — ${roster.unfit_reason}` : ""}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Reg 14(2) — only certain students may contest or vote for
 * certain posts. Used to keep, for example, a local student out
 * of the International Representative race.
 */
function checkPositionEligibility(position, profile) {
  const reasons = [];
  if (position === "International Representative" && !profile.is_international) {
    reasons.push("Reg 2(1)(g): only international students may hold the International Representative post");
  }
  if (position === "Postgraduate Representative" && profile.study_level !== "postgraduate") {
    reasons.push("Reg 2(1)(n): only postgraduate students may hold the Postgraduate Representative post");
  }
  if (position === "Faculty/Institute Representative" && profile.study_level === "foundation") {
    reasons.push("Reg 14(2)(f): foundation students are not eligible for the Faculty/Institute Representative post");
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Reg 21 — "Withdrawal by the nominee within three (3) days
 * from the polling day shall not be allowed."
 */
function canWithdraw(pollingDate, now = new Date()) {
  if (!pollingDate) return { allowed: true, reasons: [] };
  const polling = new Date(pollingDate);
  const cutoff = new Date(polling.getTime() - 3 * 86400000);
  if (now >= cutoff) {
    return {
      allowed: false,
      reasons: [`Reg 21: withdrawal closed on ${cutoff.toLocaleString("en-MY")}, within three days of polling day`],
    };
  }
  return { allowed: true, reasons: [] };
}

/**
 * Reg 25 — campaigning runs for three days before polling day
 * and is prohibited on nomination day and polling day.
 */
function campaignWindow(pollingDate) {
  if (!pollingDate) return null;
  const polling = new Date(pollingDate);
  return {
    opens: new Date(polling.getTime() - 3 * 86400000),
    closes: new Date(polling.getTime() - 86400000),
  };
}

/** Normalise a MySQL TINYINT(1) or JS truthy value to a boolean. */
function flag(v) {
  return v === 1 || v === true || v === "1";
}

/** Coerce a roster row's TINYINT columns into real booleans. */
function normaliseRoster(row) {
  if (!row) return null;
  return {
    ...row,
    is_enrolled: flag(row.is_enrolled),
    sat_first_exam: flag(row.sat_first_exam),
    on_leave: flag(row.on_leave),
    academic_probation: flag(row.academic_probation),
    criminal_offence: flag(row.criminal_offence),
    disciplinary_guilty: flag(row.disciplinary_guilty),
    disciplinary_open: flag(row.disciplinary_open),
    fees_in_arrears: flag(row.fees_in_arrears),
    president_waiver: flag(row.president_waiver),
    deemed_unfit: flag(row.deemed_unfit),
    is_international: flag(row.is_international),
  };
}

module.exports = {
  CAMPUSES,
  SRC_POSITIONS,
  ENDORSER_ROLES,
  ENDORSER_LABELS,
  checkVoterEligibility,
  checkNomineeEligibility,
  checkPositionEligibility,
  canWithdraw,
  campaignWindow,
  normaliseRoster,
};
