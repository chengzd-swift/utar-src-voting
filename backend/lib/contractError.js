// backend/lib/contractError.js — turn raw ethers/RPC failures into a message
// that's safe and useful to show an Election Committee user.
//
// Why this exists: with ethers v6 + Ganache GUI, a reverted transaction
// sometimes comes back without decodable revert data. When that happens
// ethers can't extract a reason, and naive `err.message` fallbacks were
// leaking the raw ABI-encoded request bytes (e.g. "0x15cf4a5f...") straight
// into the UI. This decodes what it safely can and otherwise returns a
// clear, generic message — the full error is still meant to be
// console.error'd by the caller for debugging.
const { AbiCoder } = require("ethers");

function isRawHexBlob(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{8,}$/.test(s.trim());
}

// Things ethers says when it could not get a reason out of the node.
// They are true but useless to an Election Committee member, so they
// must never be shown as if they explained anything.
const UNINFORMATIVE = [
  /^missing revert data$/i,
  /^execution reverted$/i,
  /^could not coalesce error$/i,
];

function isUninformative(s) {
  return typeof s === "string" && UNINFORMATIVE.some((re) => re.test(s.trim()));
}

function decodeRevertData(data) {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  const selector = data.slice(0, 10);
  try {
    if (selector === "0x08c379a0") {
      // Error(string)
      return AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
    }
    if (selector === "0x4e487b71") {
      // Panic(uint256)
      const code = AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10))[0];
      return `Contract panic (code ${code})`;
    }
  } catch {
    // fall through
  }
  return null;
}

/// @param err     the caught error (typically from an ethers Contract call)
/// @param fallback message to use when nothing decodable is found
function describeContractError(err, fallback = "Blockchain transaction failed") {
  if (err?.reason && !isRawHexBlob(err.reason)) return err.reason;

  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  const decoded = decodeRevertData(data);
  if (decoded) return decoded;

  if (err?.shortMessage && !isRawHexBlob(err.shortMessage) && !isUninformative(err.shortMessage))
    return err.shortMessage;

  switch (err?.code) {
    case "INSUFFICIENT_FUNDS":
      return "Admin wallet has insufficient funds for gas.";
    case "NETWORK_ERROR":
    case "SERVER_ERROR":
      return "Could not reach the blockchain node. Is Ganache running?";
    case "CALL_EXCEPTION":
      return "Transaction reverted without a readable reason from the node. Check that the admin wallet matches the deployed contract's admin, and that Ganache hasn't been reset since the contract was deployed.";
  }

  if (typeof err?.message === "string" && !isRawHexBlob(err.message) && !isUninformative(err.message))
    return err.message;

  return fallback;
}

/**
 * Send a contract transaction, simulating it first.
 *
 * Ganache only returns the revert reason for eth_call. For
 * eth_estimateGas — which is what a plain `contract.foo(...)` send hits
 * first — it returns no revert data at all, so ethers can only report
 * "missing revert data" and the real reason ("SRCVoting: need at least
 * 2 candidates") is lost before anyone sees it.
 *
 * Running the call first costs nothing, sends no transaction and mines
 * no block, but it makes the node hand back the reason string, which
 * then travels up through describeContractError() unchanged.
 *
 * @returns the mined receipt
 */
async function sendTx(contract, method, args = []) {
  await contract[method].staticCall(...args);   // reverts here carry a reason
  const tx = await contract[method](...args);
  return tx.wait();
}

module.exports = { describeContractError, sendTx };
