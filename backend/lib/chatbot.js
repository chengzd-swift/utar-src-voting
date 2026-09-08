// backend/lib/chatbot.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  The election assistant.
//
//  Three things matter here:
//
//   1. The provider key never leaves the server. The student's
//      browser talks to /api/chat, and this file talks to Google,
//      OpenRouter or OpenAI. A key in front-end JavaScript is a
//      published key.
//
//   2. The key is encrypted at rest. The Election Committee pastes
//      it once; the database stores ciphertext and every read hands
//      back a masked value, so a database dump is not a stolen key.
//
//   3. The assistant answers from the regulations, and when it
//      cannot, it hands the student to the DSA counter rather than
//      inventing a rule. The FAQ below is also a working fallback:
//      if no key is configured, or the provider is down mid-demo,
//      the assistant still answers the common questions.
// ─────────────────────────────────────────────────────────────
const crypto = require("crypto");

// ── The DSA fallback, worded once and reused everywhere ───────
const DSA_CONTACT = `I'm sorry — I don't have a reliable answer to that one, and I'd rather point you to someone who does than guess.

Please contact the Department of Student Affairs:
• Location — Student Pavilion 1, Block C, Room C113
• Working hours — Monday to Friday, 8.30am to 5.30pm
• Hotline — (+6016) 210-0864
• Email — dsa@utar.edu.my

They handle SRC election enquiries directly and will be able to help you properly.`;

// ── Default system prompt ─────────────────────────────────────
// Editable by the Election Committee, but this is what ships.
const DEFAULT_SYSTEM_PROMPT = `You are the UTAR Student Representative Council (SRC) Election Assistant, helping students understand the SRC election run under Regulation XIII of the UTAR Student Representative Council Regulations.

YOUR ROLE
Answer students' questions about the SRC election: who may vote, who may stand, how nomination and endorsement work, how to register an account, how to link a MetaMask wallet, how voting works, and how results are published.

TONE
Professional, warm and patient. Students asking these questions are often anxious about a deadline or confused by a refusal. Be plain and kind. Never condescending, never stiff. Use short paragraphs.

THE RULES YOU ANSWER FROM

Eligibility to vote — Regulation 14(1)
All registered full-time foundation, undergraduate and postgraduate students may vote, EXCEPT:
 (a) students on a leave of absence;
 (b) students on Distance Learning or External Programmes.

Eligibility to stand — Regulation 4
A nominee must first be eligible to vote, and then must NOT be caught by any of:
 (b) has not yet sat the first University examination;
 (c) has two or fewer long trimesters left to complete their programme;
 (e) is on academic probation;
 (f) has committed a criminal offence — this bar has NO exception;
 (g) has been found guilty of a disciplinary offence — waivable in writing by the President;
 (h) is undergoing disciplinary proceedings — waivable in writing by the President;
 (i) is in arrears of fees — waivable in writing by the President;
 (j) has been deemed unfit by the University.

The posts — Regulation 2(1)
Chairperson, Vice Chairperson, Secretary, Treasurer, Auditor 1, Auditor 2, Faculty/Institute Representative, Campus Wide Representative, International Representative, Postgraduate Representative.
Three posts are reserved:
 • International Representative — international students only;
 • Postgraduate Representative — postgraduate students only;
 • Faculty/Institute Representative — foundation students are not eligible.

Nomination — Regulation 20
 (1) Every nomination needs four endorsers: one proposer, one seconder and two supporters. All four must confirm from their own accounts. A nominee cannot confirm on anyone's behalf.
 (2) All four endorsers must be on the same campus as the nominee and the election, and must themselves be eligible to vote.
 (3) A student may endorse only ONE nominee per post. They may endorse different people for different posts.
 A nominee may stand for only one post per election, and may not endorse a rival for the post they are contesting.

Withdrawal — Regulation 21
A nominee may withdraw, but NOT within three days of polling day.

Campaigning — Regulation 25
Campaigning runs for the three days before polling day. It is prohibited on nomination day and on polling day itself.

Campuses
Kampar and Sungai Long run separate elections with their own candidates and their own voters. A Kampar student cannot vote for a Sungai Long candidate, or endorse one, and the reverse is also true.

HOW THE SYSTEM WORKS
• Students register at the student portal, choosing their campus first. If their student ID is in the Department of Student Affairs roster, the account verifies automatically. If not, the Election Committee reviews it manually.
• Each student links their own MetaMask wallet and proves ownership by signing a short message. Signing costs nothing and sends no transaction.
• Voting is one ballot per post. A student votes separately for Chairperson, Secretary and so on, helping elect the whole council. A vote cannot be changed or cast twice for the same post.
• Every ballot is a blockchain transaction. Nobody — not even the Election Committee — can alter or delete a vote once cast.
• Votes are recorded against a wallet address, so they are pseudonymous rather than fully anonymous. Be honest about this if asked.

RULES FOR YOU
• Answer only about the SRC election, this voting system, and UTAR student matters connected to it.
• Never invent a regulation, a deadline, a date or a result. If a specific date is asked for and you do not have it, say so and refer them to the DSA.
• Never claim to know a particular student's eligibility, vote, or personal record. You have no access to student data. Tell them their own status is shown on their profile page, or that the DSA can confirm it.
• Never help anyone influence, buy, coerce or manipulate a vote, or bypass an eligibility rule. Decline warmly and firmly.
• If a question is outside the SRC election entirely, or you are not confident of the answer, give the DSA referral below rather than guessing.

WHEN YOU CANNOT ANSWER, reply with exactly this:
${DSA_CONTACT}`;

// ── Built-in FAQ ──────────────────────────────────────────────
// Used when no provider is configured, and as a safety net when a
// provider call fails. Keyed on words a student would actually type.
const FAQ = [
  { k: ["who can vote", "eligible to vote", "am i eligible to vote", "can i vote", "voting eligibility", "who is allowed to vote"],
    a: `Every registered full-time foundation, undergraduate and postgraduate student may vote (Regulation 14(1)).\n\nThere are two exceptions:\n• students on a leave of absence;\n• students on Distance Learning or External Programmes.\n\nYour own status is shown on your profile page once you sign in. If it does not look right, the Department of Student Affairs can check the roster for you.` },

  { k: ["who can stand", "who can contest", "eligible to stand", "can i be a candidate", "requirements to stand", "candidate eligibility", "run for src"],
    a: `To stand for the SRC you must first be eligible to vote, and then clear the bars in Regulation 4. You cannot stand if you:\n\n• have not yet sat your first University examination (4(b));\n• have two or fewer long trimesters left (4(c));\n• are on academic probation (4(e));\n• have committed a criminal offence (4(f));\n• have been found guilty of a disciplinary offence (4(g));\n• are undergoing disciplinary proceedings (4(h));\n• are in arrears of fees (4(i));\n• have been deemed unfit by the University (4(j)).\n\nThe President may waive 4(g), 4(h) and 4(i) in writing. Regulation 4(f) — a criminal offence — has no exception.` },

  { k: ["what posts", "which positions", "list of positions", "seats", "posts available", "positions available"],
    a: `Regulation 2(1) sets out ten posts:\n\nChairperson · Vice Chairperson · Secretary · Treasurer · Auditor 1 · Auditor 2 · Faculty/Institute Representative · Campus Wide Representative · International Representative · Postgraduate Representative.\n\nThree are reserved: the International Representative must be an international student, the Postgraduate Representative must be a postgraduate, and foundation students cannot take the Faculty/Institute Representative seat.` },

  { k: ["international representative", "postgraduate representative", "reserved post", "why is the post greyed", "cannot select position", "position greyed out"],
    a: `Three seats are reserved for particular students:\n\n• International Representative — international students only;\n• Postgraduate Representative — postgraduate students only;\n• Faculty/Institute Representative — not open to foundation students.\n\nIf a post appears greyed out on your nomination form, it is one of these and your record does not match it. The regulation is shown underneath the dropdown. If you believe your record is wrong, the DSA can correct it.` },

  { k: ["proposer", "seconder", "supporter", "endorser", "endorsement", "how many endorsers", "four people"],
    a: `Every nomination needs four endorsers under Regulation 20(1): one proposer, one seconder and two supporters.\n\nEach of them confirms from their own account — you cannot confirm on their behalf. They must be on the same campus as you and be eligible to vote themselves (20(2)), and each person may endorse only one nominee per post (20(3)). They may, however, endorse different people for different posts.\n\nYour nomination only reaches the Election Committee once all four have confirmed.` },

  { k: ["withdraw", "pull out", "cancel my nomination", "regulation 21"],
    a: `You may withdraw your nomination, but not within three days of polling day (Regulation 21). Before that window, the Withdraw button is on your nomination in the student portal.\n\nOnce voting has opened the ballot is fixed and a candidate cannot be withdrawn — please speak to the Election Committee if something has changed.` },

  { k: ["campaign", "campaigning", "poster", "regulation 25", "when can i campaign"],
    a: `Campaigning runs for the three days before polling day (Regulation 25). It is prohibited on nomination day and on polling day itself.\n\nFor what counts as campaigning material and where it may be displayed, please check with the Department of Student Affairs.` },

  { k: ["how do i register", "create account", "sign up", "registration"],
    a: `Open the student portal, choose your campus, then click "Register here".\n\nEnter your student ID first — if you are on the Department of Student Affairs roster, your name, email and faculty fill in automatically and your account is verified straight away. If your ID is not on the roster you can still register; the Election Committee will review it manually.\n\nYou will also be asked to link a MetaMask wallet, which you can do then or later from your profile page.` },

  { k: ["metamask", "wallet", "link wallet", "why wallet", "crypto", "do i need a wallet"],
    a: `Your wallet is how the system knows a ballot came from you and not from someone else.\n\nWhen you link it you sign a short message proving you control the address. Signing is free — it is not a transaction, it sends nothing and costs no gas. The Election Committee then registers your address as a voter for your campus's election.\n\nYou only need MetaMask installed and connected to the election network. If you cannot use MetaMask at all, go to the DSA counter with your student ID and the Committee can register you manually.` },

  { k: ["how do i vote", "cast vote", "voting process", "how to vote"],
    a: `Sign in to the student portal, open "Cast My Vote", and choose the election.\n\nYou vote once for each post — Chairperson, Secretary and so on — so you help elect the whole council rather than a single person. Pick a candidate, press the vote button for that post, and confirm in MetaMask. Each vote is its own blockchain transaction.\n\nPosts you have already voted for are ticked and greyed out.` },

  { k: ["change my vote", "undo vote", "vote twice", "already voted", "revote"],
    a: `No — once a vote is on the blockchain it cannot be changed, deleted or cast again for the same post. That permanence is the point: it is what makes the result impossible to tamper with, by anyone, including the Election Committee.\n\nYou can still vote for the other posts you have not voted for yet.` },

  { k: ["secret", "anonymous", "private", "who can see my vote", "is my vote secret"],
    a: `Your ballot is pseudonymous rather than fully anonymous, and it is fair that you know the difference.\n\nThe blockchain records that a wallet address voted for a candidate. It does not record your name. However, the Election Committee holds the link between your student account and your wallet address, because that is how eligibility is checked.\n\nThe Committee cannot alter your vote, and no other student can see how you voted.` },

  { k: ["results", "when are results", "who won", "count", "tally"],
    a: `Results are read directly from the blockchain and shown on the Results page, broken down by post. Because every ballot is a public transaction, anyone can verify the count independently.\n\nThe final declaration is made by the Election Committee once voting closes. For the official announcement date, please check with the Department of Student Affairs.` },

  { k: ["campus", "kampar", "sungai long", "different campus", "other campus"],
    a: `Kampar and Sungai Long run separate SRC elections, each with its own candidates and its own voters.\n\nYou vote in your own campus's election only. You also cannot endorse a nominee at the other campus (Regulation 20(2)). Your campus comes from the Department of Student Affairs roster — if it is wrong on your profile, request a correction and the Committee will review it.` },

  { k: ["forgot password", "reset password", "cannot sign in", "change password", "locked out"],
    a: `You can change your password from the portal once you are signed in.\n\nIf you cannot sign in at all, the Department of Student Affairs can reset it for you — they will need to confirm your identity with your student ID first.` },

  { k: ["not in roster", "id not found", "awaiting verification", "pending approval", "account not approved"],
    a: `If your student ID is not on the current Department of Student Affairs roster, your account is created but held for manual review, and you will see "awaiting verification".\n\nCheck first that your student ID and email are typed exactly as the University has them — you can correct them yourself on your profile page, and a corrected ID is re-checked against the roster automatically. If everything is correct and it is still pending, the DSA can confirm your enrolment record.` },

  { k: ["deadline", "when is nomination", "closing date", "polling day", "when is voting", "what date"],
    a: `I don't hold the dates for this election, and I would rather not guess at a deadline you might rely on.\n\nThe nomination closing date and polling day are shown on the election itself in the student portal, and the Department of Student Affairs can confirm them.` },
];

// Things the assistant should decline warmly rather than answer.
const REFUSALS = [
  { k: ["buy vote", "pay for vote", "sell my vote", "bribe", "vote for money"],
    a: `I can't help with that. Offering or accepting anything in exchange for a vote would be a serious breach of the election regulations and could put both students' standing at risk.\n\nIf someone has approached you about this, please report it to the Department of Student Affairs — they will treat it confidentially.` },
  { k: ["hack", "cheat", "rig", "manipulate the result", "fake vote", "bypass", "multiple accounts", "vote twice illegally"],
    a: `I can't help with that, I'm afraid.\n\nEvery ballot is recorded on a blockchain against a registered wallet, and eligibility is checked on the server rather than in the browser, so this isn't something the system can be talked around. If you have found something that looks like a genuine flaw, please report it to the Department of Student Affairs — that is a real service to the election.` },
];

// ── Settings ──────────────────────────────────────────────────
const PROVIDERS = {
  google:     { label: "Google AI Studio (Gemini)", defaultModel: "gemini-2.0-flash", keyHint: "AIza…" },
  openrouter: { label: "OpenRouter",                defaultModel: "openai/gpt-4o-mini", keyHint: "sk-or-…" },
  openai:     { label: "OpenAI",                    defaultModel: "gpt-4o-mini",       keyHint: "sk-…" },
};

const DEFAULTS = {
  provider: "google",
  model: PROVIDERS.google.defaultModel,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.3,      // low: this answers rules, it does not brainstorm
  top_p: 0.9,
  top_k: 40,
  max_tokens: 700,
  is_enabled: 1,
};

// ── Key encryption at rest ────────────────────────────────────
function secretKey() {
  const raw = process.env.CONFIG_SECRET || "utar-src-voting-development-secret";
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("hex"), c.getAuthTag().toString("hex"), enc.toString("hex")].join(":");
}

function decrypt(stored) {
  if (!stored) return null;
  try {
    const [iv, tag, data] = stored.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
  } catch {
    // Wrong CONFIG_SECRET, or the row predates encryption.
    return null;
  }
}

function maskKey(plain) {
  if (!plain) return "";
  return plain.length <= 8 ? "••••" : `${plain.slice(0, 4)}${"•".repeat(12)}${plain.slice(-4)}`;
}

// ── Storage ───────────────────────────────────────────────────
async function ensureChatbotTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS chatbot_config (
      id             TINYINT      NOT NULL PRIMARY KEY DEFAULT 1,
      provider       VARCHAR(20)  NOT NULL DEFAULT 'google',
      model          VARCHAR(80)  NOT NULL DEFAULT 'gemini-2.0-flash',
      api_key_enc    TEXT         DEFAULT NULL,
      system_prompt  MEDIUMTEXT   NOT NULL,
      temperature    DECIMAL(3,2) NOT NULL DEFAULT 0.30,
      top_p          DECIMAL(3,2) NOT NULL DEFAULT 0.90,
      top_k          INT          NOT NULL DEFAULT 40,
      max_tokens     INT          NOT NULL DEFAULT 700,
      is_enabled     TINYINT(1)   NOT NULL DEFAULT 1,
      updated_by     INT          DEFAULT NULL,
      updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  const [[row]] = await db.query("SELECT id FROM chatbot_config WHERE id=1");
  if (!row) {
    await db.execute(
      `INSERT INTO chatbot_config (id, provider, model, system_prompt, temperature, top_p, top_k, max_tokens, is_enabled)
       VALUES (1,?,?,?,?,?,?,?,?)`,
      [DEFAULTS.provider, DEFAULTS.model, DEFAULTS.system_prompt, DEFAULTS.temperature,
       DEFAULTS.top_p, DEFAULTS.top_k, DEFAULTS.max_tokens, DEFAULTS.is_enabled]
    );
  }
}

async function loadConfig(db) {
  const [[row]] = await db.query("SELECT * FROM chatbot_config WHERE id=1");
  if (!row) return { ...DEFAULTS, api_key: null };
  return {
    provider: row.provider,
    model: row.model,
    api_key: decrypt(row.api_key_enc),
    system_prompt: row.system_prompt,
    temperature: Number(row.temperature),
    top_p: Number(row.top_p),
    top_k: Number(row.top_k),
    max_tokens: Number(row.max_tokens),
    is_enabled: !!row.is_enabled,
    updated_at: row.updated_at,
  };
}

async function saveConfig(db, patch, ecUserId) {
  const current = await loadConfig(db);
  const next = { ...current, ...patch };

  // An empty key field means "leave the stored key alone" — the EC
  // never sees the real one, so they cannot retype it.
  const keyEnc = patch.api_key === undefined || patch.api_key === ""
    ? undefined
    : encrypt(String(patch.api_key).trim());

  const fields = [
    "provider=?", "model=?", "system_prompt=?", "temperature=?",
    "top_p=?", "top_k=?", "max_tokens=?", "is_enabled=?", "updated_by=?",
  ];
  const vals = [
    next.provider, next.model, next.system_prompt,
    clamp(next.temperature, 0, 2), clamp(next.top_p, 0, 1),
    Math.round(clamp(next.top_k, 1, 100)), Math.round(clamp(next.max_tokens, 64, 4000)),
    next.is_enabled ? 1 : 0, ecUserId || null,
  ];
  if (keyEnc !== undefined) { fields.push("api_key_enc=?"); vals.push(keyEnc); }

  await db.execute(`UPDATE chatbot_config SET ${fields.join(", ")} WHERE id=1`, vals);
  return loadConfig(db);
}

function clamp(n, lo, hi) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/** The config as the EC panel should see it — never the real key. */
function publicConfig(cfg) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    system_prompt: cfg.system_prompt,
    temperature: cfg.temperature,
    top_p: cfg.top_p,
    top_k: cfg.top_k,
    max_tokens: cfg.max_tokens,
    is_enabled: cfg.is_enabled,
    has_key: !!cfg.api_key,
    key_preview: maskKey(cfg.api_key),
    updated_at: cfg.updated_at,
    providers: PROVIDERS,
    default_system_prompt: DEFAULT_SYSTEM_PROMPT,
  };
}

// ── The offline answerer ──────────────────────────────────────
function normalise(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Score a question against a keyword set; higher is a better match. */
function score(question, keys) {
  const q = normalise(question);
  let best = 0;
  for (const k of keys) {
    const key = normalise(k);
    if (q.includes(key)) { best = Math.max(best, key.split(" ").length * 2); continue; }
    const words = key.split(" ").filter((w) => w.length > 3);
    if (!words.length) continue;
    const hits = words.filter((w) => q.includes(w)).length;
    if (hits === words.length) best = Math.max(best, words.length);
  }
  return best;
}

/**
 * Answer without a provider. Returns null when nothing matches well
 * enough, so the caller can fall back to the DSA referral.
 */
function faqAnswer(question) {
  for (const r of REFUSALS) if (score(question, r.k) >= 2) return { answer: r.a, matched: "policy" };
  let best = null, bestScore = 0;
  for (const f of FAQ) {
    const s = score(question, f.k);
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return bestScore >= 2 ? { answer: best.a, matched: "faq" } : null;
}

// ── Provider adapters ─────────────────────────────────────────
async function callProvider(cfg, messages, timeoutMs = 25000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    if (cfg.provider === "google")     return await callGoogle(cfg, messages, ac.signal);
    if (cfg.provider === "openrouter") return await callOpenAILike(cfg, messages, ac.signal, "https://openrouter.ai/api/v1/chat/completions");
    if (cfg.provider === "openai")     return await callOpenAILike(cfg, messages, ac.signal, "https://api.openai.com/v1/chat/completions");
    throw new Error(`Unknown provider "${cfg.provider}"`);
  } finally {
    clearTimeout(timer);
  }
}

async function callGoogle(cfg, messages, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  const res = await fetch(url, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.api_key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: cfg.system_prompt }] },
      contents,
      generationConfig: {
        temperature: cfg.temperature,
        topP: cfg.top_p,
        topK: cfg.top_k,
        maxOutputTokens: cfg.max_tokens,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(providerMessage(res.status, data?.error?.message));
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim();
  if (!text) throw new Error("The model returned an empty reply");
  return text;
}

async function callOpenAILike(cfg, messages, signal, url) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.api_key}`,
  };
  if (url.includes("openrouter")) {
    headers["HTTP-Referer"] = "http://localhost:3000";
    headers["X-Title"] = "UTAR SRC Election Assistant";
  }
  const res = await fetch(url, {
    method: "POST", signal, headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: cfg.system_prompt }, ...messages],
      temperature: cfg.temperature,
      top_p: cfg.top_p,
      max_tokens: cfg.max_tokens,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(providerMessage(res.status, data?.error?.message));
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The model returned an empty reply");
  return text;
}

/** Turn a provider HTTP failure into something an EC member can act on. */
function providerMessage(status, detail) {
  if (status === 401 || status === 403) return "The API key was rejected. Check it was pasted in full and is still active.";
  if (status === 404) return "That model name was not found for this provider. Check the spelling.";
  if (status === 429) return "The provider is rate limiting us. Wait a moment, or check the account's quota.";
  if (status >= 500) return "The provider is having problems at their end. Try again shortly.";
  return detail ? `Provider error: ${detail}` : `Provider returned HTTP ${status}`;
}

module.exports = {
  DSA_CONTACT, DEFAULT_SYSTEM_PROMPT, PROVIDERS, DEFAULTS,
  ensureChatbotTable, loadConfig, saveConfig, publicConfig,
  faqAnswer, callProvider, maskKey,
};
