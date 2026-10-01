# GMX Unstaking Monitor

Moniteur **lecture seule** des retraits (unstakes) de GMX sur Arbitrum.

Objectif : repérer en avance les gros portefeuilles qui retirent leur GMX du staking,
parce que ce GMX redevient immédiatement liquide et vendable — donc susceptible de faire
bouger le prix. L'outil **signale**, il n'exécute aucune transaction : la décision et
l'exécution restent à ta main.

## Le signal surveillé, et pourquoi

Le premier réflexe serait d'écouter l'événement `UnstakeGmx(address,address,uint256)`
émis par le FeeDistributor `0xa906f338cb21815cbc4bc87ace9e68c87ef8d8f1`. **Cet événement est mort** :
un scan de 400 000 blocs (~2 mois) ne renvoie rien. Le FeeDistributor est un contrat
déprécié que GMX n'émet plus. Les scripts initiaux du dépôt restaient branchés dessus
et ne pouvaient donc rien voir ; ils ont été supprimés au profit de ce moniteur.

Le vrai chemin d'un unstake, dans le code GMX (`RewardRouterV2._unstakeGmx` → `RewardTracker._unstake`) :

1. `stakedGmxTracker.unstakeForAccount(...)` est appelé ;
2. `RewardTracker._unstake()` fait `_burn(account, amount)` — le token de staking est détruit ;
3. le GMX liquide est transféré au wallet de l'utilisateur.

Donc **le burn du token de staking est le vrai signal** : un `Transfer` ERC-20 vers
`address(0)` sur l'un des trackers GMX. C'est ce que le moniteur suit.

> Nuance importante : un unstake n'est **pas** une vente. Le GMX libéré peut être
> revendu, re-staké, ou mis au vestage. Une part non négligeable des transferts va
> vers le `gmxVester`, ce qui repousse la pression de vente jusqu'au claim. Le
> moniteur distingue ces cas.

## Ce qui est surveillé

| Catégorie | Signification |
|---|---|
| 🔥 **UNSTAKE** | Burn du `stakedGmxTracker` : GMX redevenu liquide, vendable immédiatement. |
| 📊 **ACCUMULATION** | Un portefeuille qui sort par morceaux et dépasse le seuil sur la fenêtre glissante. |
| ⏳ **VERS VESTER** | Transfert vers `gmxVester` / `glpVester` : pression de vente **différée**, jusqu'au claim. |
| 📈 **MARCHÉ** | Variation du ratio GMX/ETH et imbalance achats/ventes sur le DEX. |

Trackers surveillés : `stakedGmxTracker`, `feeGmxTracker`, `bonusGmxTracker`.

## Installation

```bash
npm install
```

## Usage

```bash
node src/index.js              # surveillance continue
node src/index.js --snapshot   # état des lieux du marché puis sortie
node src/index.js --help       # aide
```

Le curseur de blocs et la fenêtre d'accumulation sont persistés dans `.state.json` :
un redémarrage ne rejoue pas l'historique et ne perd pas les retraits cumulés.
Utilise `RESUME=false` pour repartir de zéro.

## Configuration

Tout se règle par variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `RPC_URL` | `https://arb1.arbitrum.io/rpc` | Endpoint Arbitrum. **Fortement recommandé : un RPC dédié.** Le public rate-limite et le code travaille par-dessus. Voir [RPC dédié](#rpc-dédié-recommandé). |
| `ALERT_THRESHOLD_GMX` | `50` | Seuil d'alerte en GMX. À ajuster selon la taille typique des transactions (max récent observé : ~434 GMX). |
| `POLL_INTERVAL_MS` | `12000` | Délai entre deux scans. |
| `CHUNK_SIZE` | `20000` | Blocs par `eth_getLogs`. Le RPC public time-out au-delà. |
| `LOOKBACK_BLOCKS` | `200000` | Profondeur historique au premier démarrage. |
| `ACCUMULATION_WINDOW_HOURS` | `24` | Fenêtre glissante d'accumulation par portefeuille. |
| `RPC_MAX_ATTEMPTS` | `4` | Tentatives par appel RPC en cas de rate-limit. |
| `RESUME` | `true` | `false` pour ignorer `.state.json`. |
| `STATE_FILE` | `.state.json` | Chemin du fichier d'état. |
| `QUIET` / `VERBOSE` | `true` | `QUIET` n'affiche que les alertes, `VERBOSE` ajoute le détail des scans. |

## Marché

Prix et ratio GMX/ETH via Dexscreener, repli sur CoinGecko. Le suivi de flux sert à
confirmer qu'une pression vendeuse est réelle sur le DEX, pas seulement on-chain.

## RPC dédié (recommandé)

Le RPC public `arb1.arbitrum.io` tient sur une fenêtre de quelques dizaines de milliers de
blocs, puis se met à répondre `Too Many Requests`. Le code gère ça (retries + backoff,
`[gap]` signalés sans planter), mais un RPC dédié supprime le problème et accélère
nettement les scans. Les plans gratuits d'Alchemy ou QuickNode suffisent largement.

```bash
export RPC_URL='https://arb-mainnet.g.alchemy.com/v2/TON_CLE'
node src/index.js
```

La clé se lit depuis l'environnement uniquement — **ne la mets jamais dans le code ni
dans un fichier versionné**. Utilise un `.env` chargé par ton shell, ou une variable
exportée dans ton lanceur.

## Limites connues

- Le RPC public Arbitrum rate-limite : en cas de trou, le moniteur affiche `[gap]` et
  continue plutôt que de planter. Un RPC dédié élimine ce risque.
- Un même retrait apparaît sur les trois trackers dans une seule transaction (`compound()`).
  Ces événements sont regroupés pour ne compter qu'une fois ; le détail est indiqué dans l'alerte.
- Un unstake n'est pas une vente. Le moniteur signale l'événement, pas l'intention.
- Un front-run « vendre avant / racheter après » est une opération à risque élevé :
  entre l'unstake et la vente réelle, il peut s'écouler des heures ou des jours, et la
  vente peut ne jamais avoir lieu.

## Licence

MIT
