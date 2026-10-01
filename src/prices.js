'use strict';

const { ADDRESSES } = require('./config');

const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${ADDRESSES.gmx}`;
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=gmx,ethereum&vs_currencies=usd';

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'gmx-unstaking-monitor' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.json();
}

/** Meilleure paire GMX/WETH sur Arbitrum (la plus liquide). */
function pickBestPair(data) {
  const pairs = (data && data.pairs) || [];
  const arbitrum = pairs.filter(
    (p) => p.chainId === 'arbitrum' && p.baseToken && p.baseToken.address.toLowerCase() === ADDRESSES.gmx.toLowerCase()
  );
  if (!arbitrum.length) return null;

  // Le flux qui compte pour la vente de GMX est le swap GMX contre WETH.
  arbitrum.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return arbitrum[0];
}

function parseBuySell(pair) {
  const t = (pair && pair.txns) || {};
  const bucket = (k) => ({
    buys: (t[k] && t[k].buys) || 0,
    sells: (t[k] && t[k].sells) || 0,
  });
  return { m5: bucket('m5'), h1: bucket('h1'), h6: bucket('h6'), h24: bucket('h24') };
}

function flowScore(h) {
  if (!h || h.buys + h.sells === 0) return 0;
  return (h.sells - h.buys) / (h.buys + h.sells);
}

/**
 * Snapshot de marche : ratio GMX/ETH, prix USD, et imbalance achats/ventes.
 * Le ratio GMX/ETH sert a reperer une decote du GMX par rapport au marche,
 * et le flux sert a confirmer que la pression de vente est reelle.
 */
async function getMarketSnapshot() {
  const warnings = [];
  let gmxEth = null;
  let buysSells = null;
  let gmxUsd = null;
  let ethUsd = null;

  try {
    const data = await getJson(DEXSCREENER_URL);
    const pair = pickBestPair(data);
    if (pair) {
      gmxEth = Number(pair.priceNative); // WETH par GMX
      buysSells = parseBuySell(pair);
    } else {
      warnings.push('dexscreener: aucune paire GMX/WETH trouvee sur Arbitrum');
    }
  } catch (err) {
    warnings.push(`dexscreener indisponible (${err.message})`);
  }

  try {
    const cg = await getJson(COINGECKO_URL);
    gmxUsd = cg.gmx?.usd ?? null;
    ethUsd = cg.ethereum?.usd ?? null;
  } catch (err) {
    warnings.push(`coingecko indisponible (${err.message})`);
  }

  return { gmxEth, gmxUsd, ethUsd, buysSells, warnings, at: Date.now() };
}

/** Compare deux snapshots successifs et signale les variations notables. */
function diffSnapshots(prev, next) {
  const out = [];
  if (!prev) return out;

  if (prev.gmxEth && next.gmxEth) {
    const pct = ((next.gmxEth - prev.gmxEth) / prev.gmxEth) * 100;
    if (Math.abs(pct) >= 1) {
      out.push({
        kind: 'GMX/ETH',
        value: `${next.gmxEth.toFixed(6)} WETH`,
        pct,
        text: `GMX/ETH ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
      });
    }
  }

  if (prev.buysSells && next.buysSells) {
    const p = prev.buysSells.h1;
    const n = next.buysSells.h1;
    if (p.sells !== n.sells || p.buys !== n.buys) {
      const deltaSells = n.sells - p.sells;
      const deltaBuys = n.buys - p.buys;
      if (deltaSells > 0 && flowScore(n) > 0.15) {
        out.push({
          kind: 'flux',
          value: `${n.sells} ventes / ${n.buys} achats (1h)`,
          pct: null,
          text: `pression vendeuse 1h: +${deltaSells} ventes, imbalance ${(flowScore(n) * 100).toFixed(0)}%`,
        });
      }
    }
  }

  return out;
}

module.exports = { getMarketSnapshot, diffSnapshots, flowScore };
