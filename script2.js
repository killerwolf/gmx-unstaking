const Web3 = require('web3');
const contractAbi = require('./abi.json');

const httpProvider = 'https://arb1.arbitrum.io/rpc';

const web3 = new Web3(httpProvider);

const contractAddress = '0xa906f338cb21815cbc4bc87ace9e68c87ef8d8f1';
const contract = new web3.eth.Contract(contractAbi, contractAddress);
const eventName = 'UnstakeGmx';

let lastBlockNumber = 0;
const blockRange = 1000; // Number of blocks to query in each request

async function pollForEvents() {
    try {
        const currentBlockNumber = await web3.eth.getBlockNumber();
        
        while (lastBlockNumber < currentBlockNumber) {
            const toBlock = Math.min(lastBlockNumber + blockRange, currentBlockNumber);
            
            const events = await contract.getPastEvents(eventName, {
                fromBlock: lastBlockNumber + 1,
                toBlock: toBlock
            });

            for (const event of events) {
                console.log('New Event:', event);
            }

            lastBlockNumber = toBlock;
        }
    } catch (error) {
        console.error('Error Polling for Events:', error);
    }

    // Schedule the next poll
    setTimeout(pollForEvents, 5000); // Poll every 5 seconds
}

// Start polling
pollForEvents();
