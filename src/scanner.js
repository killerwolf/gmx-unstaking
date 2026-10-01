'use strict';

const { getPastLogs } = require('./rpc');
const { chunkSize, ZERO, TOPICS, TRACKERS } = require('./config');

/**
 * Recupere les logs d'un topic sur une plage de blocs, decoupee en chunks.
 * Le RPC public Arbitrum timeout sur les grandes plages ("log query timed out"),
 * d'ou le decoupage. Un chunk en echec est signale plutot que silencieusement ignore.
 */
async function fetchLogsChunked(fromBlock, toBlock, filter) {
  const logs = [];
  const failed = [];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      // Les retries/backoff sont gérés par rpc.getPastLogs.
      const chunk = await getPastLogs({ ...filter, fromBlock: start, toBlock: end });
      logs.push(...chunk);
    } catch (err) {
      // On avance quand meme pour ne pas rester bloque sur la meme plage.
      failed.push({ start, end, error: err.message });
    }
  }

  return { logs, failed };
}

/** Decode un topic d'adresse (32 octets, 20 octets utiles a la fin). */
function addressFromTopic(topic) {
  return '0x' + topic.slice(-40);
}

/** Decode un uint256 depuis un mot de 32 octets. */
function uintFromWord(word) {
  return BigInt('0x' + word.replace(/^0x/, ''));
}

/**
 * Classifie un Transfer ERC-20 sur un tracker.
 *  - from == 0x0  : mint / stake
 *  - to   == 0x0  : burn / unstake   <-- LE signal qui compte
 *  - to   == vester: transfert vers vester (pression differee)
 *  - sinon         : deplacement interne (transfert direct de staked tokens)
 */
function classifyTransfer(log) {
  const from = addressFromTopic(log.topics[1]);
  const to = addressFromTopic(log.topics[2]);
  const amount = uintFromWord(log.data);

  let kind;
  if (from === ZERO && to === ZERO) return null;
  if (to === ZERO) kind = 'burn';
  else if (from === ZERO) kind = 'mint';
  else kind = 'transfer';

  return {
    kind,
    from,
    to,
    amount,
    // Un burn : la source est le portefeuille qui recoit les tokens liberes.
    // RewardTracker._unstake fait _burn(account) puis transfere le token a l'account.
    wallet: kind === 'burn' ? from : to,
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
  };
}

/**
 * Un meme retrait apparait sur les trois trackers GMX: `compound()` unstake du
 * stakedGmxTracker, du feeGmxTracker et du bonusGmxTracker dans le meme tx, pour
 * le meme compte et le meme montant. Sans regroupement, l'accumulation par
 * portefeuille est gonflee d'un facteur 3.
 *
 * On regroupe par (transaction, compte, montant) et on retient le premier
 * evenement; `compoundOf` garde la trace des trackers regroupes.
 */
function dedupeCompounds(events) {
  const seen = new Map();
  const out = [];

  for (const ev of events) {
    const key =
      ev.kind === 'burn'
        ? `${ev.txHash}:${ev.wallet.toLowerCase()}:${ev.amount}`
        : `${ev.txHash}:${ev.kind}:${ev.from.toLowerCase()}:${ev.to.toLowerCase()}:${ev.amount}`;

    const previous = seen.get(key);
    if (previous) {
      previous.compoundOf.push(ev.tracker);
      continue;
    }
    ev.compoundOf = [];
    seen.set(key, ev);
    out.push(ev);
  }
  return out;
}

/**
 * Fetch et classe tous les Transfers des trackers sur la plage donnee.
 * Les trackers sont parcourus en parallele : 3 adresses = 3 moities du trafic
 * RPC, ce qui reste sous le rate-limit la ou une execution en serie le depassait.
 */
async function scanTrackerTransfers(fromBlock, toBlock) {
  const results = await Promise.all(
    TRACKERS.map(async (tracker) => {
      const { logs, failed } = await fetchLogsChunked(fromBlock, toBlock, {
        address: tracker.address,
        topics: [TOPICS.transfer],
      });

      const events = [];
      for (const log of logs) {
        const classified = classifyTransfer(log);
        if (!classified) continue;
        events.push({ ...classified, tracker: tracker.key, trackerLabel: tracker.label });
      }
      return { events, gaps: failed.map((f) => ({ tracker: tracker.key, ...f })) };
    })
  );

  const events = results.flatMap((r) => r.events);
  const gaps = results.flatMap((r) => r.gaps);

  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return { events: dedupeCompounds(events), gaps };
}

module.exports = {
  fetchLogsChunked,
  scanTrackerTransfers,
  dedupeCompounds,
  classifyTransfer,
  addressFromTopic,
  uintFromWord,
};
