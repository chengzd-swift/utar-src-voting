// backend/routes/chatbot.js — UTAR SRC Voting System v5
// ─────────────────────────────────────────────────────────────
//  Two audiences, two levels of access:
//
//   • /api/chat            — any student, no key ever exposed
//   • /api/ec/chatbot/*    — Election Committee only, behind the
//                            session guard mounted on /api/ec
// ─────────────────────────────────────────────────────────────
const express = require("express");
const {
  DSA_CONTACT, DEFAULT_SYSTEM_PROMPT,
  loadConfig, saveConfig, publicConfig, faqAnswer, callProvider,
} = require("../lib/chatbot");

// A student asking questions is not a load problem; a script hammering
// a paid API is. One bucket per IP, refilled every minute.
const BUCKETS = new Map();
const LIMIT = 20, WINDOW_MS = 60_000;

function rateLimited(ip) {
  const now = Date.now();
  const b = BUCKETS.get(ip);
  if (!b || now > b.reset) { BUCKETS.set(ip, { n: 1, reset: now + WINDOW_MS }); return false; }
  b.n += 1;
  return b.n > LIMIT;
}
// Keep the map from growing forever on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of BUCKETS) if (now > b.reset) BUCKETS.delete(ip);
}, 5 * WINDOW_MS).unref();

module.exports = function chatbotRoutes({ db, logAudit }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════
  //  STUDENT — ask a question
  // ═══════════════════════════════════════════════════════════
  // POST /api/chat  { message, history?: [{role, content}] }
  router.post("/chat", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "Please type a question first." });
    if (message.length > 1000)
      return res.status(413).json({ error: "That question is a little long — could you shorten it?" });
    if (rateLimited(req.ip))
      return res.status(429).json({ error: "You're sending questions faster than I can answer. Give me a moment." });

    try {
      const cfg = await loadConfig(db);

      if (!cfg.is_enabled)
        return res.json({ success: true, source: "disabled",
          answer: `The election assistant is switched off at the moment.\n\n${DSA_CONTACT}` });

      // No key configured: the built-in FAQ still answers the common
      // questions, so the assistant is never simply broken.
      if (!cfg.api_key) {
        const hit = faqAnswer(message);
        return res.json({ success: true, source: hit ? "faq" : "fallback",
          answer: hit ? hit.answer : DSA_CONTACT });
      }

      // Only the last few turns go to the provider: enough for
      // follow-up questions, not enough to drift or run up a bill.
      const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
      const messages = [
        ...history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
        { role: "user", content: message },
      ];

      try {
        const answer = await callProvider(cfg, messages);
        return res.json({ success: true, source: "ai", answer });
      } catch (err) {
        // A provider outage mid-demo must not leave a student with a
        // spinner. Answer from the FAQ, and only then refer to the DSA.
        console.error("Chatbot provider failed:", err.message);
        const hit = faqAnswer(message);
        return res.json({
          success: true,
          source: hit ? "faq-fallback" : "fallback",
          answer: hit ? hit.answer : DSA_CONTACT,
        });
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "The assistant is unavailable right now.", answer: DSA_CONTACT });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  ELECTION COMMITTEE — configuration
  // ═══════════════════════════════════════════════════════════

  // GET /api/ec/chatbot/config — never returns the real key
  router.get("/ec/chatbot/config", async (req, res) => {
    try {
      res.json({ success: true, config: publicConfig(await loadConfig(db)) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not load the assistant settings" });
    }
  });

  // PUT /api/ec/chatbot/config
  router.put("/ec/chatbot/config", async (req, res) => {
    try {
      const b = req.body || {};
      const patch = {};
      for (const f of ["provider", "model", "system_prompt"]) if (b[f] !== undefined) patch[f] = String(b[f]);
      for (const f of ["temperature", "top_p", "top_k", "max_tokens"]) if (b[f] !== undefined) patch[f] = Number(b[f]);
      if (b.is_enabled !== undefined) patch.is_enabled = !!b.is_enabled;
      // Absent or blank means "keep the stored key".
      if (b.api_key !== undefined) patch.api_key = b.api_key;

      if (patch.system_prompt !== undefined && !patch.system_prompt.trim())
        return res.status(400).json({ error: "The system prompt cannot be empty." });
      if (patch.provider && !["google", "openrouter", "openai"].includes(patch.provider))
        return res.status(400).json({ error: "Unknown provider." });

      const saved = await saveConfig(db, patch, req.ec?.userId);
      await logAudit(null, "election_committee", null, "CHATBOT_CONFIG_UPDATED",
        `Assistant settings updated (${saved.provider} · ${saved.model})`, req.ip);
      res.json({ success: true, message: "Assistant settings saved.", config: publicConfig(saved) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not save the assistant settings" });
    }
  });

  // POST /api/ec/chatbot/test — one live round trip, so the EC finds
  // out the key is wrong now rather than during the election.
  router.post("/ec/chatbot/test", async (req, res) => {
    try {
      const cfg = await loadConfig(db);
      if (!cfg.api_key)
        return res.status(400).json({ error: "No API key is saved yet. Paste one and save before testing." });
      const question = String(req.body?.message || "In one sentence, who is allowed to vote in the SRC election?");
      const started = Date.now();
      const answer = await callProvider(cfg, [{ role: "user", content: question }], 20000);
      res.json({ success: true, ms: Date.now() - started, provider: cfg.provider, model: cfg.model, answer });
    } catch (err) {
      res.status(502).json({ error: err.message || "The test call failed." });
    }
  });

  // POST /api/ec/chatbot/reset-prompt
  router.post("/ec/chatbot/reset-prompt", async (req, res) => {
    try {
      const saved = await saveConfig(db, { system_prompt: DEFAULT_SYSTEM_PROMPT }, req.ec?.userId);
      res.json({ success: true, message: "System prompt restored to the shipped default.", config: publicConfig(saved) });
    } catch (err) {
      res.status(500).json({ error: "Could not restore the prompt" });
    }
  });

  return router;
};
