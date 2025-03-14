const Web3 = require('web3');
const contractAbi = require('./abi.json');

const web3 = new Web3('wss://arb-mainnet.g.alchemy.com/v2/JioXxhlrbxibVZrcSrY8C1F9kzj2ASy1');

const contractAddress = '0xa906f338cb21815cbc4bc87ace9e68c87ef8d8f1';
const contract = new web3.eth.Contract(contractAbi, contractAddress);
const eventName = 'UnstakeGmx';

// Subscribe to real-time events
contract.events[eventName]({
    fromBlock: 'latest'
})
.on('connected', (subscriptionId) => {
    console.log(`Successfully subscribed with subscription ID: ${subscriptionId}`);
})
.on('data', (event) => {
    const { returnValues, blockNumber } = event;
    const { account, amount } = returnValues;

    // Convert the amount to a more readable format
    const readableAmount = web3.utils.fromWei(amount, 'ether');

    // Create a URL for the unstaker
    const unstakerUrl = `https://arbiscan.io/address/${account}`;

    // Get the block timestamp and convert it to a human-readable date
    web3.eth.getBlock(blockNumber).then((block) => {
        const date = new Date(block.timestamp * 1000).toLocaleString();

        // Log the human-readable phrase
        console.log(`On ${date}, ${unstakerUrl} unstaked ${readableAmount} GMX tokens.`);
    });
})
.on('error', (error) => {
    console.error('Error with Event Subscription:', error);
    // Handle reconnection logic if needed
});
