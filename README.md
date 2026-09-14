# UTAR SRC Blockchain Voting System

A campus election platform for the **Student Representative Council (SRC)** of Universiti Tunku Abdul Rahman. Students elect a whole council, one vote per post, and every ballot is recorded on an Ethereum smart contract where it cannot be altered afterwards — by anyone, including the Election Committee.

The system encodes **UTAR Regulation XIII** directly: who may vote, who may stand, who may endorse a nominee, and which seats are reserved, so those rules are enforced by the software rather than checked by hand.

> Final Year Project (FYP2) — Cheng Zheng De

---

## Features

### For students
- **Council ballot** — vote once for each post (Chairperson, Secretary, Treasurer, …), signed with the student's own MetaMask wallet.
- **Self-nomination** with four endorsers (Proposer, Seconder, two Supporters). Each endorser confirms from their own account, so no endorsement can be invented (Reg 20).
- **Eligibility shown up front** — posts a student cannot hold appear greyed out with the regulation that bars them. Faculty and Campus Wide Representative seats are labelled with the student's own faculty or campus.
- **Verify your ballot** — a per-post receipt read from the blockchain, with transaction hashes. Students can only check their own linked wallet, so ballots stay secret.
- **Live results** grouped and ranked by post.
- **Profile management** with change requests reviewed by the Election Committee.
- **AI election assistant** that answers questions about the regulations, and refers anything it cannot answer to the Department of Student Affairs.

### For the Election Committee
- **Roster import from Excel (.xlsx)** with an import history and batch preview. Registrations are verified automatically against the roster.
- **Election lifecycle** — create an election, open nominations, review nominees, add candidates to the chain, register voters, start and end voting.
- **Campus separation** — Kampar and Sungai Long run independent elections. Students, endorsers, results and the committee panel are all scoped to one campus.
- **Profile change review**, with changes that would move a voter between ballots blocked while voting is under way.
- **Assistant configuration** — provider (Google AI Studio, OpenRouter, OpenAI), model, temperature, top-p, top-k, reply length and system prompt. API keys are encrypted at rest.
- **Audit log** of every significant action.

### Integrity and security
- Session-token authentication on every committee API route, and on ballot verification.
- API keys encrypted with AES-256-GCM.
- Wallet ownership proven by a signed message, not typed in.
- Blockchain batch operations verified address by address, so a partially failed voter registration is reported rather than silently recorded as a success.
- Identity fields locked once an account is verified; faculty and campus locked while voting is under way.

---

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Solidity 0.8.19, Hardhat |
| Blockchain (local) | Ganache (port 7545, chain ID 1337) |
| Backend | Node.js, Express, ethers v6 |
| Database | MySQL 8 (`mysql2`) |
| Frontend | HTML, CSS, vanilla JavaScript, ethers 5 (browser), SheetJS |
| Wallet | MetaMask |
| Auth | bcrypt password hashing, database-backed session tokens |

---

## Project structure

```
utar-src-voting/
├── contracts/
│   └── SRCVoting.sol          # Multi-election, per-post voting contract
├── scripts/
│   ├── deploy.js              # Deploys the contract, writes contract.json
│   ├── seed-demo.js           # Loads demo data for a walkthrough
│   └── reset-clean.js         # Returns the system to a first-run state
├── db/
│   ├── setup.sql              # Base schema and committee accounts
│   ├── migration_v5.sql       # v5 schema changes (run once)
│   └── samples/
│       └── student_roster_test_cases.xlsx  # 22-student test roster
├── backend/
│   ├── server.js              # Express app, auth, elections, results
│   ├── routes/
│   │   ├── accounts.js        # Registration, profiles, change requests
│   │   ├── nominations.js     # Nominations and endorsements
│   │   ├── wallet.js          # Wallet linking and voter registration
│   │   └── chatbot.js         # AI assistant
│   └── lib/
│       ├── eligibility.js     # Regulation XIII rules, in one place
│       ├── ecAuth.js          # Session tokens
│       ├── walletProof.js     # Signed-message wallet verification
│       ├── contractError.js   # Readable contract revert messages
│       └── chatbot.js         # Providers, FAQ, key encryption
├── frontend/                  # Served statically by the backend
│   ├── index.html             # Landing page
│   ├── login.html / register.html / change-password.html
│   ├── vote.html              # Ballot and nomination
│   ├── endorse.html           # Endorsement requests
│   ├── results.html           # Live results and ballot verification
│   ├── profile.html
│   ├── eclogin.html / ec.html # Election Committee portal
│   └── chat-widget.js, student-nav.js, wallet.js, theme-*.css
├── hardhat.config.js
└── .env.example
```

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [MySQL](https://dev.mysql.com/downloads/) 8.0
- [Ganache](https://trufflesuite.com/ganache/) (desktop app)
- [MetaMask](https://metamask.io/) browser extension

### 1. Clone and install

```bash
git clone https://github.com/chengzd-swift/utar-src-voting.git
cd utar-src-voting
npm install
```

### 2. Start Ganache

Open Ganache and start a workspace on **port 7545** with **chain ID 1337**. Copy the private key of the **first** account (the key icon beside it) — this account deploys the contract and acts as its administrator.

### 3. Configure the environment

```bash
cp .env.example .env
```

Then edit `.env`:

| Variable | Description |
|---|---|
| `PORT` | Web server port. Default `3000`. |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection. `DB_NAME` is `utar_src_voting`. |
| `RPC_URL` | Ganache RPC endpoint. Default `http://127.0.0.1:7545`. |
| `ADMIN_PRIVATE_KEY` | Private key of the first Ganache account. |
| `CONFIG_SECRET` | Secret used to encrypt the assistant's API keys. Set any long random string. If it changes, saved API keys must be entered again. |

> `.env` is git-ignored. Never commit it.

### 4. Create the database

```bash
mysql -u root -p < db/setup.sql
mysql -u root -p utar_src_voting < db/migration_v5.sql
```

Run the migration **once only** — MySQL 8 cannot skip columns that already exist.

### 5. Compile and deploy the contract

```bash
npm run compile
npm run deploy
```

This writes the contract address and ABI to `backend/contract.json` and `frontend/contract.json`. Redeploy whenever Ganache is restarted with a fresh chain.

### 6. Start the server

```bash
npm start
```

Open **http://localhost:3000**.

### 7. Connect MetaMask

Add a network in MetaMask:

| Field | Value |
|---|---|
| Network name | Ganache |
| RPC URL | `http://127.0.0.1:7545` |
| Chain ID | `1337` |
| Currency symbol | `ETH` |

Import a Ganache account into MetaMask for each student who will vote.

---

## Default accounts

On first start the server sets default passwords. **Every account must change its password at first sign-in.**

| Portal | URL | ID | Password |
|---|---|---|---|
| Election Committee | `/eclogin.html` | `EC001`, `EC002`, `EC003` | `EC123` |
| Student | `/login.html` | *(registered student ID)* | `Student1` for seeded students |

Students register themselves at `/register.html`; accounts whose details match the imported roster are verified automatically.

---

## Demo data

### Sample roster

[`db/samples/student_roster_test_cases.xlsx`](db/samples/student_roster_test_cases.xlsx) is a ready-to-import test roster of 22 students across both campuses, with one row for each Regulation XIII case — eligible for everything, can vote but cannot stand, cannot vote, reserved-seat cases, and so on. It has three sheets:

| Sheet | Contents |
|---|---|
| **Roster** | The student rows the import reads |
| **Test Cases** | What each row is designed to test |
| **How to use** | Import instructions |

To use it, sign in to the Election Committee portal, open **Student Roster**, and upload the file. Students then register at `/register.html` with a student ID from the roster; clean matches are verified automatically.

### Seed script

To load a ready-made walkthrough — a 22-row test roster covering each regulation, demo student accounts with wallets already linked, and elections for both campuses:

```bash
node scripts/seed-demo.js
```

The script prints the wallet private keys to import into MetaMask.

To return to a clean first-run state (committee accounts are kept and reset to `EC123`):

```bash
npm run deploy
node scripts/reset-clean.js
```

Deploy first, so the system starts against an empty contract — ballots already on a chain cannot be deleted.

---

## How an election runs

1. **Import the roster** — the committee uploads the DSA student roster (`.xlsx`). A sample is provided in [`db/samples/`](db/samples/).
2. **Students register** and link their MetaMask wallet by signing a message.
3. **Create the election** for a campus and open nominations.
4. **Students nominate themselves** and name four endorsers, who each confirm from their own account.
5. **The committee reviews** nominations and adds approved candidates to the blockchain.
6. **Register voters** — eligible students' wallets are registered on the contract.
7. **Start voting** — students cast one vote per post from MetaMask.
8. **End voting** — results are final, and each student can verify their own ballot.

---

## Eligibility rules

All rules live in [`backend/lib/eligibility.js`](backend/lib/eligibility.js), so the registration page, nomination form, endorsement check and committee panel always agree.

| Action | Requirement |
|---|---|
| **Vote** | Enrolled, full-time, on campus — not on leave of absence, distance learning or an external programme (Reg 14(1)). |
| **Stand** | Voter eligibility, plus none of the Reg 4 bars: first exam not yet sat, two or fewer long trimesters left, academic probation, criminal offence, disciplinary finding or proceedings, fees in arrears, deemed unfit. Some bars can be waived in writing by the President. |
| **Endorse** | Voter eligibility on the same campus as the election, not already endorsing another nominee for the same post, and not standing for that post (Reg 20). A student barred from standing may still endorse. |

**Reserved seats:** International Representative (international students only), Postgraduate Representative (postgraduates only), and Faculty/Institute Representative (not open to foundation students; scoped to the student's own faculty).

| Student | Vote | Endorse | Stand |
|---|:---:|:---:|:---:|
| Eligible for everything | ✅ | ✅ | ✅ |
| Can vote, cannot stand | ✅ | ✅ | ❌ |
| Cannot vote | ❌ | ❌ | ❌ |

---

## Smart contract

`SRCVoting.sol` holds every election on one contract. Key functions:

| Function | Purpose |
|---|---|
| `createElection(title)` | Create an election |
| `addCandidate(electionId, name, faculty, position)` | Add a candidate to a post |
| `registerVotersBatch(electionId, voters[])` | Register eligible wallets |
| `startVoting(electionId, minutes)` / `endVoting(electionId)` | Open and close the poll (needs at least two candidates) |
| `vote(electionId, candidateId)` | Cast a vote; one per post per wallet |
| `getResults(electionId)` | Vote counts per candidate |
| `getVotedPosts(electionId, voter)` | Posts a wallet has already voted for |

Every vote emits a `VoteCast` event, which is how a student's per-post receipt is rebuilt.

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start the web server |
| `npm run compile` | Compile the contract |
| `npm run deploy` | Deploy the contract to Ganache |
| `node scripts/seed-demo.js` | Load demo data (`--reset` to clear it first) |
| `node scripts/reset-clean.js` | Return to a clean first-run state |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE: address already in use :::3000` | A server is already running. Stop it, or set a different `PORT`. |
| `Blockchain not connected` | Ganache isn't running on port 7545, or `contract.json` is missing — run `npm run deploy`. |
| MetaMask shows *Internal JSON-RPC error* | MetaMask is on the wrong network. Switch to Ganache (chain ID 1337). |
| Vote fails after restarting Ganache | A fresh chain has no contract. Redeploy, then reset or reseed the data. |
| *Please sign out and sign in again to verify your ballot* | Sessions are issued at sign-in; sign in again after a server update. |
| Assistant's API key stops working | `CONFIG_SECRET` changed. Enter the key again in the committee panel. |

---

## Author

**Cheng Zheng De** — Universiti Tunku Abdul Rahman
Final Year Project, UTAR SRC Blockchain Voting System
