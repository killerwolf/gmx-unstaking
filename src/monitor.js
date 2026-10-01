'use strict';

const fs = require('fs');
const config = require('./config');
const { scanTrackerTransfers } = require('./scanner');
const { getMarketSnapshot, diffSnapshots } = require('./prices');
const { getBlockNumber, getBlockTimestamps } = require('./rpc');

const { VESTEES } = config;

const WAD = 10n ** 18n;

function fmtGmx(amountWei) {
  const whole = amountWei / WAD;
  const frac = amountWei % WAD;
  const s = whole.toString();
  if (frac === 0n) return s;
  const f = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return `${s}.${f.slice(0, 4)}`;
}

function fmtUsd(amountWei, gmxUsd) {
  if (!gmxUsd) return '? USD';
  const gmx = Number(amountWei) / 1e18;
  return `$${(gmx * gmxUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

class GmxUnstakeMonitor {
  constructor(opts = {}) {
    this.thresholdWei = BigInt(Math.round((opts.thresholdGmx ?? config.alertThresholdGmx) * 1e18));
    this.accumulationWindowMs = opts.accumulationWindowMs ?? config.accumulationWindowMs;
    this.chunkSize = opts.chunkSize ?? config.chunkSize;
    this.pollIntervalMs = opts.pollIntervalMs ?? config.pollIntervalMs;
    this.lookbackBlocks = opts.lookbackBlocks ?? config.lookbackBlocks;
    this.quiet = opts.quiet ?? config.quiet;
    this.verbose = opts.verbose ?? config.verbose;
    this.running = false;
    this.cursor = null;
    this.walletStats = new Map(); // address -> { address, events: [{ amount, ts }] }
    this.lastSnapshot = null;
    this.alerted = new Set(); // wallets dont l'accumulation a deja ete signalee
    this.stats = { scans: 0, burns: 0, mints: 0, toVester: 0, gaps: 0, lastScanAt: null };
    this.stateFile = opts.stateFile ?? config.stateFile;
    this.resume = opts.resume ?? config.resume;
  }

  /** Total et nombre de retraits d'un portefeuille sur la fenetre glissante. */
  walletTotal(st) {
    let total = 0n;
    for (const ev of st.events) total += ev.amount;
    return { total, count: st.events.length };
  }

  /**
   * Etat persiste (curseur de blocs + evenements de la fenetre glissante) pour
   * qu'un redemarrage ne rejoue pas l'historique et ne perde pas l'accumulation.
   * On persiste les evenements et non un total cumule, sinon un portefeuille
   * sorti il y a trois jours resterait faussement dans la fenetre.
   */
  saveState() {
    if (!this.stateFile) return;
    try {
      const wallets = {};
      for (const [k, st] of this.walletStats) {
        wallets[k] = {
          address: st.address,
          events: st.events.map((e) => ({ amount: e.amount.toString(), ts: e.ts })),
        };
      }
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({ cursor: this.cursor, savedAt: Date.now(), wallets }),
        'utf8'
      );
    } catch (err) {
      this.debug(`[etat] écriture impossible (${err.message})`);
    }
  }

  loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (err) {
      this.debug(`[etat] illisible (${err.message})`);
      return null;
    }
  }

  restoreState(head) {
    const state = this.loadState();
    if (!state || !Number.isFinite(state.cursor)) return false;

    // Un curseur dans le futur (changement de branche/réorg) est ignoré.
    if (state.cursor > head) return false;

    this.cursor = state.cursor;
    for (const [k, st] of Object.entries(state.wallets || {})) {
      this.walletStats.set(k, {
        address: st.address,
        events: (st.events || []).map((e) => ({ amount: BigInt(e.amount), ts: e.ts })),
      });
    }
    this.log(`[etat] repris au bloc ${this.cursor} (${this.walletStats.size} portefeuille(s) en mémoire)`);
    return true;
  }

  log(...args) {
    if (!this.quiet) console.log(...args);
  }

  debug(...args) {
    if (this.verbose) console.log(...args);
  }

  async start() {
    this.running = true;
    const head = await getBlockNumber();

    if (this.resume && this.restoreState(head)) {
      // Reprise d'une session precedente: pas d'historique, on ne surveille que l'avenir.
      this.log(`\nGMX Unstake Monitor — reprise au bloc ${this.cursor} (head ${head})`);
    } else {
      this.cursor = Math.max(0, head - this.lookbackBlocks);
      this.log(`\nGMX Unstake Monitor — curseur initial bloc ${this.cursor} (head ${head})`);
    }
    this.log(`Seuil d'alerte: ${fmtGmx(this.thresholdWei)} GMX  |  fenêtre d'accumulation: ${this.accumulationWindowMs / 3600000} h\n`);

    this.lastSnapshot = await getMarketSnapshot();
    if (this.lastSnapshot.warnings.length) {
      for (const w of this.lastSnapshot.warnings) this.debug(`  [marché] ${w}`);
    }

    while (this.running) {
      try {
        await this.poll();
      } catch (err) {
        this.log(`[erreur] ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  stop() {
    this.running = false;
  }

  async poll() {
    const head = await getBlockNumber();
    // poll() peut être appelé sans start(): on initialise alors le curseur, en
    // tentant d'abord de reprendre l'etat persiste pour ne pas le contourner.
    if (this.cursor === null) {
      if (this.resume && this.restoreState(head)) {
        this.log(`\nGMX Unstake Monitor — reprise au bloc ${this.cursor} (head ${head})`);
      } else {
        this.cursor = Math.max(0, head - this.lookbackBlocks);
        this.log(`\nGMX Unstake Monitor — curseur initial bloc ${this.cursor} (head ${head})`);
      }
      this.log(`Seuil d'alerte: ${fmtGmx(this.thresholdWei)} GMX  |  fenêtre d'accumulation: ${this.accumulationWindowMs / 3600000} h\n`);
    }
    const fromBlock = this.cursor + 1;
    if (fromBlock > head) {
      this.debug(`[idle] aucun nouveau bloc (head ${head})`);
      return;
    }

    this.debug(`[scan] blocs ${fromBlock}..${head}`);
    const { events, gaps } = await scanTrackerTransfers(fromBlock, head);
    this.cursor = head;
    this.stats.scans += 1;
    this.stats.lastScanAt = Date.now();

    if (gaps.length) {
      this.stats.gaps += gaps.length;
      for (const g of gaps) this.log(`  [gap] ${g.tracker} blocs ${g.start}-${g.end}: ${g.error || 'échec'}`);
    }

    const fresh = await this.withTimestamps(events);

    for (const ev of fresh) {
      if (ev.kind === 'burn') this.stats.burns += 1;
      else if (ev.kind === 'mint') this.stats.mints += 1;
      else if (ev.kind === 'transfer' && VESTEES.has(ev.to.toLowerCase())) this.stats.toVester += 1;
    }

    this.accumulate(fresh);
    this.saveState();

    const snapshot = await getMarketSnapshot();
    const moves = diffSnapshots(this.lastSnapshot, snapshot);
    this.lastSnapshot = snapshot;

    this.report(fresh, moves, snapshot);
  }

  /**
 * Attache un timestamp a chaque evenement, en ne resolution qu'une fois par bloc
 * unique: un poll couvre souvent des dizaines d'evenements sur peu de blocs.
 */
withTimestamps(events) {
    if (!events.length) return [];
    const now = Date.now();
    return getBlockTimestamps(events.map((e) => e.blockNumber)).then((map) =>
      events.map((ev) => ({ ...ev, ts: map.get(ev.blockNumber) ?? now }))
    );
  }

  accumulate(events) {
    const cutoff = Date.now() - this.accumulationWindowMs;
    for (const ev of events) {
      if (ev.kind !== 'burn') continue;
      const key = ev.wallet.toLowerCase();
      let st = this.walletStats.get(key);
      if (!st) {
        st = { address: ev.wallet, events: [] };
        this.walletStats.set(key, st);
      }
      st.events.push({ amount: ev.amount, ts: ev.ts });
    }
    // Purge des retraits hors fenetre glissante.
    for (const [k, st] of this.walletStats) {
      st.events = st.events.filter((e) => e.ts >= cutoff);
      if (!st.events.length) this.walletStats.delete(k);
    }
  }

  report(events, moves, snapshot) {
    const big = events.filter((e) => e.kind === 'burn' && e.amount >= this.thresholdWei);
    const toVester = events.filter(
      (e) => e.kind === 'transfer' && VESTEES.has(e.to.toLowerCase()) && e.amount >= this.thresholdWei
    );

    // Accumulation: un portefeuille qui sort par morceaux finit par dépasser le seuil.
    // On ne le signale qu'une fois par Crossing du seuil, sinon l'alerte se
    // réafficherait a chaque poll alors qu'aucun nouvel evenement n'est arrive.
    const accumBig = [];
    for (const [key, st] of this.walletStats) {
      const { total, count } = this.walletTotal(st);
      if (total < this.thresholdWei || count <= 1) continue;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      accumBig.push({ key, address: st.address, total, count, lastTs: st.events[st.events.length - 1].ts });
    }
    // Un portefeuille dont la fenetre a expiré peut de nouveau alerter.
    for (const key of [...this.alerted]) {
      if (!this.walletStats.has(key)) this.alerted.delete(key);
    }

    if (!big.length && !toVester.length && !accumBig.length && !moves.length) {
      if (this.verbose) {
        this.debug(`[ras] ${events.length} transfert(s) sous le seuil, aucun mouvement notable`);
      }
      return;
    }

    const gmxUsd = snapshot.gmxUsd;
    const when = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16);

    for (const ev of big) {
      this.log(`\n🔥 UNSTAKE  ${fmtGmx(ev.amount)} GMX (${fmtUsd(ev.amount, gmxUsd)})`);
      this.log(`   portefeuille: ${ev.wallet}`);
      this.log(`   source:       ${ev.trackerLabel}${ev.compoundOf.length ? ` (+ ${ev.compoundOf.join(', ')} — même tx, compté une fois)` : ''}`);
      this.log(`   bloc ${ev.blockNumber}  ${when(ev.ts)} UTC`);
      this.log(`   tx: ${config.explorer(ev.txHash)}`);
      const st = this.walletStats.get(ev.wallet.toLowerCase());
      if (st) {
        const { total, count } = this.walletTotal(st);
        if (count > 1) {
          this.log(`   accumulé sur la fenêtre: ${fmtGmx(total)} GMX en ${count} retraits`);
        }
      }
    }

    for (const ev of toVester) {
      this.log(`\n⏳ VERS VESTER  ${fmtGmx(ev.amount)} GMX  (pas liquide tout de suite, claim plus tard)`);
      this.log(`   de: ${ev.from}`);
      this.log(`   vers: ${ev.to}`);
      this.log(`   bloc ${ev.blockNumber}  ${when(ev.ts)} UTC`);
      this.log(`   tx: ${config.explorer(ev.txHash)}`);
    }

    for (const st of accumBig) {
      if (big.some((b) => b.wallet.toLowerCase() === st.address.toLowerCase())) continue;
      this.log(`\n📊 ACCUMULATION  ${fmtGmx(st.total)} GMX  en ${st.count} retraits`);
      this.log(`   portefeuille: ${st.address}`);
      this.log(`   dernière activité: ${when(st.lastTs)} UTC`);
      this.log(`   profil: ${config.explorerAddress(st.address)}`);
    }

    for (const m of moves) {
      this.log(`\n📈 MARCHÉ  ${m.text}${m.value ? `  (${m.value})` : ''}`);
    }

    const warnings = (snapshot && snapshot.warnings) || [];
    for (const w of warnings) this.log(`   [marché] ${w}`);

    this.log('');
  }

  summary() {
    const top = [...this.walletStats.values()]
      .map((st) => ({ address: st.address, ...this.walletTotal(st) }))
      .sort((a, b) => (b.total > a.total ? 1 : -1))
      .slice(0, 5)
      .map((w) => ({ address: w.address, gmx: fmtGmx(w.total), retraits: w.count }));

    return {
      ...this.stats,
      cursor: this.cursor,
      trackedWallets: this.walletStats.size,
      thresholdGmx: Number(this.thresholdWei) / 1e18,
      windowHours: this.accumulationWindowMs / 3600000,
      topWallets: top,
    };
  }
}

module.exports = { GmxUnstakeMonitor, fmtGmx, fmtUsd };
