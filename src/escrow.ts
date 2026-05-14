// AI Survivor — On-chain escrow module
// Handles deposit verification, winner payouts, and refunds.
// Follows SwarmTrade's EvmEscrowAdapter custodial wallet pattern.

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Chain map
// ---------------------------------------------------------------------------

const CHAIN_MAP: Record<number, Chain> = {
  8453: base,
  84532: baseSepolia,
};

// ---------------------------------------------------------------------------
// ArenaEscrow
// ---------------------------------------------------------------------------

export class ArenaEscrow {
  private readonly walletAddress: Address | null;
  private readonly privateKey: Hex | null;

  constructor(privateKey?: string) {
    if (privateKey) {
      this.privateKey = privateKey as Hex;
      const account = privateKeyToAccount(this.privateKey);
      this.walletAddress = account.address;
    } else {
      this.privateKey = null;
      this.walletAddress = null;
      console.warn(
        "[ArenaEscrow] Running in mock mode -- no on-chain verification",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  getWalletAddress(): Address | null {
    return this.walletAddress;
  }

  isEnabled(): boolean {
    return this.privateKey !== null;
  }

  // -------------------------------------------------------------------------
  // Chain helpers
  // -------------------------------------------------------------------------

  private getChain(chainId: string): Chain {
    const numericId = Number(chainId);
    const chain = CHAIN_MAP[numericId];
    if (!chain) {
      throw new Error(
        `Unsupported chain ID: ${chainId}. Supported: ${Object.keys(CHAIN_MAP).join(", ")}`,
      );
    }
    return chain;
  }

  private getRpcUrl(chainId: string): string | undefined {
    return process.env[`EVM_RPC_URL_${chainId}`];
  }

  private getPublicClient(chainId: string) {
    const chain = this.getChain(chainId);
    const rpcUrl = this.getRpcUrl(chainId);
    return createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }

  private getWalletClient(chainId: string) {
    if (!this.privateKey) {
      throw new Error("Cannot create wallet client in mock mode");
    }
    const chain = this.getChain(chainId);
    const account = privateKeyToAccount(this.privateKey);
    const rpcUrl = this.getRpcUrl(chainId);
    return createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });
  }

  // -------------------------------------------------------------------------
  // verifyDeposit
  // -------------------------------------------------------------------------

  async verifyDeposit(params: {
    txHash: string;
    expectedAmount: string;
    chainId: string;
  }): Promise<{ verified: boolean; error?: string }> {
    // Mock mode: skip verification
    if (!this.isEnabled()) {
      return { verified: true };
    }

    const { txHash, expectedAmount, chainId } = params;

    // Validate tx hash format (0x + 64 hex chars)
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return {
        verified: false,
        error: `Invalid tx hash format: must be 0x-prefixed 64-char hex (got ${txHash.slice(0, 10)}...)`,
      };
    }

    const publicClient = this.getPublicClient(chainId);

    // 1. Get transaction receipt
    let receipt;
    try {
      receipt = await publicClient.getTransactionReceipt({
        hash: txHash as Hex,
      });
    } catch {
      return {
        verified: false,
        error: "Deposit transaction not found on chain",
      };
    }

    // 2. Verify receipt status
    if (receipt.status !== "success") {
      return {
        verified: false,
        error: `Deposit transaction ${txHash} failed on-chain`,
      };
    }

    // 3. Get full transaction details
    let tx;
    try {
      tx = await publicClient.getTransaction({ hash: txHash as Hex });
    } catch {
      return {
        verified: false,
        error: "Failed to fetch deposit transaction details from chain",
      };
    }

    // 4. Verify recipient is the platform wallet (case-insensitive)
    if (tx.to?.toLowerCase() !== this.walletAddress!.toLowerCase()) {
      return {
        verified: false,
        error: `Deposit tx recipient (${tx.to}) does not match platform wallet (${this.walletAddress})`,
      };
    }

    // 5. Verify amount (BigInt comparison)
    const expected = BigInt(expectedAmount);
    if (tx.value < expected) {
      return {
        verified: false,
        error: `Deposit amount (${tx.value}) is less than required (${expected})`,
      };
    }

    return { verified: true };
  }

  // -------------------------------------------------------------------------
  // sendPayout
  // -------------------------------------------------------------------------

  async sendPayout(params: {
    to: string;
    amountWei: string;
    chainId: string;
  }): Promise<{ txHash: string }> {
    // Mock mode: return fake tx hash
    if (!this.isEnabled()) {
      return { txHash: `mock:payout:${crypto.randomUUID()}` };
    }

    const { to, amountWei, chainId } = params;
    const walletClient = this.getWalletClient(chainId);
    const account = privateKeyToAccount(this.privateKey!);
    const chain = this.getChain(chainId);

    try {
      const txHash = await walletClient.sendTransaction({
        account,
        chain,
        to: to as Address,
        value: BigInt(amountWei),
      });
      return { txHash };
    } catch (err) {
      console.error("[ArenaEscrow] Payout transaction failed:", err);
      throw new Error("On-chain payout transaction failed");
    }
  }

  // -------------------------------------------------------------------------
  // sendBatchPayouts
  // -------------------------------------------------------------------------

  async sendBatchPayouts(
    payouts: Array<{ to: string; amountWei: string; chainId: string }>,
  ): Promise<Array<{ to: string; txHash?: string; error?: string }>> {
    const results: Array<{ to: string; txHash?: string; error?: string }> = [];

    // Process sequentially to avoid nonce issues
    for (const payout of payouts) {
      try {
        const { txHash } = await this.sendPayout(payout);
        results.push({ to: payout.to, txHash });
      } catch (err) {
        results.push({
          to: payout.to,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}
