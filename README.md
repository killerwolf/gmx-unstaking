# GMX Unstaking Monitor

A collection of Node.js scripts for monitoring GMX token unstaking events on the Arbitrum blockchain. This tool connects to the GMX staking contract and tracks when users unstake their GMX tokens in real-time or historically.

## Features

- Monitor GMX unstaking events in real-time
- Fetch historical unstaking events
- Multiple implementation methods:
  - Batch historical event fetching
  - Polling for new events
  - WebSocket subscription for real-time events
  - Human-readable event formatting

## Prerequisites

- Node.js (v14 or higher recommended)
- npm or yarn

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/gmx-unstaking.git
cd gmx-unstaking

# Install dependencies
npm install
```

## Usage

The repository contains several script implementations for different use cases:

### 1. Fetch Historical Events (script.js)

Retrieves all historical unstaking events in batches:

```bash
node script.js
```

### 2. Poll for New Events (script2.js)

Continuously polls for new unstaking events every 5 seconds:

```bash
node script2.js
```

### 3. Formatted Real-time Events (script3.js)

Subscribes to unstaking events and formats them in a human-readable way with links to Arbiscan:

```bash
node script4.js
```

## Configuration

The scripts connect to the GMX staking contract on Arbitrum. If you need to modify the connection details:

- RPC endpoint: Edit the Web3 initialization in each script
- Contract address: Currently set to `0xa906f338cb21815cbc4bc87ace9e68c87ef8d8f1`
- For WebSocket scripts (script3.js and script4.js), you'll need to provide your own Alchemy API key

## License

[MIT](LICENSE)

