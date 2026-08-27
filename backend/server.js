// backend/server.js — UTAR SRC Voting System v4
// SRC Committee removed. Election Committee handles everything.
// Students can self-nominate after login.
require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const mysql      = require("mysql2/promise");
const bcrypt     = require("bcrypt");
const { ethers } = require("ethers");
const path       = require("path");
const fs         = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;
const SALT = 10;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// ─────────────────────────────────────────────────────────────
//  MySQL Pool
// ─────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "utar_src_voting",
  waitForConnections: true,
  connectionLimit: 10,
});

// ─────────────────────────────────────────────────────────────
//  Blockchain Setup
// ─────────────────────────────────────────────────────────────
let contract, provider, adminWallet;
function initBlockchain() {
  try {
    const info  = JSON.parse(fs.readFileSync(path.join(__dirname, "contract.json"), "utf8"));
    provider    = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:7545");
    adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
    contract    = new ethers.Contract(info.address, info.abi, adminWallet);
    console.log(`⛓️  Blockchain connected — contract at ${info.address}`);
  } catch {
    console.warn("⚠️  Blockchain not connected yet. Deploy contract first.");
  }
}

// ─────────────────────────────────────────────────────────────
//  Seed default passwords on first boot
// ─────────────────────────────────────────────────────────────
async function seedPasswords() {
  try {
    const ecHash      = await bcrypt.hash("EC123",    SALT);
    const studentHash = await bcrypt.hash("Student1", SALT);
    await db.execute(
      "UPDATE users SET password_hash=? WHERE role='election_committee' AND password_hash='PENDING_HASH'",
      [ecHash]
    );
    await db.execute(
      "UPDATE users SET password_hash=? WHERE role='student' AND password_hash='PENDING_HASH'",
      [studentHash]
    );
    console.log("🔐 Default passwords seeded");
  } catch (err) { console.error("Seed error:", err.message); }
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
async function logAudit(userId, role, electionId, action, description, ip) {
  try {
    await db.execute(
      "INSERT INTO audit_log (user_id,role,election_id,action,description,ip_address) VALUES (?,?,?,?,?,?)",
      [userId||null, role||"system", electionId||null, action, description||null, ip||null]
    );
  } catch (_) {}
}

async function isElectionLocked(electionId) {
  const [rows] = await db.execute("SELECT status FROM elections WHERE id=?", [electionId]);
  if (!rows.length) return false;
  return rows[0].status === "active" || rows[0].status === "ended";
}

// ─────────────────────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ status:"ok", timestamp:new Date().toISOString() }));

// ═════════════════════════════════════════════════════════════
//  AUTH
// ═════════════════════════════════════════════════════════════

// ── Student self-registration ─────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { student_id, full_name, email, faculty, password } = req.body;
  if (!student_id||!full_name||!email||!faculty||!password)
    return res.status(400).json({ error: "All fields are required" });
  if (password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  try {
    const [ex] = await db.execute("SELECT id FROM users WHERE student_id=? OR email=?", [student_id, email]);
    if (ex.length) return res.status(409).json({ error: "Student ID or email already registered" });
    const hash = await bcrypt.hash(password, SALT);
    await db.execute(
      "INSERT INTO users (student_id,full_name,email,faculty,password_hash,role,is_active,is_approved) VALUES (?,?,?,?,?,'student',1,0)",
      [student_id, full_name, email, faculty, hash]
    );
    await logAudit(null,"student",null,"REGISTER",`New registration: ${student_id}`,req.ip);
    res.json({ success:true, message:"Registration submitted. Awaiting Election Committee approval." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── Login ─────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { student_id, password, wallet_address } = req.body;
  if (!student_id||!password) return res.status(400).json({ error:"Student ID and password are required" });
  try {
    const [rows] = await db.execute("SELECT * FROM users WHERE student_id=? AND is_active=1", [student_id]);
    if (!rows.length) return res.status(401).json({ error:"Student ID not found" });
    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error:"Incorrect password" });
    if (user.role==="student" && !user.is_approved)
      return res.status(403).json({ error:"Account pending approval by the Election Committee" });
    if (wallet_address && !user.wallet_address) {
      await db.execute("UPDATE users SET wallet_address=? WHERE id=?", [wallet_address, user.id]);
      user.wallet_address = wallet_address;
    }
    await logAudit(user.id, user.role, null, "LOGIN", `${student_id} logged in`, req.ip);
    res.json({
      success: true,
      mustChangePassword: user.must_change_pw === 1,
      user: {
        id:user.id, student_id:user.student_id, full_name:user.full_name,
        email:user.email, faculty:user.faculty, role:user.role,
        wallet_address:user.wallet_address,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:"Login failed" });
  }
});

// ── Change password ───────────────────────────────────────────
app.post("/api/auth/change-password", async (req, res) => {
  const { student_id, current_password, new_password } = req.body;
  if (!student_id||!current_password||!new_password) return res.status(400).json({ error:"All fields required" });
  if (new_password.length < 8) return res.status(400).json({ error:"New password must be at least 8 characters" });
  try {
    const [rows] = await db.execute("SELECT * FROM users WHERE student_id=? AND is_active=1", [student_id]);
    if (!rows.length) return res.status(404).json({ error:"User not found" });
    const user  = rows[0];
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(401).json({ error:"Current password is incorrect" });
    const hash = await bcrypt.hash(new_password, SALT);
    await db.execute("UPDATE users SET password_hash=?,must_change_pw=0 WHERE id=?", [hash, user.id]);
    await logAudit(user.id, user.role, null, "PASSWORD_CHANGED", `${student_id} changed password`, req.ip);
    res.json({ success:true, message:"Password changed successfully" });
  } catch (err) {
    res.status(500).json({ error:"Password change failed" });
  }
});

// ═════════════════════════════════════════════════════════════
//  PUBLIC ELECTION ROUTES
// ═════════════════════════════════════════════════════════════

app.get("/api/elections", async (req, res) => {
  try {
    const { search, status } = req.query;
    let sql="SELECT * FROM elections WHERE 1=1", params=[];
    if (search) { sql+=" AND (title LIKE ? OR academic_year LIKE ?)"; params.push(`%${search}%`,`%${search}%`); }
    if (status) { sql+=" AND status=?"; params.push(status); }
    sql+=" ORDER BY id DESC";
    const [rows] = await db.execute(sql, params);
    if (contract) {
      for (const el of rows) {
        try {
          const [isOpen,startTime,endTime,numCandidates,totalVotes] = await contract.getElectionStatus(el.blockchain_id);
          el.is_open=isOpen; el.bc_start_time=Number(startTime); el.bc_end_time=Number(endTime);
          el.num_candidates=Number(numCandidates); el.total_votes=Number(totalVotes);
        } catch (_) {}
      }
    }
    res.json({ success:true, elections:rows });
  } catch (err) { res.status(500).json({ error:"Failed to fetch elections" }); }
});

app.get("/api/elections/:electionId", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM elections WHERE id=?", [req.params.electionId]);
    if (!rows.length) return res.status(404).json({ error:"Election not found" });
    const el = rows[0];
    if (contract) {
      try {
        const [isOpen,startTime,endTime,numCandidates,totalVotes] = await contract.getElectionStatus(el.blockchain_id);
        el.is_open=isOpen; el.bc_start_time=Number(startTime); el.bc_end_time=Number(endTime);
        el.num_candidates=Number(numCandidates); el.total_votes=Number(totalVotes);
      } catch (_) {}
    }
    res.json({ success:true, election:el });
  } catch (err) { res.status(500).json({ error:"Failed to fetch election" }); }
});

app.get("/api/elections/:electionId/candidates", async (req, res) => {
  const { electionId } = req.params;
  const { search } = req.query;
  try {
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    let sql="SELECT * FROM candidates WHERE election_id=? AND is_approved=1", params=[electionId];
    if (search) { sql+=" AND (full_name LIKE ? OR position LIKE ? OR faculty LIKE ?)"; params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    sql+=" ORDER BY blockchain_id ASC";
    const [rows] = await db.execute(sql, params);
    if (contract) {
      try {
        const bcId = elRows[0].blockchain_id;
        const [ids,,,, voteCounts] = await contract.getResults(bcId);
        const vm={};
        ids.forEach((id,i)=>{ vm[Number(id)]=Number(voteCounts[i]); });
        rows.forEach(c=>{ c.vote_count=vm[c.blockchain_id]??0; });
      } catch (_) {}
    }
    res.json({ success:true, candidates:rows });
  } catch (err) { res.status(500).json({ error:"Failed to fetch candidates" }); }
});

app.get("/api/elections/:electionId/results", async (req, res) => {
  const { electionId } = req.params;
  try {
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    const election = elRows[0];
    const [candidates] = await db.execute(
      "SELECT * FROM candidates WHERE election_id=? AND is_approved=1 ORDER BY blockchain_id ASC", [electionId]
    );
    let electionStatus=null;
    if (contract) {
      try {
        const bcId=election.blockchain_id;
        const [isOpen,startTime,endTime,numCandidates,numVotes]=await contract.getElectionStatus(bcId);
        electionStatus={isOpen,startTime:Number(startTime),endTime:Number(endTime),numCandidates:Number(numCandidates),totalVotesCast:Number(numVotes)};
        const [ids,,,, voteCounts]=await contract.getResults(bcId);
        const vm={};
        ids.forEach((id,i)=>{ vm[Number(id)]=Number(voteCounts[i]); });
        candidates.forEach(c=>{ c.vote_count=vm[c.blockchain_id]??0; });
      } catch (_) {}
    }
    res.json({ success:true, election, candidates, electionStatus });
  } catch (err) { res.status(500).json({ error:"Failed to fetch results" }); }
});

app.get("/api/elections/:electionId/voter-status/:wallet", async (req, res) => {
  const { electionId, wallet } = req.params;
  if (!contract) return res.status(503).json({ error:"Blockchain not connected" });
  try {
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    const [isRegistered,hasVoted,votedCandidateId,votedAt]=await contract.getVoterStatus(elRows[0].blockchain_id, wallet);
    res.json({ success:true, isRegistered, hasVoted, votedCandidateId:Number(votedCandidateId), votedAt:Number(votedAt) });
  } catch (err) { res.status(500).json({ error:"Failed to get voter status" }); }
});

// ═════════════════════════════════════════════════════════════
//  STUDENT NOMINATION ROUTES
// ═════════════════════════════════════════════════════════════

// ── Submit nomination (student self-nominates) ────────────────
// POST /api/nominations
// Body: { election_id, student_user_id, position, manifesto, proposer_name, proposer_id, seconder_name, seconder_id }
app.post("/api/nominations", async (req, res) => {
  const { election_id, student_user_id, position, manifesto, proposer_name, proposer_id, seconder_name, seconder_id } = req.body;
  if (!election_id||!student_user_id||!position)
    return res.status(400).json({ error:"election_id, student_user_id, and position are required" });
  try {
    // Check election is in nomination phase
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [election_id]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    if (elRows[0].status !== "nomination" && elRows[0].status !== "setup")
      return res.status(403).json({ error:"Nominations are not open for this election" });
    // Check if student already nominated for same position
    const [existing] = await db.execute(
      "SELECT id FROM nominations WHERE election_id=? AND student_id=? AND status!='rejected'",
      [election_id, student_user_id]
    );
    if (existing.length) return res.status(409).json({ error:"You have already submitted a nomination for this election" });
    // Get student details
    const [sRows] = await db.execute("SELECT * FROM users WHERE id=? AND role='student'", [student_user_id]);
    if (!sRows.length) return res.status(404).json({ error:"Student not found" });
    await db.execute(
      `INSERT INTO nominations (election_id,student_id,position,manifesto,proposer_name,proposer_id,seconder_name,seconder_id,status)
       VALUES (?,?,?,?,?,?,?,?,'pending')`,
      [election_id, student_user_id, position, manifesto||null, proposer_name||null, proposer_id||null, seconder_name||null, seconder_id||null]
    );
    await logAudit(student_user_id,"student",election_id,"NOMINATION_SUBMITTED",`${sRows[0].student_id} nominated for ${position}`,req.ip);
    res.json({ success:true, message:"Nomination submitted successfully. Awaiting Election Committee review." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:"Failed to submit nomination" });
  }
});

// ── Get student's own nominations ─────────────────────────────
app.get("/api/nominations/student/:userId", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT n.*, e.title as election_title, e.academic_year FROM nominations n
       JOIN elections e ON n.election_id = e.id
       WHERE n.student_id=? ORDER BY n.created_at DESC`,
      [req.params.userId]
    );
    res.json({ success:true, nominations:rows });
  } catch (err) { res.status(500).json({ error:"Failed to fetch nominations" }); }
});

// ═════════════════════════════════════════════════════════════
//  ELECTION COMMITTEE ROUTES
//  (All tasks previously split between SRC + Admin now unified here)
// ═════════════════════════════════════════════════════════════

// ── Create election ───────────────────────────────────────────
app.post("/api/ec/elections", async (req, res) => {
  const { title, academic_year, description } = req.body;
  if (!title||!academic_year) return res.status(400).json({ error:"title and academic_year required" });
  try {
    let blockchainId=null;
    if (contract) {
      const tx=await contract.createElection(title);
      const receipt=await tx.wait();
      const event=receipt.logs.map(log=>{ try{return contract.interface.parseLog(log);}catch{return null;} }).find(e=>e?.name==="ElectionCreated");
      blockchainId=event?Number(event.args.electionId):null;
    }
    const [result] = await db.execute(
      "INSERT INTO elections (blockchain_id,title,academic_year,description,status) VALUES (?,?,?,?,'setup')",
      [blockchainId, title, academic_year, description||null]
    );
    try {
      const info=JSON.parse(fs.readFileSync(path.join(__dirname,"contract.json"),"utf8"));
      await db.execute("UPDATE elections SET contract_address=? WHERE id=?", [info.address, result.insertId]);
    } catch (_) {}
    await logAudit(null,"election_committee",result.insertId,"ELECTION_CREATED",`Created: ${title}`,req.ip);
    res.json({ success:true, electionId:result.insertId, blockchainId, title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:err.message||"Failed to create election" });
  }
});

// ── Edit election (setup only) ────────────────────────────────
app.put("/api/ec/elections/:electionId", async (req, res) => {
  const { electionId } = req.params;
  const { title, academic_year, description } = req.body;
  try {
    if (await isElectionLocked(electionId))
      return res.status(403).json({ error:"Cannot edit election after voting has started" });
    await db.execute(
      "UPDATE elections SET title=?,academic_year=?,description=?,updated_at=NOW() WHERE id=?",
      [title, academic_year, description||null, electionId]
    );
    await logAudit(null,"election_committee",electionId,"ELECTION_EDITED",`Updated: ${title}`,req.ip);
    res.json({ success:true, message:"Election updated" });
  } catch (err) { res.status(500).json({ error:"Failed to update election" }); }
});

// ── Delete election (setup only) ──────────────────────────────
app.delete("/api/ec/elections/:electionId", async (req, res) => {
  const { electionId } = req.params;
  try {
    if (await isElectionLocked(electionId))
      return res.status(403).json({ error:"Cannot delete election after voting has started" });
    await db.execute("DELETE FROM nominations WHERE election_id=?", [electionId]);
    await db.execute("DELETE FROM candidates WHERE election_id=?", [electionId]);
    await db.execute("DELETE FROM elections WHERE id=?", [electionId]);
    await logAudit(null,"election_committee",electionId,"ELECTION_DELETED",`Deleted election #${electionId}`,req.ip);
    res.json({ success:true, message:"Election deleted" });
  } catch (err) { res.status(500).json({ error:"Failed to delete election" }); }
});

// ── Open nomination period ────────────────────────────────────
app.post("/api/ec/elections/:electionId/open-nominations", async (req, res) => {
  const { electionId } = req.params;
  const { nominationDays } = req.body;
  if (!nominationDays||nominationDays<1) return res.status(400).json({ error:"nominationDays must be >= 1" });
  try {
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    if (elRows[0].status !== "setup") return res.status(403).json({ error:"Election is not in setup phase" });
    const nomStart = new Date();
    const nomEnd   = new Date(nomStart.getTime() + nominationDays * 86400000);
    await db.execute(
      "UPDATE elections SET status='nomination',nomination_start=?,nomination_end=? WHERE id=?",
      [nomStart, nomEnd, electionId]
    );
    await logAudit(null,"election_committee",electionId,"NOMINATIONS_OPENED",`Open for ${nominationDays} days`,req.ip);
    res.json({ success:true, message:"Nomination period opened", nomStart, nomEnd });
  } catch (err) { res.status(500).json({ error:"Failed to open nominations" }); }
});

// ── Get all nominations for an election ───────────────────────
app.get("/api/ec/elections/:electionId/nominations", async (req, res) => {
  const { electionId } = req.params;
  const { status, search } = req.query;
  try {
    let sql=`SELECT n.*, u.full_name as student_name, u.student_id as student_code, u.faculty as student_faculty, u.email as student_email
             FROM nominations n JOIN users u ON n.student_id=u.id WHERE n.election_id=?`;
    const params=[electionId];
    if (status) { sql+=" AND n.status=?"; params.push(status); }
    if (search) { sql+=" AND (u.full_name LIKE ? OR u.student_id LIKE ? OR n.position LIKE ?)"; params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    sql+=" ORDER BY n.created_at ASC";
    const [rows] = await db.execute(sql, params);
    res.json({ success:true, nominations:rows });
  } catch (err) { res.status(500).json({ error:"Failed to fetch nominations" }); }
});

// ── Approve nomination → auto-add to blockchain as candidate ──
app.post("/api/ec/nominations/:nominationId/approve", async (req, res) => {
  const { nominationId } = req.params;
  try {
    const [nomRows] = await db.execute(
      `SELECT n.*, u.full_name, u.faculty, u.student_id as student_code
       FROM nominations n JOIN users u ON n.student_id=u.id WHERE n.id=?`,
      [nominationId]
    );
    if (!nomRows.length) return res.status(404).json({ error:"Nomination not found" });
    const nom = nomRows[0];
    if (nom.status !== "pending") return res.status(400).json({ error:"Nomination already reviewed" });

    // Check election not locked
    if (await isElectionLocked(nom.election_id))
      return res.status(403).json({ error:"Cannot approve after voting has started" });

    // Get election blockchain_id
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [nom.election_id]);
    let blockchainId=null;
    if (contract) {
      const tx=await contract.addCandidate(elRows[0].blockchain_id, nom.full_name, nom.faculty, nom.position);
      const receipt=await tx.wait();
      const event=receipt.logs.map(log=>{ try{return contract.interface.parseLog(log);}catch{return null;} }).find(e=>e?.name==="CandidateAdded");
      blockchainId=event?Number(event.args.candidateId):null;
    }

    // Add to candidates table
    await db.execute(
      `INSERT INTO candidates (election_id,nomination_id,blockchain_id,full_name,faculty,position,manifesto,is_approved)
       VALUES (?,?,?,?,?,?,?,1)`,
      [nom.election_id, nominationId, blockchainId, nom.full_name, nom.faculty, nom.position, nom.manifesto||null]
    );

    // Update nomination status
    await db.execute(
      "UPDATE nominations SET status='approved',reviewed_at=NOW() WHERE id=?", [nominationId]
    );

    await logAudit(null,"election_committee",nom.election_id,"NOMINATION_APPROVED",
      `Approved ${nom.student_code} for ${nom.position}`,req.ip);
    res.json({ success:true, message:`${nom.full_name} approved and added as candidate`, blockchainId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:err.message||"Failed to approve nomination" });
  }
});

// ── Reject nomination ─────────────────────────────────────────
app.post("/api/ec/nominations/:nominationId/reject", async (req, res) => {
  const { nominationId } = req.params;
  const { reason } = req.body;
  try {
    const [nomRows] = await db.execute(
      "SELECT n.*, u.student_id as student_code FROM nominations n JOIN users u ON n.student_id=u.id WHERE n.id=?",
      [nominationId]
    );
    if (!nomRows.length) return res.status(404).json({ error:"Nomination not found" });
    if (nomRows[0].status !== "pending") return res.status(400).json({ error:"Nomination already reviewed" });
    await db.execute(
      "UPDATE nominations SET status='rejected',rejection_reason=?,reviewed_at=NOW() WHERE id=?",
      [reason||null, nominationId]
    );
    await logAudit(null,"election_committee",nomRows[0].election_id,"NOMINATION_REJECTED",
      `Rejected ${nomRows[0].student_code}: ${reason||'No reason given'}`,req.ip);
    res.json({ success:true, message:"Nomination rejected" });
  } catch (err) { res.status(500).json({ error:"Failed to reject nomination" }); }
});

// ── Edit approved candidate (before voting) ───────────────────
app.put("/api/ec/elections/:electionId/candidates/:candidateId", async (req, res) => {
  const { electionId, candidateId } = req.params;
  const { full_name, faculty, position, manifesto } = req.body;
  try {
    if (await isElectionLocked(electionId))
      return res.status(403).json({ error:"Cannot edit candidates after voting has started" });
    await db.execute(
      "UPDATE candidates SET full_name=?,faculty=?,position=?,manifesto=?,updated_at=NOW() WHERE id=? AND election_id=?",
      [full_name, faculty, position, manifesto||null, candidateId, electionId]
    );
    await logAudit(null,"election_committee",electionId,"CANDIDATE_EDITED",`Edited candidate #${candidateId}`,req.ip);
    res.json({ success:true, message:"Candidate updated" });
  } catch (err) { res.status(500).json({ error:"Failed to update candidate" }); }
});

// ── Delete candidate (before voting) ─────────────────────────
app.delete("/api/ec/elections/:electionId/candidates/:candidateId", async (req, res) => {
  const { electionId, candidateId } = req.params;
  try {
    if (await isElectionLocked(electionId))
      return res.status(403).json({ error:"Cannot delete candidates after voting has started" });
    await db.execute("DELETE FROM candidates WHERE id=? AND election_id=?", [candidateId, electionId]);
    await logAudit(null,"election_committee",electionId,"CANDIDATE_DELETED",`Deleted candidate #${candidateId}`,req.ip);
    res.json({ success:true, message:"Candidate deleted" });
  } catch (err) { res.status(500).json({ error:"Failed to delete candidate" }); }
});

// ── Get pending student approvals ─────────────────────────────
app.get("/api/ec/pending-students", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id,student_id,full_name,email,faculty,created_at FROM users WHERE role='student' AND is_approved=0 ORDER BY created_at ASC"
    );
    res.json({ success:true, pending:rows });
  } catch (err) { res.status(500).json({ error:"Failed to fetch pending students" }); }
});

// ── Approve student account ───────────────────────────────────
app.post("/api/ec/students/:userId/approve", async (req, res) => {
  const { userId } = req.params;
  try {
    await db.execute("UPDATE users SET is_approved=1 WHERE id=? AND role='student'", [userId]);
    const [rows] = await db.execute("SELECT student_id,full_name FROM users WHERE id=?", [userId]);
    await logAudit(null,"election_committee",null,"STUDENT_APPROVED",`Approved: ${rows[0]?.student_id}`,req.ip);
    res.json({ success:true, message:"Student account approved" });
  } catch (err) { res.status(500).json({ error:"Failed to approve student" }); }
});

// ── Reject/delete pending student ────────────────────────────
app.delete("/api/ec/students/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const [rows] = await db.execute("SELECT student_id FROM users WHERE id=? AND is_approved=0", [userId]);
    if (!rows.length) return res.status(404).json({ error:"Pending user not found" });
    await db.execute("DELETE FROM users WHERE id=? AND is_approved=0", [userId]);
    await logAudit(null,"election_committee",null,"STUDENT_REJECTED",`Rejected: ${rows[0].student_id}`,req.ip);
    res.json({ success:true, message:"Registration rejected" });
  } catch (err) { res.status(500).json({ error:"Failed to reject student" }); }
});

// ── Get all approved students ─────────────────────────────────
app.get("/api/ec/students", async (req, res) => {
  const { search } = req.query;
  try {
    let sql="SELECT id,student_id,full_name,email,faculty,wallet_address,is_approved,created_at FROM users WHERE role='student'";
    const params=[];
    if (search) {
      sql+=" AND (student_id LIKE ? OR full_name LIKE ? OR email LIKE ? OR faculty LIKE ?)";
      params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`);
    }
    sql+=" ORDER BY is_approved ASC, created_at DESC";
    const [rows] = await db.execute(sql, params);
    res.json({ success:true, students:rows });
  } catch (err) { res.status(500).json({ error:"Failed to fetch students" }); }
});

// ── Link/update wallet address for a student ──────────────────
app.put("/api/ec/students/:userId/wallet", async (req, res) => {
  const { userId } = req.params;
  const { wallet_address } = req.body;
  if (!wallet_address) return res.status(400).json({ error:"wallet_address required" });
  try {
    await db.execute("UPDATE users SET wallet_address=? WHERE id=? AND role='student'", [wallet_address, userId]);
    await logAudit(null,"election_committee",null,"WALLET_LINKED",`User #${userId} wallet: ${wallet_address}`,req.ip);
    res.json({ success:true, message:"Wallet address updated" });
  } catch (err) { res.status(500).json({ error:"Failed to update wallet" }); }
});

// ── Register voter on blockchain ──────────────────────────────
app.post("/api/ec/elections/:electionId/register-voter", async (req, res) => {
  const { electionId } = req.params;
  const { student_id, wallet_address } = req.body;
  if (!student_id||!wallet_address) return res.status(400).json({ error:"student_id and wallet_address required" });
  try {
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    await db.execute("UPDATE users SET wallet_address=? WHERE student_id=?", [wallet_address, student_id]);
    if (contract) { const tx=await contract.registerVoter(elRows[0].blockchain_id, wallet_address); await tx.wait(); }
    await logAudit(null,"election_committee",electionId,"VOTER_REGISTERED",`${student_id} → ${wallet_address}`,req.ip);
    res.json({ success:true, message:`Voter ${student_id} registered on blockchain` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:err.message||"Failed to register voter" });
  }
});

// ── Start voting ──────────────────────────────────────────────
app.post("/api/ec/elections/:electionId/start", async (req, res) => {
  const { electionId } = req.params;
  const { durationMinutes } = req.body;
  if (!durationMinutes||durationMinutes<1) return res.status(400).json({ error:"durationMinutes must be >= 1" });
  try {
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    if (contract) { const tx=await contract.startVoting(elRows[0].blockchain_id, durationMinutes); await tx.wait(); }
    const startTime=new Date();
    const endTime=new Date(startTime.getTime()+durationMinutes*60000);
    await db.execute("UPDATE elections SET status='active',start_time=?,end_time=? WHERE id=?", [startTime,endTime,electionId]);
    await logAudit(null,"election_committee",electionId,"VOTING_STARTED",`Duration: ${durationMinutes} mins`,req.ip);
    res.json({ success:true, message:"Voting started", startTime, endTime });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:err.message||"Failed to start voting" });
  }
});

// ── End voting ────────────────────────────────────────────────
app.post("/api/ec/elections/:electionId/end", async (req, res) => {
  const { electionId } = req.params;
  try {
    const [elRows] = await db.execute("SELECT * FROM elections WHERE id=?", [electionId]);
    if (!elRows.length) return res.status(404).json({ error:"Election not found" });
    if (contract) { const tx=await contract.endVoting(elRows[0].blockchain_id); await tx.wait(); }
    await db.execute("UPDATE elections SET status='ended' WHERE id=?", [electionId]);
    await logAudit(null,"election_committee",electionId,"VOTING_ENDED","Election Committee ended voting",req.ip);
    res.json({ success:true, message:"Voting ended" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error:err.message||"Failed to end voting" });
  }
});

// ── Audit log ─────────────────────────────────────────────────
app.get("/api/ec/audit", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 300");
    res.json({ success:true, logs:rows });
  } catch (err) { res.status(500).json({ error:"Failed to fetch audit log" }); }
});

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────
async function start() {
  initBlockchain();
  await seedPasswords();
  app.listen(PORT, () => {
    console.log(`\n🟢 UTAR SRC Voting System v4 — http://localhost:${PORT}`);
    console.log(`📡 API at http://localhost:${PORT}/api\n`);
  });
}
start();
