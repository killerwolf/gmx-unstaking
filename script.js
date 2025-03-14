const Web3 = require('web3');
const contractAbi = require('./abi.json');

const web3 = new Web3('https://arb1.arbitrum.io/rpc');

const contractAddress = '0xa906f338cb21815cbc4bc87ace9e68c87ef8d8f1';
const contract = new web3.eth.Contract(contractAbi, contractAddress);
const eventName = 'UnstakeGmx';

const batchSize = BigInt(1000); // Convert batchSize to BigInt

async function fetchEvents() {
    try {
        const latestBlock = BigInt(await web3.eth.getBlockNumber()); // Convert latestBlock to BigInt
        let fromBlock = BigInt(0); // Convert fromBlock to BigInt

        while (fromBlock <= latestBlock) {
            const toBlock = fromBlock + batchSize > latestBlock ? latestBlock : fromBlock + batchSize;
            console.log(`Fetching events from block ${fromBlock.toString()} to ${toBlock.toString()}...`);

            const events = await contract.getPastEvents(eventName, {
                fromBlock: fromBlock.toString(), // Convert BigInt to string
                toBlock: toBlock.toString() // Convert BigInt to string
            });

            console.log('Fetched Events:', events);

            fromBlock = toBlock + BigInt(1); // Update the start block for the next batch using BigInt arithmetic
        }
    } catch (err) {
        console.error('Error Fetching Past Events:', err);
    }
}

fetchEvents();