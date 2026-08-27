-- ============================================================
--  UTAR SRC Voting System v4 — MySQL Database Setup
--  Changes: SRC Committee removed, Election Committee gains all
--           tasks, new nominations table for self-nomination flow
--  Run: mysql -u root -p < db/setup.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS utar_src_voting
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE utar_src_voting;

-- ─────────────────────────────────────────────────────────────
--  Table: users
--  role: 'student' | 'election_committee' | 'admin' removed committee
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              INT           NOT NULL AUTO_INCREMENT,
    student_id      VARCHAR(20)   NOT NULL UNIQUE,
    full_name       VARCHAR(120)  NOT NULL,
    email           VARCHAR(150)  NOT NULL UNIQUE,
    faculty         VARCHAR(120)  NOT NULL,
    password_hash   VARCHAR(255)  NOT NULL DEFAULT '',
    wallet_address  VARCHAR(42)   DEFAULT NULL,
    role            ENUM('student','election_committee') NOT NULL DEFAULT 'student',
    is_active       TINYINT(1)    NOT NULL DEFAULT 1,
    is_approved     TINYINT(1)    NOT NULL DEFAULT 0,
    must_change_pw  TINYINT(1)    NOT NULL DEFAULT 0,
    created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_student_id (student_id),
    INDEX idx_wallet     (wallet_address),
    INDEX idx_approved   (is_approved)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  Table: elections
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS elections (
    id                  INT          NOT NULL AUTO_INCREMENT,
    blockchain_id       INT          NOT NULL UNIQUE,
    title               VARCHAR(200) NOT NULL,
    academic_year       VARCHAR(20)  NOT NULL,
    description         TEXT         DEFAULT NULL,
    status              ENUM('setup','nomination','active','ended') NOT NULL DEFAULT 'setup',
    contract_address    VARCHAR(42)  DEFAULT NULL,
    nomination_start    DATETIME     DEFAULT NULL,
    nomination_end      DATETIME     DEFAULT NULL,
    start_time          DATETIME     DEFAULT NULL,
    end_time            DATETIME     DEFAULT NULL,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_blockchain_id (blockchain_id),
    INDEX idx_status        (status)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  Table: nominations
--  Students self-nominate; Election Committee approves/rejects
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nominations (
    id              INT          NOT NULL AUTO_INCREMENT,
    election_id     INT          NOT NULL,
    student_id      INT          NOT NULL,    -- FK to users.id
    position        VARCHAR(80)  NOT NULL,    -- e.g. President, Treasurer
    manifesto       TEXT         DEFAULT NULL,
    proposer_name   VARCHAR(120) DEFAULT NULL,
    proposer_id     VARCHAR(20)  DEFAULT NULL,
    seconder_name   VARCHAR(120) DEFAULT NULL,
    seconder_id     VARCHAR(20)  DEFAULT NULL,
    status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    rejection_reason VARCHAR(255) DEFAULT NULL,
    reviewed_at     DATETIME     DEFAULT NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_election  (election_id),
    INDEX idx_student   (student_id),
    INDEX idx_status    (status),
    FOREIGN KEY (election_id) REFERENCES elections(id),
    FOREIGN KEY (student_id)  REFERENCES users(id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  Table: candidates
--  Populated when Election Committee approves a nomination
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candidates (
    id              INT          NOT NULL AUTO_INCREMENT,
    election_id     INT          NOT NULL,
    nomination_id   INT          DEFAULT NULL,  -- link back to nomination
    blockchain_id   INT          NOT NULL,
    full_name       VARCHAR(120) NOT NULL,
    faculty         VARCHAR(80)  NOT NULL,
    position        VARCHAR(80)  NOT NULL,
    manifesto       TEXT         DEFAULT NULL,
    photo_url       VARCHAR(255) DEFAULT NULL,
    is_approved     TINYINT(1)   NOT NULL DEFAULT 1,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY unique_candidate (election_id, blockchain_id),
    INDEX idx_election    (election_id),
    INDEX idx_nomination  (nomination_id),
    FOREIGN KEY (election_id) REFERENCES elections(id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  Table: audit_log — unified single log for all actions
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    user_id     INT          DEFAULT NULL,
    role        ENUM('election_committee','student','system') NOT NULL DEFAULT 'system',
    election_id INT          DEFAULT NULL,
    action      VARCHAR(100) NOT NULL,
    description TEXT         DEFAULT NULL,
    ip_address  VARCHAR(45)  DEFAULT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_role    (role),
    INDEX idx_election(election_id),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────────────
--  Seed Data
--  Election Committee default password : EC123
--  Passwords are bcrypt-hashed on first server boot
-- ─────────────────────────────────────────────────────────────

-- Election Committee accounts (replaces both Admin and SRC Committee)
INSERT IGNORE INTO users
  (student_id, full_name, email, faculty, password_hash, role, is_active, is_approved, must_change_pw)
VALUES
  ('EC001', 'Election Chairperson',  'ec001@utar.edu.my', 'UTAR Election Committee', 'PENDING_HASH', 'election_committee', 1, 1, 1),
  ('EC002', 'Election Secretary',    'ec002@utar.edu.my', 'UTAR Election Committee', 'PENDING_HASH', 'election_committee', 1, 1, 1),
  ('EC003', 'Election Officer',      'ec003@utar.edu.my', 'UTAR Election Committee', 'PENDING_HASH', 'election_committee', 1, 1, 1);

-- Sample student voters
INSERT IGNORE INTO users
  (student_id, full_name, email, faculty, password_hash, role, is_active, is_approved)
VALUES
  ('2207492', 'Cheng Zheng De',  '2207492@1utar.my', 'Faculty of Information and Communication Technology (FICT)', 'PENDING_HASH', 'student', 1, 0),
  ('2207001', 'Lee Wei Ming',    '2207001@1utar.my', 'Faculty of Engineering and Green Technology (FEGT)',          'PENDING_HASH', 'student', 1, 0),
  ('2207002', 'Tan Mei Ling',    '2207002@1utar.my', 'Teh Hong Piow Faculty of Business and Finance (THP FBF)',    'PENDING_HASH', 'student', 1, 0),
  ('2207003', 'Ahmad Fariz',     '2207003@1utar.my', 'Faculty of Science (FSC)',                                   'PENDING_HASH', 'student', 1, 0);

SELECT 'Database v4 setup complete!' AS status;
SELECT table_name FROM information_schema.tables WHERE table_schema = 'utar_src_voting';
