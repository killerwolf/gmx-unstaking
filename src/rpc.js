'use strict';

const Web3 = require('web3');

const DEFAULT_RPC_URL = 'https://arb1.arbitrum.io/rpc';
const RPC_URL = process.env.RPC_URL || DEFAULT_RPC_URL;
const MAX_ATTEMPTS = Number(process.env.RPC_MAX_ATTEMPTS || 4);

const web3 = new Web3(RPC_URL);

/** Erreurs transitoires dues à la charge du RPC public, pour lesquelles on retente. */
const TRANSIENT_PATTERNS = [
  /too many requests/i,
  /rate limit/i,
  /timeout/i,
  /timed out/i,
  /busy/i,
  /try again/i,
  /econnreset/i,
  /socket hang up/i,
  /network/i,
  /50[234]/,
];

function isTransient(err) {
  const msg = `${err && err.message} ${err && err.code} ${err && err.status}`;
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exécute un appel JSON-RPC avec retries et backoff exponentiel + jitter.
 * Le RPC public Arbitrum rate-limite vite quand on enchaîne getPastLogs puis
 * getBlock, donc tous les appels passent par ici plutôt que web3 directement.
 */
async function rpcCall(fn, label = 'rpc') {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn(web3);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS || !isTransient(err)) break;
      await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }

  const err = new Error(`${label}: ${lastErr && lastErr.message}`);
  err.cause = lastErr;
  throw err;
}

/** Hauteur de bloc courante. */
async function getBlockNumber() {
  return rpcCall((w3) => w3.eth.getBlockNumber(), 'getBlockNumber');
}

/**
 * Timestamps de plusieurs blocs. Regroupe d'abord par bloc unique : un poll
 * couvre souvent des dizaines d'événements qui tombent dans peu de blocs.
 */
async function getBlockTimestamps(blockNumbers) {
  const unique = [...new Set(blockNumbers)].filter((n) => Number.isFinite(n));
  const out = new Map();
  if (!unique.length) return out;

  for (const n of unique) {
    try {
      const b = await rpcCall((w3) => w3.eth.getBlock(n), `getBlock(${n})`);
      out.set(n, Number(b.timestamp) * 1000);
    } catch (err) {
      out.set(n, null);
    }
  }
  return out;
}

/** eth_getLogs avec retries. */
async function getPastLogs(filter) {
  return rpcCall((w3) => w3.eth.getPastLogs(filter), 'eth_getLogs');
}

module.exports = {
  web3,
  rpcUrl: RPC_URL,
  isTransient,
  rpcCall,
  getBlockNumber,
  getBlockTimestamps,
  getPastLogs,
};