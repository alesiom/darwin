// Wallet lifecycle: generate keypairs, check balances, fund agents, sweep funds.

import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readJson, writeJson, log, retry, agentId, agentDir } from './utils.js';
import 'dotenv/config';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey(process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

function getConnection() {
  return new Connection(RPC_URL, 'confirmed');
}

// --- Keypair Generation ---

// Generate a Solana keypair, save to disk, and lock file permissions.
export async function generateKeypair(walletPath) {
  const keypair = Keypair.generate();
  const data = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey)
  };
  await writeJson(walletPath, data);
  await chmod(walletPath, 0o600);
  return keypair;
}

// Load a keypair from a JSON file on disk.
export function loadKeypair(walletPath) {
  return readJson(walletPath).then(data => {
    if (!data) return null;
    return Keypair.fromSecretKey(Uint8Array.from(data.secretKey));
  });
}

// --- Balance Queries ---

// Get SOL balance in lamports and human-readable format.
export async function getSolBalance(publicKey) {
  const conn = getConnection();
  const lamports = await conn.getBalance(publicKey);
  return { lamports, sol: lamports / LAMPORTS_PER_SOL };
}

// Get USDC balance for a wallet. Returns 0 if no token account exists.
export async function getUsdcBalance(publicKey) {
  const conn = getConnection();
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, publicKey);
    const account = await getAccount(conn, ata);
    const raw = Number(account.amount);
    return { raw, usdc: raw / Math.pow(10, USDC_DECIMALS) };
  } catch (err) {
    if (err.name === 'TokenAccountNotFoundError') {
      return { raw: 0, usdc: 0 };
    }
    throw err;
  }
}

// Get combined balance (SOL + USDC) for a wallet.
export async function getBalance(publicKey) {
  const [sol, usdc] = await Promise.all([
    getSolBalance(publicKey),
    getUsdcBalance(publicKey)
  ]);
  return { sol, usdc };
}

// --- Wallet Generation ---

// Generate master wallet (wallet 0) and 100 agent wallets.
export async function generateAllWallets({ count = 100 } = {}) {
  const masterPath = 'config/master-wallet.json';
  if (existsSync(masterPath)) {
    log.warn('Master wallet already exists, skipping generation');
  } else {
    const master = await generateKeypair(masterPath);
    log.info(`Master wallet generated: ${master.publicKey.toBase58()}`);
  }

  for (let i = 1; i <= count; i++) {
    const dir = agentDir(i);
    const walletPath = `${dir}/wallet.json`;
    if (existsSync(walletPath)) {
      log.debug(`Agent ${agentId(i)} wallet exists, skipping`, { agent: agentId(i) });
      continue;
    }
    await mkdir(dir, { recursive: true });
    const kp = await generateKeypair(walletPath);
    log.info(`Agent ${agentId(i)} wallet: ${kp.publicKey.toBase58()}`, { agent: agentId(i) });
  }

  log.info(`Wallet generation complete: master + ${count} agents`);
}

// --- Funding ---

// Transfer USDC from master wallet to an agent wallet.
export async function fundAgent(masterKeypair, agentPublicKey, usdcAmount) {
  const conn = getConnection();
  const usdcRaw = Math.round(usdcAmount * Math.pow(10, USDC_DECIMALS));

  const masterAta = await getAssociatedTokenAddress(USDC_MINT, masterKeypair.publicKey);
  const agentAta = await getAssociatedTokenAddress(USDC_MINT, agentPublicKey);

  const tx = new Transaction();

  // Create agent's USDC token account if it doesn't exist
  try {
    await getAccount(conn, agentAta);
  } catch {
    tx.add(
      createAssociatedTokenAccountInstruction(
        masterKeypair.publicKey,
        agentAta,
        agentPublicKey,
        USDC_MINT
      )
    );
  }

  // Transfer USDC
  tx.add(
    createTransferInstruction(
      masterAta,
      agentAta,
      masterKeypair.publicKey,
      usdcRaw
    )
  );

  const sig = await retry(
    () => sendAndConfirmTransaction(conn, tx, [masterKeypair]),
    { attempts: 3, label: `fund agent ${agentPublicKey.toBase58().slice(0, 8)}` }
  );

  return sig;
}

// Transfer SOL from master wallet to an agent for gas fees.
export async function fundAgentSol(masterKeypair, agentPublicKey, solAmount) {
  const conn = getConnection();
  const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: masterKeypair.publicKey,
      toPubkey: agentPublicKey,
      lamports
    })
  );

  const sig = await retry(
    () => sendAndConfirmTransaction(conn, tx, [masterKeypair]),
    { attempts: 3, label: `fund SOL to ${agentPublicKey.toBase58().slice(0, 8)}` }
  );

  return sig;
}

// Fund all agent wallets with starting capital ($5 USDC + ~$0.30 SOL).
export async function fundAllAgents({
  count = 100,
  usdcPerAgent = 5,
  solPerAgent = 0.3
} = {}) {
  const master = await loadKeypair('config/master-wallet.json');
  if (!master) {
    log.error('Master wallet not found. Run "generate" first.');
    return;
  }

  const masterBalance = await getBalance(master.publicKey);
  const totalUsdc = usdcPerAgent * count;
  const totalSol = solPerAgent * count;
  log.info(`Master balance: ${masterBalance.usdc.usdc} USDC, ${masterBalance.sol.sol} SOL`);
  log.info(`Need: ${totalUsdc} USDC + ${totalSol} SOL for ${count} agents`);

  if (masterBalance.usdc.usdc < totalUsdc) {
    log.error(`Insufficient USDC: have ${masterBalance.usdc.usdc}, need ${totalUsdc}`);
    return;
  }
  if (masterBalance.sol.sol < totalSol + 0.1) {
    log.error(`Insufficient SOL: have ${masterBalance.sol.sol}, need ~${totalSol + 0.1}`);
    return;
  }

  for (let i = 1; i <= count; i++) {
    const walletPath = `${agentDir(i)}/wallet.json`;
    const agentKp = await loadKeypair(walletPath);
    if (!agentKp) {
      log.warn(`Agent ${agentId(i)} wallet not found, skipping`, { agent: agentId(i) });
      continue;
    }

    try {
      await fundAgentSol(master, agentKp.publicKey, solPerAgent);
      log.info(`Funded ${agentId(i)} with ${solPerAgent} SOL`, { agent: agentId(i) });

      await fundAgent(master, agentKp.publicKey, usdcPerAgent);
      log.info(`Funded ${agentId(i)} with ${usdcPerAgent} USDC`, { agent: agentId(i) });
    } catch (err) {
      log.error(`Failed to fund agent ${agentId(i)}: ${err.message}`, { agent: agentId(i) });
    }
  }

  log.info('Funding complete');
}

// --- Sweeping ---

// Sweep all USDC and remaining SOL from an agent wallet back to master.
export async function sweepAgent(agentKeypair, masterPublicKey) {
  const conn = getConnection();
  const agentPub = agentKeypair.publicKey;

  // Sweep USDC
  const usdcBalance = await getUsdcBalance(agentPub);
  if (usdcBalance.raw > 0) {
    const agentAta = await getAssociatedTokenAddress(USDC_MINT, agentPub);
    const masterAta = await getAssociatedTokenAddress(USDC_MINT, masterPublicKey);

    const tx = new Transaction().add(
      createTransferInstruction(agentAta, masterAta, agentPub, usdcBalance.raw)
    );

    await retry(
      () => sendAndConfirmTransaction(conn, tx, [agentKeypair]),
      { attempts: 3, label: `sweep USDC from ${agentPub.toBase58().slice(0, 8)}` }
    );
    log.info(`Swept ${usdcBalance.usdc} USDC`, { agent: agentPub.toBase58().slice(0, 8) });
  }

  // Sweep SOL (leave enough for the transaction fee)
  const solBalance = await getSolBalance(agentPub);
  const reserveForFee = 5000; // lamports
  const sweepable = solBalance.lamports - reserveForFee;
  if (sweepable > 0) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentPub,
        toPubkey: masterPublicKey,
        lamports: sweepable
      })
    );

    await retry(
      () => sendAndConfirmTransaction(conn, tx, [agentKeypair]),
      { attempts: 3, label: `sweep SOL from ${agentPub.toBase58().slice(0, 8)}` }
    );
    log.info(`Swept ${sweepable / LAMPORTS_PER_SOL} SOL`, { agent: agentPub.toBase58().slice(0, 8) });
  }
}

// Sweep all agent wallets back to master.
export async function sweepAllAgents({ count = 100 } = {}) {
  const master = await loadKeypair('config/master-wallet.json');
  if (!master) {
    log.error('Master wallet not found.');
    return;
  }

  for (let i = 1; i <= count; i++) {
    const walletPath = `${agentDir(i)}/wallet.json`;
    const agentKp = await loadKeypair(walletPath);
    if (!agentKp) continue;

    try {
      await sweepAgent(agentKp, master.publicKey);
    } catch (err) {
      log.error(`Failed to sweep agent ${agentId(i)}: ${err.message}`, { agent: agentId(i) });
    }
  }

  log.info('Sweep complete');
}

// --- CLI ---

const command = process.argv[2];
if (command) {
  const commands = {
    async generate() {
      await generateAllWallets();
    },
    async balance() {
      const target = process.argv[3];
      if (!target) {
        log.error('Usage: node src/wallets.js balance <master|NNN>');
        return;
      }
      const walletPath = target === 'master'
        ? 'config/master-wallet.json'
        : `${agentDir(parseInt(target))}/wallet.json`;
      const kp = await loadKeypair(walletPath);
      if (!kp) { log.error(`Wallet not found: ${walletPath}`); return; }
      const bal = await getBalance(kp.publicKey);
      console.log(`${target}: ${bal.sol.sol} SOL, ${bal.usdc.usdc} USDC`);
    },
    async fund() {
      await fundAllAgents();
    },
    async sweep() {
      await sweepAllAgents();
    }
  };

  if (commands[command]) {
    commands[command]().catch(err => {
      log.error(`Command failed: ${err.message}`);
      process.exit(1);
    });
  } else {
    console.log('Usage: node src/wallets.js <generate|balance|fund|sweep>');
  }
}
