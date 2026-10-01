#!/usr/bin/env node
'use strict';

/**
 * Moniteur de unstake GMX sur Arbitrum (lecture seule).
 *
 * Surveille les burns des trackers GMX : un burn = l'utilisateur unstake,
 * ses tokens redeviennent liquides et vendables immediatement.
 * Suit aussi les transferts vers les vesters (pression de vente differee)
 * et la dynamique de prix GMX/ETH.
 *
 * Ce script ne signe aucune transaction. Il se contente de signaler.
 */

const { GmxUnstakeMonitor } = require('./monitor');
const { getMarketSnapshot } = require('./prices');
const config = require('./config');

async function main() {
  const args = process.argv.slice(2);
  const wantsSnapshot = args.includes('--snapshot');
  const wantsHelp = args.includes('--help') || args.includes('-h');

  if (wantsHelp) {
    console.log(`
GMX Unstake Monitor (Arbitrum) — lecture seule

Usage:
  node src/index.js              démarre la surveillance continue
  node src/index.js --snapshot   affiche un etat des lieux puis sort
  node src/index.js --help       cette aide

Le curseur de blocs et la fenetre d'accumulation sont sauvegardes dans .state.json :
un redemarrage ne rejoue pas l'historique et ne perd pas les retraits cumulés.

Variables d'environnement:
  RPC_URL                 endpoint Arbitrum (defaut: https://arb1.arbitrum.io/rpc)
  ALERT_THRESHOLD_GMX     seuil d'alerte en GMX (defaut: 50)
  POLL_INTERVAL_MS        delai entre deux scans (defaut: 12000)
  CHUNK_SIZE              blocs par requete de logs (defaut: 20000)
  LOOKBACK_BLOCKS         profondeur historique au demarrage (defaut: 200000)
  ACCUMULATION_WINDOW_HOURS  fenetre d'accumulation par portefeuille (defaut: 24)
  QUIET=true              n'affiche que les alertes
  VERBOSE=true             affiche aussi le detail des scans
  RPC_MAX_ATTEMPTS        tentatives par appel RPC en cas de rate-limit (defaut: 4)
  RESUME=false            ignore .state.json et rescanne LOOKBACK_BLOCKS blocs
  STATE_FILE              chemin du fichier d'etat (defaut: .state.json)

Surveillance:
  - UNSTAKE (burn du tracker)  -> alerte immediate, pression de vente directe
  - ACCUMULATION               -> plusieurs retraits cumules au-dessus du seuil
  - VERS VESTER                -> vente differee, a surveiller jusqu'au claim
  - MARCHE                     -> variation du ratio GMX/ETH et imbalance de flux

Aucune transaction n'est signee. Tu decedes et executes toi-meme.
    `);
    return;
  }

  if (wantsSnapshot) {
    const snap = await getMarketSnapshot();
    console.log('\n=== ETAT DES LIEUX ===');
    if (snap.gmxUsd) console.log(`GMX           $${snap.gmxUsd}`);
    if (snap.ethUsd) console.log(`ETH           $${snap.ethUsd.toLocaleString('en-US')}`);
    if (snap.gmxEth) console.log(`GMX/ETH       ${snap.gmxEth.toFixed(6)} WETH`);
    if (snap.buysSells) {
      const h = snap.buysSells.h1;
      const h24 = snap.buysSells.h24;
      console.log(`Flux 1h       ${h.buys} achats / ${h.sells} ventes`);
      console.log(`Flux 24h      ${h24.buys} achats / ${h24.sells} ventes`);
    }
    for (const w of snap.warnings) console.log(`[marché] ${w}`);
    console.log('');
    return;
  }

  const monitor = new GmxUnstakeMonitor();
  const shutdown = () => {
    console.log('\nArrêt en cours...');
    monitor.stop();
    const s = monitor.summary();
    console.log(
      `Bilan: ${s.burns} unstake(s), ${s.mints} stake(s), ${s.toVester} transfert(s) vers vester, ` +
        `${s.trackedWallets} portefeuille(s) suivi(s).`
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await monitor.start();
}

main().catch((err) => {
  console.error('Erreur fatale:', err.message);
  process.exit(1);
});
