-- ============================================================
--  UTAR SRC Voting System — Migration v4 → v5
--  Author : Cheng Zheng De (2207492)
--  Purpose: FYP2 enhancements addressing moderator feedback
--
--    (1) Wallet linking that scales to thousands of students,
--        with cryptographic proof of wallet ownership.
--    (2) Proposer / seconder / supporter endorsements that are
--        confirmed by the endorsers themselves, per Regulation
--        XIII Reg 20(1)-(3).
--    (3) Student self-service editing of personal details.
--
--  Run ONCE:  mysql -u root -p utar_src_voting < db/migration_v5.sql
--  (MySQL 8.0 has no ADD COLUMN IF NOT EXISTS — do not re-run.)
-- ============================================================

USE utar_src_voting;

-- ─────────────────────────────────────────────────────────────
--  1. users — campus, study level, wallet proof, profile fields
-- ─────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN campus           ENUM('Kampar','Sungai Long') NOT NULL DEFAULT 'Kampar' AFTER faculty,
  ADD COLUMN study_level      ENUM('foundation','undergraduate','postgraduate') NOT NULL DEFAULT 'undergraduate' AFTER campus,
  ADD COLUMN is_international  TINYINT(1)   NOT NULL DEFAULT 0 AFTER study_level,
  ADD COLUMN phone             VARCHAR(20)  DEFAULT NULL AFTER email,
  ADD COLUMN wallet_verified_at DATETIME    DEFAULT NULL AFTER wallet_address,
  ADD COLUMN wallet_proof_sig  VARCHAR(200) DEFAULT NULL AFTER wallet_verified_at,
  ADD COLUMN roster_matched    TINYINT(1)   NOT NULL DEFAULT 0 AFTER is_approved,
  ADD COLUMN approval_note     VARCHAR(255) DEFAULT NULL AFTER roster_matched;

-- One wallet may belong to exactly one student account.
-- This is the anti-Sybil control: a student cannot register three
-- accounts and point them all at the same MetaMask address.
--
-- If your v4 data already has the same address on two rows, the
-- unique key below will fail. Check first:
--
--   SELECT wallet_address, COUNT(*) FROM users
--    WHERE wallet_address IS NOT NULL
--    GROUP BY wallet_address HAVING COUNT(*) > 1;
--
-- Clear the wrong ones (SET wallet_address=NULL) and have those
-- students re-link from their profile page, which now proves
-- ownership properly.
ALTER TABLE users DROP INDEX idx_wallet;
ALTER TABLE users ADD UNIQUE KEY uniq_wallet (wallet_address);
ALTER TABLE users ADD INDEX idx_campus (campus);

-- ─────────────────────────────────────────────────────────────
--  2. student_roster — the official DSA student master list
--
--  This is what makes approval scale. DSA exports the roster
--  once; every self-registration is matched against it and
--  auto-verified. The EC only adjudicates the exceptions.
--  The columns mirror Regulation XIII Reg 4 (eligibility for
--  SRC membership) and Reg 14 (eligibility to vote).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_roster (
    id                  INT          NOT NULL AUTO_INCREMENT,
    student_id          VARCHAR(20)  NOT NULL UNIQUE,
    full_name           VARCHAR(120) NOT NULL,
    email               VARCHAR(150) NOT NULL,
    faculty             VARCHAR(120) NOT NULL,
    campus              ENUM('Kampar','Sungai Long') NOT NULL,
    study_level         ENUM('foundation','undergraduate','postgraduate') NOT NULL,
    is_international    TINYINT(1)   NOT NULL DEFAULT 0,

    -- Reg 4(a) / Reg 14(1)(b) — distance learning & external programmes
    delivery_mode       ENUM('on_campus','distance_learning','external') NOT NULL DEFAULT 'on_campus',
    -- Reg 4(b) — has not sat for first examination
    sat_first_exam      TINYINT(1)   NOT NULL DEFAULT 1,
    -- Reg 4(c) — two long trimesters remaining
    trimesters_left     INT          NOT NULL DEFAULT 6,
    -- Reg 4(d) / Reg 14(1)(a) — leave of absence
    on_leave            TINYINT(1)   NOT NULL DEFAULT 0,
    -- Reg 4(e) — academic probation
    academic_probation  TINYINT(1)   NOT NULL DEFAULT 0,
    -- Reg 4(f) — criminal offence
    criminal_offence    TINYINT(1)   NOT NULL DEFAULT 0,
    -- Reg 4(g)/(gg) — found guilty of a disciplinary offence
    disciplinary_guilty TINYINT(1)   NOT NULL DEFAULT 0,
    -- Reg 4(h) — undergoing disciplinary proceedings
    disciplinary_open   TINYINT(1)   NOT NULL DEFAULT 0,
    -- Reg 4(i) — arrears of fees
    fees_in_arrears     TINYINT(1)   NOT NULL DEFAULT 0,
    -- Reg 4(g)(h)(i) — "unless authorised in writing by the President"
    president_waiver    TINYINT(1)   NOT NULL DEFAULT 0,
    -- Reg 4(j) — University discretion
    deemed_unfit        TINYINT(1)   NOT NULL DEFAULT 0,
    unfit_reason        VARCHAR(255) DEFAULT NULL,

    is_enrolled         TINYINT(1)   NOT NULL DEFAULT 1,
    imported_batch      VARCHAR(60)  DEFAULT NULL,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_roster_campus (campus),
    INDEX idx_roster_email  (email)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  3. auth_nonces — single-use challenges for wallet signatures
--
--  A nonce binds one signature to one student, one wallet and
--  one purpose, so a captured signature cannot be replayed.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_nonces (
    id            INT          NOT NULL AUTO_INCREMENT,
    nonce         CHAR(36)     NOT NULL UNIQUE,
    purpose       ENUM('wallet_link','endorsement') NOT NULL,
    student_id    VARCHAR(20)  NOT NULL,
    wallet_address VARCHAR(42) DEFAULT NULL,
    context_id    INT          DEFAULT NULL,   -- endorsement id, when applicable
    message       TEXT         NOT NULL,       -- exact text the user signs
    used_at       DATETIME     DEFAULT NULL,
    expires_at    DATETIME     NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_nonce_student (student_id),
    INDEX idx_nonce_expiry  (expires_at)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  4. elections — campus scoping
--
--  Reg 2(1): "The SRC is set up according to the campuses."
--  Also lays the groundwork for the FYP2 plan of separate
--  Kampar and Sungai Long interfaces.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE elections
  ADD COLUMN campus       ENUM('Kampar','Sungai Long') NOT NULL DEFAULT 'Kampar' AFTER academic_year,
  ADD COLUMN polling_date DATETIME DEFAULT NULL AFTER nomination_end;
ALTER TABLE elections ADD INDEX idx_el_campus (campus);

-- ─────────────────────────────────────────────────────────────
--  5. nominations — endorsement lifecycle
-- ─────────────────────────────────────────────────────────────
-- Widen the status enum first, on its own. A generated column that
-- reads `status` cannot be created in the same ALTER that redefines
-- it, so these have to be separate statements.
ALTER TABLE nominations
  MODIFY COLUMN status ENUM('awaiting_endorsement','pending','approved','rejected','withdrawn')
    NOT NULL DEFAULT 'awaiting_endorsement';

ALTER TABLE nominations
  ADD COLUMN campus        ENUM('Kampar','Sungai Long') NOT NULL DEFAULT 'Kampar' AFTER position,
  ADD COLUMN faculty_scope VARCHAR(120) DEFAULT NULL AFTER campus,
  ADD COLUMN endorsements_completed_at DATETIME DEFAULT NULL AFTER status,
  ADD COLUMN withdrawn_at  DATETIME DEFAULT NULL AFTER endorsements_completed_at;

-- The v4 free-text proposer/seconder columns are retained only so
-- that historical v4 rows still read correctly. New nominations
-- never write to them; endorsers now live in the table below.
ALTER TABLE nominations
  MODIFY COLUMN proposer_name VARCHAR(120) DEFAULT NULL COMMENT 'legacy v4 — superseded by nomination_endorsements',
  MODIFY COLUMN seconder_name VARCHAR(120) DEFAULT NULL COMMENT 'legacy v4 — superseded by nomination_endorsements';

-- Reg 20(1): "A candidate may be nominated for only one post."
-- A withdrawn or rejected nomination collapses to NULL, freeing the
-- student to stand again — MySQL allows repeated NULLs in a unique
-- index, which gives the effect of a partial index.
ALTER TABLE nominations
  ADD COLUMN nominee_slot INT GENERATED ALWAYS AS
    (IF(status IN ('awaiting_endorsement','pending','approved'), student_id, NULL)) STORED;

ALTER TABLE nominations
  ADD UNIQUE KEY uniq_one_post_per_nominee (election_id, nominee_slot);

-- ─────────────────────────────────────────────────────────────
--  6. nomination_endorsements — Reg 20(1): one proposer, one
--     seconder and two supporters, each confirmed in person.
--
--  In a physical nomination the four endorsers stand at the DSA
--  counter and produce their student ID cards. The digital
--  equivalent implemented here is: each endorser signs in to
--  their own account and signs a challenge message with their
--  registered MetaMask key (or re-enters their password if they
--  have no wallet). The nominee can never confirm on their
--  behalf, because the nominee does not hold their credentials.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nomination_endorsements (
    id                INT NOT NULL AUTO_INCREMENT,
    nomination_id     INT NOT NULL,
    election_id       INT NOT NULL,
    position          VARCHAR(80) NOT NULL,
    endorser_user_id  INT NOT NULL,               -- FK users.id
    endorser_role     ENUM('proposer','seconder','supporter_1','supporter_2') NOT NULL,
    status            ENUM('invited','confirmed','declined','revoked') NOT NULL DEFAULT 'invited',

    verification_method ENUM('wallet_signature','password') DEFAULT NULL,
    wallet_address    VARCHAR(42)  DEFAULT NULL,
    signed_message    TEXT         DEFAULT NULL,  -- exact text that was signed
    signature         VARCHAR(200) DEFAULT NULL,  -- 0x + 130 hex chars
    decline_reason    VARCHAR(255) DEFAULT NULL,
    ip_address        VARCHAR(45)  DEFAULT NULL,
    responded_at      DATETIME     DEFAULT NULL,
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Reg 20(3): a proposer, seconder or supporter may endorse
    -- ONLY ONE nominee for any one post. A declined or revoked
    -- row collapses to NULL so the person is free to endorse
    -- someone else instead — MySQL permits repeated NULLs in a
    -- unique index, which gives us a partial index.
    endorser_slot INT GENERATED ALWAYS AS
      (IF(status IN ('invited','confirmed'), endorser_user_id, NULL)) STORED,

    PRIMARY KEY (id),
    UNIQUE KEY uniq_role_per_nomination (nomination_id, endorser_role),
    UNIQUE KEY uniq_one_nominee_per_post (election_id, position, endorser_slot),
    INDEX idx_end_nomination (nomination_id),
    INDEX idx_end_user       (endorser_user_id, status),
    FOREIGN KEY (nomination_id) REFERENCES nominations(id) ON DELETE CASCADE,
    FOREIGN KEY (election_id)   REFERENCES elections(id),
    FOREIGN KEY (endorser_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  7. profile_change_requests — edits that need EC re-approval
--
--  A pending account edits itself freely. An approved account
--  editing an identity field raises a request instead, so the
--  EC's earlier verification is never silently invalidated.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_change_requests (
    id            INT          NOT NULL AUTO_INCREMENT,
    user_id       INT          NOT NULL,
    field_name    VARCHAR(40)  NOT NULL,
    old_value     VARCHAR(255) DEFAULT NULL,
    new_value     VARCHAR(255) NOT NULL,
    reason        VARCHAR(255) DEFAULT NULL,
    status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    review_note   VARCHAR(255) DEFAULT NULL,
    reviewed_at   DATETIME     DEFAULT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_pcr_user   (user_id),
    INDEX idx_pcr_status (status),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  8. voter_registrations — per-election on-chain queue
--
--  Tracks which students still need registerVotersBatch() run
--  for them, so the EC clicks once instead of a thousand times
--  and a failed chunk can be retried without duplicating work.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voter_registrations (
    id             INT NOT NULL AUTO_INCREMENT,
    election_id    INT NOT NULL,
    user_id        INT NOT NULL,
    wallet_address VARCHAR(42) NOT NULL,
    status         ENUM('queued','registered','failed','superseded') NOT NULL DEFAULT 'queued',
    tx_hash        VARCHAR(66)  DEFAULT NULL,
    batch_no       INT          DEFAULT NULL,
    error_message  VARCHAR(255) DEFAULT NULL,
    registered_at  DATETIME     DEFAULT NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_voter_per_election (election_id, user_id),
    INDEX idx_vr_status (election_id, status),
    FOREIGN KEY (election_id) REFERENCES elections(id),
    FOREIGN KEY (user_id)     REFERENCES users(id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  9. Demo roster rows so the flow can be tested immediately.
--      Replace with the real DSA export before any live use.
-- ─────────────────────────────────────────────────────────────
INSERT INTO student_roster
  (student_id, full_name, email, faculty, campus, study_level, trimesters_left, imported_batch)
VALUES
  ('2207492','Cheng Zheng De','2207492@1utar.my','Faculty of Information and Communication Technology (FICT)','Kampar','undergraduate',3,'demo'),
  ('2207001','Lee Wei Ming','2207001@1utar.my','Faculty of Information and Communication Technology (FICT)','Kampar','undergraduate',4,'demo'),
  ('2207002','Nur Aisyah Binti Rahman','2207002@1utar.my','Faculty of Accountancy and Management (FAM)','Kampar','undergraduate',4,'demo'),
  ('2207003','Raj Kumar A/L Suresh','2207003@1utar.my','Faculty of Science (FSC)','Kampar','undergraduate',5,'demo'),
  ('2300123','Tan Mei Ling','2300123@1utar.my','Faculty of Information and Communication Technology (FICT)','Kampar','undergraduate',5,'demo')
ON DUPLICATE KEY UPDATE full_name = VALUES(full_name);

-- Existing v4 accounts are treated as roster-matched so the
-- upgrade does not lock out anyone already approved.
UPDATE users SET roster_matched = 1 WHERE is_approved = 1 AND role = 'student';

SELECT 'Migration v5 complete.' AS status;
