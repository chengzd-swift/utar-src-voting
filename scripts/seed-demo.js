// scripts/seed-demo.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Puts the system into a known state for a live walkthrough, so a
//  15-minute demo never spends its time creating test data.
//
//    node scripts/seed-demo.js            add / refresh the demo data
//    node scripts/seed-demo.js --reset    clear it all first
//
//  What it leaves behind, and why each piece is there:
//
//    • The full 22-row DSA test roster, one row per regulation in
//      Reg 4 and Reg 14(1) — including the pair (2205002 / 2205003)
//      that differs only by the President's waiver, and 2205008 whose
//      waiver deliberately does NOT clear a criminal offence.
//    • Student accounts for the demo cast, wallets already proved.
//    • Both campus elections, so the Kampar / Sungai Long split is
//      visible from the first click.
//    • A Kampar election with three approved candidates already on
//      chain and every eligible voter registered — enough to open
//      voting immediately, which the contract will not allow with
//      fewer than two candidates.
//    • One student left awaiting approval, so Pending Approvals is
//      not an empty screen.
//
//  Voting is signed by the student's own MetaMask, so the demo
//  wallets are derived from a throwaway test mnemonic and funded from
//  the admin account. The script prints the keys to import.
// ─────────────────────────────────────────────────────────────
require("dotenv").config();
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RESET = process.argv.includes("--reset");
const SALT = 10;
const BATCH = "demo-seed · DSA export";

// A publicly known test mnemonic. Never use it for anything real —
// these keys exist so a demo wallet can be imported into MetaMask in
// one paste, on a local Ganache chain holding no value.
const DEMO_MNEMONIC = "test test test test test test test test test test test junk";

// ── The roster, one row per rule worth demonstrating ──────────
const R = (student_id, full_name, campus, study_level, over = {}) => ({
  student_id, full_name, campus, study_level,
  email: `${student_id}@1utar.my`,
  faculty: over.faculty || "Faculty of Information and Communication Technology (FICT)",
  is_international: 0, delivery_mode: "on_campus", sat_first_exam: 1,
  trimesters_left: 4, on_leave: 0, academic_probation: 0, criminal_offence: 0,
  disciplinary_guilty: 0, disciplinary_open: 0, fees_in_arrears: 0,
  president_waiver: 0, deemed_unfit: 0, unfit_reason: null, is_enrolled: 1,
  ...over,
});

const ROSTER = [
  // Clean — the cast of the walkthrough
  R("2207492", "Cheng Zheng De", "Kampar", "undergraduate", { trimesters_left: 3 }),
  R("2207001", "Lee Wei Ming", "Kampar", "undergraduate", { faculty: "Faculty of Engineering and Green Technology (FEGT)" }),
  R("2207002", "Tan Mei Ling", "Kampar", "undergraduate", { faculty: "Teh Hong Piow Faculty of Business and Finance (THP FBF)" }),
  R("2207003", "Ahmad Fariz", "Kampar", "undergraduate", { faculty: "Faculty of Science (FSC)", trimesters_left: 5 }),
  R("2300123", "Nur Aisyah Binti Rahman", "Kampar", "undergraduate", { trimesters_left: 5 }),
  // Campus + post scoping
  R("2400555", "Wong Jia Hui", "Sungai Long", "undergraduate", { faculty: "Teh Hong Piow Faculty of Business and Finance (THP FBF)" }),
  R("2300456", "Kavitha A/P Ramesh", "Kampar", "postgraduate"),
  R("2300789", "Nguyen Van Minh", "Kampar", "undergraduate", { is_international: 1 }),
  R("2400001", "Chong Yee Sen", "Kampar", "foundation", { faculty: "Foundation in Science", trimesters_left: 3 }),
  // Reg 4 — may vote, may not stand
  R("2205001", "Sim Hui Ying", "Kampar", "undergraduate", { trimesters_left: 2 }),                       // 4(c)
  R("2205002", "Danish Haziq", "Kampar", "undergraduate", { fees_in_arrears: 1, trimesters_left: 5 }),   // 4(i)
  R("2205003", "Yap Kar Mun", "Kampar", "undergraduate", { fees_in_arrears: 1, president_waiver: 1, trimesters_left: 5 }), // 4(i) waived
  R("2205004", "Lim Zhi Hao", "Kampar", "undergraduate", { academic_probation: 1 }),                     // 4(e)
  R("2205005", "Farah Nadia", "Kampar", "undergraduate", { sat_first_exam: 0, trimesters_left: 6 }),     // 4(b)
  R("2205006", "Tan Jun Kai", "Kampar", "undergraduate", { disciplinary_open: 1 }),                      // 4(h)
  R("2205007", "Priya A/P Selvam", "Kampar", "undergraduate", { disciplinary_guilty: 1 }),               // 4(g)
  R("2205008", "Muhammad Irfan", "Kampar", "undergraduate", { criminal_offence: 1, president_waiver: 1 }), // 4(f) — waiver does not clear it
  R("2205009", "Ooi Shu Wen", "Kampar", "undergraduate", { deemed_unfit: 1, unfit_reason: "Pending University review" }), // 4(j)
  // Reg 14(1) — may not even vote
  R("2205010", "Goh Wei Xuan", "Kampar", "undergraduate", { on_leave: 1 }),                              // 14(1)(a)
  R("2205011", "Rachel Lau", "Kampar", "undergraduate", { delivery_mode: "distance_learning" }),         // 14(1)(b)
  R("2205012", "Hafiz Rahman", "Kampar", "undergraduate", { delivery_mode: "external" }),                // 14(1)(b)
  R("2205013", "Cheah Li Ping", "Kampar", "undergraduate", { is_enrolled: 0 }),                          // not enrolled
];

// Accounts to create. 2300123 is deliberately left out so the fresh
// sign-up route has something to demonstrate; 2400001 is left pending
// so Pending Approvals is not empty.
const ACCOUNTS = [
  { id: "2207492", wallet: 0, approved: 1 },
  { id: "2207001", wallet: 1, approved: 1 },
  { id: "2207002", wallet: 2, approved: 1 },
  { id: "2207003", wallet: 3, approved: 1 },
  { id: "2300456", wallet: 4, approved: 1 },   // postgraduate
  { id: "2300789", wallet: 5, approved: 1 },   // international
  { id: "2205001", wallet: 6, approved: 1 },   // can vote, cannot stand
  { id: "2400555", wallet: 7, approved: 1 },   // Sungai Long
  { id: "2400001", wallet: 8, approved: 0 },   // waiting in Pending Approvals
  // Reg 20(3) allows a student to endorse only one nominee per post, so
  // a contested Chairperson race needs eight distinct endorsers. These
  // four make up the difference — all may vote, which is all an
  // endorser has to be under Reg 20(2).
  { id: "2205002", wallet: 9,  approved: 1 },
  { id: "2205003", wallet: 10, approved: 1 },
  { id: "2205004", wallet: 11, approved: 1 },
  { id: "2205006", wallet: 12, approved: 1 },
];

// A contested Chairperson race plus a Secretary, which also satisfies
// the contract's "at least 2 candidates" rule before voting opens.
// Each nominee carries its own four endorsers: reusing them across two
// nominees for the SAME post is exactly what Reg 20(3) forbids, and the
// database rejects it. Across different posts they may serve again.
const CANDIDATES = [
  { id: "2207492", position: "Chairperson", endorsers: ["2207003", "2205001", "2300456", "2300789"],
    manifesto: "Extend library hours and publish a transparent SRC budget every trimester." },
  { id: "2207001", position: "Chairperson", endorsers: ["2207002", "2205002", "2205003", "2205004"],
    manifesto: "Better shuttle coverage between campus and Westlake, and faster hostel repairs." },
  { id: "2207002", position: "Secretary",   endorsers: ["2207003", "2205001", "2300456", "2300789"],
    manifesto: "Publish every SRC minute within 48 hours of each meeting." },
];

const log = (...a) => console.log(...a);

// Shared nonce counter for every transaction the admin key sends.
let nonce = 0;
/** Send one contract call with an explicit nonce, and wait for it. */
async function tx(contract, method, args) {
  const sent = await contract[method](...args, { nonce: nonce++ });
  return sent.wait();
}

async function main() {
  const db = await mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "utar_src_voting",
    connectionLimit: 5,
  });

  // ── Chain ────────────────────────────────────────────────
  let contract = null, provider = null, admin = null;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, "../backend/contract.json"), "utf8"));
    provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:7545");
    // Ganache mines instantly, but ethers waits 4 seconds between polls
    // by default. Across the ~15 transactions below that is minutes of
    // doing nothing, so poll far more often on a local chain.
    provider.pollingInterval = 150;
    admin = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
    if ((await provider.getCode(info.address)) === "0x")
      throw new Error(`no contract at ${info.address} — redeploy first`);
    contract = new ethers.Contract(info.address, info.abi, admin);
    log(`⛓️  Chain ready — contract ${info.address}`);
  } catch (e) {
    log(`⚠️  Blockchain unavailable (${e.message}). Seeding the database only;`);
    log("    candidates and voters will not be written on chain, so voting cannot be opened.");
  }

  if (RESET) {
    log("\n🧹 Clearing previous demo data…");
    // Ballots are not in this list because they are not in this
    // database — they only ever exist on chain, which is the point.
    for (const t of ["nomination_endorsements", "nominations", "candidates",
                     "voter_registrations", "profile_change_requests", "elections", "student_roster"]) {
      await db.query(`DELETE FROM \`${t}\``).catch((e) => log(`   (skipped ${t}: ${e.code})`));
    }
    await db.query("DELETE FROM users WHERE role='student'");
    log("   database cleared — the chain keeps its own history, which is the point of it");
  }

  // ── 1. Roster ────────────────────────────────────────────
  for (const s of ROSTER) {
    await db.query(
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
      [s.student_id, s.full_name, s.email, s.faculty, s.campus, s.study_level, s.is_international,
       s.delivery_mode, s.sat_first_exam, s.trimesters_left, s.on_leave, s.academic_probation,
       s.criminal_offence, s.disciplinary_guilty, s.disciplinary_open, s.fees_in_arrears,
       s.president_waiver, s.deemed_unfit, s.unfit_reason, s.is_enrolled, BATCH]
    );
  }
  log(`\n📇 Roster: ${ROSTER.length} students imported as "${BATCH}"`);

  // ── 2. Wallets, funded so they can pay for their own vote ─
  const wallets = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    wallets.push(ethers.HDNodeWallet.fromPhrase(DEMO_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`));
  }
  if (provider) {
    // Every admin transaction below takes its nonce from this counter.
    // Left to ethers, each send reads the account's nonce fresh, and
    // anything else touching the admin key at the same time (a second
    // copy of this script, the running server) produces "the tx
    // doesn't have the correct nonce" half way through a seed.
    nonce = await provider.getTransactionCount(admin.address, "pending");
    let funded = 0;
    for (const w of wallets) {
      if ((await provider.getBalance(w.address)) >= ethers.parseEther("0.5")) continue;
      const tx = await admin.sendTransaction({
        to: w.address, value: ethers.parseEther("2"), nonce: nonce++,
      });
      await tx.wait();
      funded++;
    }
    log(`💰 Wallets: ${funded} funded with 2 ETH${funded < wallets.length ? `, ${wallets.length - funded} already had gas` : ""}`);
  }

  // ── 3. Student accounts ──────────────────────────────────
  const pw = await bcrypt.hash("Student1", SALT);
  const userIdOf = {};
  for (const a of ACCOUNTS) {
    const s = ROSTER.find((r) => r.student_id === a.id);
    const w = wallets[a.wallet];
    await db.query(
      `INSERT INTO users
         (student_id, full_name, email, faculty, campus, study_level, is_international,
          password_hash, role, is_active, is_approved, roster_matched, approval_note,
          wallet_address, wallet_verified_at, must_change_pw)
       VALUES (?,?,?,?,?,?,?,?,'student',1,?,?,?,?,?,0)
       ON DUPLICATE KEY UPDATE
         full_name=VALUES(full_name), faculty=VALUES(faculty), campus=VALUES(campus),
         study_level=VALUES(study_level), is_international=VALUES(is_international),
         is_approved=VALUES(is_approved), roster_matched=VALUES(roster_matched),
         wallet_address=VALUES(wallet_address), wallet_verified_at=VALUES(wallet_verified_at)`,
      [s.student_id, s.full_name, s.email, s.faculty, s.campus, s.study_level, s.is_international,
       pw, a.approved, a.approved ? 1 : 0,
       a.approved ? "Auto-verified against the DSA student roster" : "Awaiting Election Committee review",
       a.approved ? w.address : null, a.approved ? new Date() : null]
    );
    const [[row]] = await db.query("SELECT id FROM users WHERE student_id=?", [s.student_id]);
    userIdOf[a.id] = row.id;
  }
  log(`👥 Accounts: ${ACCOUNTS.filter(a => a.approved).length} approved, ` +
      `${ACCOUNTS.filter(a => !a.approved).length} left pending (password: Student1)`);

  // ── 4. Elections, one per campus ─────────────────────────
  async function election(title, year, campus, status) {
    const [[found]] = await db.query(
      "SELECT * FROM elections WHERE title=? AND campus=?", [title, campus]
    );
    if (found) return found;
    let bcId = null;
    if (contract) {
      const rc = await tx(contract, "createElection", [`${title} — ${campus}`]);
      const evt = rc.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
                         .find((e) => e?.name === "ElectionCreated");
      bcId = evt ? Number(evt.args.electionId) : null;
    }
    const polling = new Date(Date.now() + 7 * 86400000);
    const [ins] = await db.query(
      `INSERT INTO elections (blockchain_id,title,academic_year,campus,polling_date,description,status,nomination_end)
       VALUES (?,?,?,?,?,?,?,?)`,
      [bcId, title, year, campus, polling, `${campus} Campus SRC election`, status,
       new Date(Date.now() + 3 * 86400000)]
    );
    const [[fresh]] = await db.query("SELECT * FROM elections WHERE id=?", [ins.insertId]);
    return fresh;
  }

  const kampar = await election("SRC Election 2026/2027", "2026/2027", "Kampar", "nomination");
  const sl     = await election("SRC Election 2026/2027", "2026/2027", "Sungai Long", "nomination");
  log(`🗳️  Elections: Kampar #${kampar.id} (chain ${kampar.blockchain_id}), ` +
      `Sungai Long #${sl.id} (chain ${sl.blockchain_id})`);

  // ── 5. Nominations → endorsed → approved candidates ──────
  // Each step checks for its own result first, so a run interrupted
  // part way through (a chain hiccup, a duplicate) can simply be run
  // again and will fill in only what is missing.
  const ROLES = ["proposer", "seconder", "supporter_1", "supporter_2"];
  for (const c of CANDIDATES) {
    const s = ROSTER.find((r) => r.student_id === c.id);

    let [[nom]] = await db.query(
      "SELECT id FROM nominations WHERE election_id=? AND student_id=? AND position=?",
      [kampar.id, userIdOf[c.id], c.position]
    );
    if (!nom) {
      const [ins] = await db.query(
        `INSERT INTO nominations (election_id, student_id, position, campus, manifesto,
                                  status, endorsements_completed_at, reviewed_at)
         VALUES (?,?,?,?,?, 'approved', NOW(), NOW())`,
        [kampar.id, userIdOf[c.id], c.position, "Kampar", c.manifesto]
      );
      nom = { id: ins.insertId };
    }

    // All four confirmed, as Reg 20(1) requires before the EC may review.
    //
    // Reg 20(3) — nobody may endorse two nominees for the same post — is
    // enforced by a unique index, and an INSERT IGNORE here would hide
    // that collision and quietly leave a nomination with three
    // endorsers, which the EC could then never approve. So each insert
    // is checked, and a clash is reported rather than swallowed.
    const [taken] = await db.query(
      `SELECT endorser_user_id FROM nomination_endorsements
        WHERE election_id=? AND position=? AND nomination_id<>?`,
      [kampar.id, c.position, nom.id]
    );
    const usedElsewhere = new Set(taken.map((t) => t.endorser_user_id));

    for (let i = 0; i < ROLES.length; i++) {
      const endorser = c.endorsers[i];
      const [[have]] = await db.query(
        "SELECT id FROM nomination_endorsements WHERE nomination_id=? AND endorser_role=?",
        [nom.id, ROLES[i]]
      );
      if (have) continue;
      if (usedElsewhere.has(userIdOf[endorser]))
        throw new Error(
          `${endorser} is already endorsing another nominee for ${c.position} (Reg 20(3)). ` +
          `Pick a different ${ROLES[i]} for ${c.id} in CANDIDATES, or run with --reset.`
        );
      await db.query(
        `INSERT INTO nomination_endorsements
           (nomination_id, election_id, position, endorser_user_id, endorser_role,
            status, verification_method, wallet_address, responded_at)
         VALUES (?,?,?,?,?, 'confirmed', 'wallet_signature', ?, NOW())`,
        [nom.id, kampar.id, c.position, userIdOf[endorser], ROLES[i],
         wallets[ACCOUNTS.findIndex((a) => a.id === endorser)].address]
      );
      usedElsewhere.add(userIdOf[endorser]);
    }

    // Reg 20(1) again: four confirmed, or this nomination has no
    // business becoming a candidate.
    const [[tally]] = await db.query(
      "SELECT SUM(status='confirmed') c FROM nomination_endorsements WHERE nomination_id=?", [nom.id]
    );
    if (Number(tally.c) !== 4)
      throw new Error(`Nomination ${nom.id} (${c.id} for ${c.position}) has ${tally.c}/4 confirmed endorsements.`);

    const [[already]] = await db.query(
      "SELECT id FROM candidates WHERE election_id=? AND nomination_id=?", [kampar.id, nom.id]
    );
    if (already) continue;

    let bcId = null;
    if (contract) {
      const rc = await tx(contract, "addCandidate", [kampar.blockchain_id, s.full_name, s.faculty, c.position]);
      const evt = rc.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
                         .find((e) => e?.name === "CandidateAdded");
      bcId = evt ? Number(evt.args.candidateId) : null;
    }
    await db.query(
      `INSERT INTO candidates (election_id, nomination_id, blockchain_id, full_name, faculty,
                               position, manifesto, is_approved)
       VALUES (?,?,?,?,?,?,?,1)`,
      [kampar.id, nom.id, bcId, s.full_name, s.faculty, c.position, c.manifesto]
    );
  }
  const [[cc]] = await db.query(
    "SELECT COUNT(*) n FROM candidates WHERE election_id=? AND is_approved=1", [kampar.id]
  );
  log(`🧑‍⚖️  Candidates: ${cc.n} approved for Kampar (the contract needs 2 to open voting)`);

  // ── 6. Register the Kampar voters on chain ───────────────
  const [eligible] = await db.query(
    `SELECT u.id, u.wallet_address FROM users u
       JOIN student_roster r ON r.student_id = u.student_id
      WHERE u.role='student' AND u.is_approved=1 AND u.campus='Kampar'
        AND u.wallet_verified_at IS NOT NULL
        AND r.is_enrolled=1 AND r.on_leave=0 AND r.delivery_mode='on_campus'`
  );
  for (const v of eligible) {
    await db.query(
      `INSERT INTO voter_registrations (election_id, user_id, wallet_address, status)
       VALUES (?,?,?, 'queued')
       ON DUPLICATE KEY UPDATE wallet_address=VALUES(wallet_address)`,
      [kampar.id, v.id, v.wallet_address]
    ).catch(() => {});
  }
  if (contract && eligible.length) {
    const rc = await tx(contract, "registerVotersBatch", [kampar.blockchain_id, eligible.map((v) => v.wallet_address)]);
    await db.query(
      "UPDATE voter_registrations SET status='registered', tx_hash=?, batch_no=1, registered_at=NOW() WHERE election_id=?",
      [rc.hash, kampar.id]
    );
  }
  log(`🔗 Voters: ${eligible.length} Kampar voters registered on chain`);

  // ── Ready ────────────────────────────────────────────────
  const line = "─".repeat(64);
  log(`\n${line}\n✅ Demo data ready\n${line}`);
  log(`
Sign in
  EC panel      /eclogin.html   EC001 · (your password)   — pick a campus first
  Student       /login.html     2207492 · Student1        — pick Kampar

MetaMask — import this to cast a vote as Cheng Zheng De
  address  ${wallets[0].address}
  key      ${wallets[0].privateKey}
  (throwaway test key, local Ganache only — never reuse it anywhere real)

Walkthrough
  1  Login page      two campuses, pick Kampar
  2  Student Roster  22 imported; click the batch to see every row and why
                     2205002 vs 2205003 — same arrears, one has the waiver
                     2205008 — criminal offence, waiver does NOT clear it
  3  Pending         2400001 Chong Yee Sen waiting; approve them
  4  Nominations     three approved, each with four confirmed endorsers
  5  Nominate tab    sign in as 2207492 — International and Postgraduate
                     Representative are greyed out, with the regulation
  6  Voter Reg       ${eligible.length} registered, per-student table with tx hashes
  7  Open Voting     readiness shows ${cc.n} candidates ✓ — open for 60 minutes
  8  Cast a vote     as 2207492 in MetaMask, then Results
  9  Switch campus   Sungai Long — its own election, its own students
`);
  await db.end();
}

// Exit explicitly. A pool connection or a provider poll left open is
// enough to keep node alive, and a seed process still holding the
// admin key is what causes the nonce clashes above on the next run.
main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("\n❌ Seed failed:", e.message); process.exit(1); });
