'use strict';

const { web3, rpcUrl } = require('./rpc');

// Toutes les adresses ci-dessous ont ete resolues on-chain le 2026-10 via les
// getters du FeeDistributor 0xa906f338cb21815cbc4bc87ace9e68c87ef8d8f1
// (verifiees: getCode() != 0x et totalSupply() > 0).
const ADDRESSES = {
  feeDistributor: '0xa906f338cb21815cbc4bc87ace9e68c87ef8d8f1',
  gmx: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
  esGmx: '0xf42Ae1D54fd613C9bb14810b0588FaAa09a426cA',
  bnGmx: '0x35247165119B69A40edD5304969560D0ef486921',
  glp: '0x4277f8F2c384827B5273592FF7CeBd9f2C1ac258',
  weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  stakedGmxTracker: '0x908C4D94D34924765f1eDc22A1DD098397c59dD4',
  feeGmxTracker: '0xd2D1162512F927a7e282Ef43a362659E4F2a728F',
  bonusGmxTracker: '0x4d268a7d4C16ceB5a606c173Bd974984343fea13',
  feeGlpTracker: '0x4e971a87900b931fF39d1Aad67697F49835400b6',
  stakedGlpTracker: '0x1aDDD80E6039594eE970E5872D247bf0414C8903',
  gmxVester: '0x199070DDfd1CFb69173aa2F7e20906F26B363004',
  glpVester: '0xA75287d2f8b217273E7FCD7E86eF07D33972042E',
  glpManager: '0x321F653eED006AD1C29D174e17d96351BDe22649',
};

const ZERO = '0x0000000000000000000000000000000000000000';

// Adresses de vesters: un transfert vers l'une d'elles n'est PAS une sortie
// immediate, c'est de la pression de vente differee jusqu'au claim.
const VESTEES = new Set([ADDRESSES.gmxVester.toLowerCase(), ADDRESSES.glpVester.toLowerCase()]);

const TOPICS = {
  transfer: web3.utils.keccak256('Transfer(address,address,uint256)'),
  deposit: web3.utils.keccak256('Deposit(address,uint256)'),
  withdrawal: web3.utils.keccak256('Withdrawal(address,uint256)'),
  claim: web3.utils.keccak256('Claim(address,uint256)'),
};

// Trackers surveilles et ce que signifient leurs Transfer.
const TRACKERS = [
  {
    key: 'stakedGmxTracker',
    address: ADDRESSES.stakedGmxTracker,
    label: 'stakedGmxTracker',
    burn: 'UNSTAKE -> GMX redevenu liquide, vendable immédiatement',
    mint: 'STAKE -> GMX verrouillé',
    toVester: 'VERS VESTER -> esGMX en attente de vesting, pression différée',
  },
  {
    key: 'feeGmxTracker',
    address: ADDRESSES.feeGmxTracker,
    label: 'feeGmxTracker',
    burn: 'UNSTAKE de récompenses GMX',
    mint: 'STAKE de récompenses GMX',
    toVester: 'VERS VESTER',
  },
  {
    key: 'bonusGmxTracker',
    address: ADDRESSES.bonusGmxTracker,
    label: 'bonusGmxTracker',
    burn: 'UNSTAKE de bonus GMX',
    mint: 'STAKE de bonus GMX',
    toVester: 'VERS VESTER',
  },
];

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variable d'environnement ${name} invalide: ${v}`);
  return n;
}

function intFromEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`Variable d'environnement ${name} doit être un entier positif: ${v}`);
  return parseInt(v, 10);
}

module.exports = {
  ADDRESSES,
  ZERO,
  VESTEES,
  TOPICS,
  TRACKERS,
  web3,
  rpcUrl,
  stateFile: process.env.STATE_FILE || require('path').join(__dirname, '..', '.state.json'),
  chunkSize: intFromEnv('CHUNK_SIZE', 20000),
  pollIntervalMs: num('POLL_INTERVAL_MS', 12000),
  lookbackBlocks: intFromEnv('LOOKBACK_BLOCKS', 200000),
  alertThresholdGmx: num('ALERT_THRESHOLD_GMX', 50),
  accumulationWindowMs: num('ACCUMULATION_WINDOW_HOURS', 24) * 3600 * 1000,
  quiet: process.env.QUIET === 'true',
  verbose: process.env.VERBOSE === 'true',
  // Reprendre le curseur d'un run precedent au lieu de rescanner l'historique.
  resume: process.env.RESUME !== 'false',
  explorer: (txHash) => `https://arbiscan.io/tx/${txHash}`,
  explorerAddress: (addr) => `https://arbiscan.io/address/${addr}`,
};
