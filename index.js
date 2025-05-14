require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
// Ubah import ethers
const { JsonRpcProvider, Contract } = require('ethers');

const app = express();
const PORT = 3001;

// MongoDB setup
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db, stakesCollection;

// Ethers setup (v6)
const provider = new JsonRpcProvider(process.env.RPC_URL);
const contractAddress = process.env.CONTRACT_ADDRESS;
const contractABI = [
    "event Staked(address indexed user, uint256 indexed poolId, uint256 amount)",
    "event Unstaked(address indexed user, uint256 indexed poolId, uint256 amount, uint256 reward)",
    "event UnstakedEarly(address indexed user, uint256 indexed poolId, uint256 amount)"
];
const contract = new Contract(contractAddress, contractABI, provider);

// Helper: Insert or update stake
async function upsertStake(user, poolId, amount, startTime, status) {
    await stakesCollection.updateOne(
        { user, poolId, startTime },
        { $set: { user, poolId, amount, startTime, status } },
        { upsert: true }
    );
}

// Helper: Mark stake as unstaked
async function markUnstaked(user, poolId, amount) {
    await stakesCollection.updateOne(
        { user, poolId, amount, status: "active" },
        { $set: { status: "unstaked" } }
    );
}

// Listen to events from blockchain
async function listenEvents() {
    let lastBlock = parseInt(process.env.START_BLOCK);
    const latestBlock = await provider.getBlockNumber();
    console.log(`Syncing events from block ${lastBlock} to ${latestBlock}`);

    // Query events in batches to avoid rate limit
    const BATCH_SIZE = 1000;
    for (let fromBlock = lastBlock; fromBlock <= latestBlock; fromBlock += BATCH_SIZE) {
        const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, latestBlock);

        // Staked
        const stakedEvents = await contract.queryFilter("Staked", fromBlock, toBlock);
        for (const ev of stakedEvents) {
            await upsertStake(
                ev.args.user,
                Number(ev.args.poolId),
                ev.args.amount.toString(),
                ev.blockNumber,
                "active"
            );
        }
        // Unstaked
        const unstakedEvents = await contract.queryFilter("Unstaked", fromBlock, toBlock);
        for (const ev of unstakedEvents) {
            await markUnstaked(
                ev.args.user,
                Number(ev.args.poolId),
                ev.args.amount.toString()
            );
        }
        // UnstakedEarly
        const unstakedEarlyEvents = await contract.queryFilter("UnstakedEarly", fromBlock, toBlock);
        for (const ev of unstakedEarlyEvents) {
            await markUnstaked(
                ev.args.user,
                Number(ev.args.poolId),
                ev.args.amount.toString()
            );
        }

        // Optional: log progress
        console.log(`Synced blocks ${fromBlock} to ${toBlock}`);
    }

    // Listen for new events (realtime)
    contract.on("Staked", async (user, poolId, amount, event) => {
        await upsertStake(user, Number(poolId), amount.toString(), event.blockNumber, "active");
        console.log(`Staked: ${user} pool ${Number(poolId)} amount ${amount}`);
    });
    contract.on("Unstaked", async (user, poolId, amount, reward, event) => {
        await markUnstaked(user, Number(poolId), amount.toString());
        console.log(`Unstaked: ${user} pool ${Number(poolId)} amount ${amount}`);
    });
    contract.on("UnstakedEarly", async (user, poolId, amount, event) => {
        await markUnstaked(user, Number(poolId), amount.toString());
        console.log(`UnstakedEarly: ${user} pool ${Number(poolId)} amount ${amount}`);
    });
}

// API endpoint: get all active stakes
app.get('/api/active-stakes', async (req, res) => {
    const stakes = await stakesCollection.find({ status: "active" }).toArray();
    res.json(stakes);
});

// Start everything
async function start() {
    await mongoClient.connect();
    db = mongoClient.db();
    stakesCollection = db.collection('stakes');
    await listenEvents();
    app.listen(PORT, () => console.log(`Backend running at http://localhost:${PORT}`));
}

start();
