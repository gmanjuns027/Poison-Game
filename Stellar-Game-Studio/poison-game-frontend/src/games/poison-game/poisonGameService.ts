import { Client as PoisonGameClient, type GameState, Phase } from './bindings';
import {
  NETWORK_PASSPHRASE,
  RPC_URL,
  DEFAULT_METHOD_OPTIONS,
  DEFAULT_AUTH_TTL_MINUTES,
  MULTI_SIG_AUTH_TTL_MINUTES,
  POISON_GAME_CONTRACT,
} from '@/utils/constants';
import { contract, xdr, Address, authorizeEntry } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { signAndSendViaLaunchtube } from '@/utils/transactionHelper';
import { calculateValidUntilLedger } from '@/utils/ledgerUtils';
import { injectSignedAuthEntry } from '@/utils/authEntryUtils';
import { Server } from '@stellar/stellar-sdk/rpc';
import { ContractSigner } from '@/types/signer';

export type { GameState };
export { Phase };

type ClientOptions = contract.ClientOptions;

// Higher fee + longer timeout for on-chain UltraHonk ZK verification
// Fee is passed as a string to satisfy MethodOptions type
const ZK_METHOD_OPTIONS = {
  ...DEFAULT_METHOD_OPTIONS,
  fee: '10000000',       // 1 XLM cap as string
  timeoutInSeconds: 120, // 2 min
};

export class PoisonGameService {
  private baseClient: PoisonGameClient;
  private contractId: string;

  constructor(contractId: string) {
    console.log('[PoisonGameService] init:', contractId);
    this.contractId = contractId;
    this.baseClient = new PoisonGameClient({
      contractId:        this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl:            RPC_URL,
    });
  }

  private createSigningClient(
    publicKey: string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ): PoisonGameClient {
    return new PoisonGameClient({
      contractId:        this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl:            RPC_URL,
      publicKey,
      ...signer,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Read-only
  // ══════════════════════════════════════════════════════════════════════════

  async getGame(sessionId: number): Promise<GameState | null> {
    try {
      const tx = await this.baseClient.get_game({ session_id: sessionId });
      const result = await tx.simulate();
      if (result.result.isOk()) return result.result.unwrap();
      return null;
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Multi-party start_game handshake
  // Player 1 → prepareStartGame  → signed auth entry XDR  → share to Player 2
  // Player 2 → importAndSignAuthEntry → fully signed TX XDR
  // Player 2 → finalizeStartGame → submits on-chain, GameHub locks both wagers
  // ══════════════════════════════════════════════════════════════════════════

  async prepareStartGame(
    sessionId:      number,
    player1:        string,
    player2:        string,
    player1Points:  bigint,
    player2Points:  bigint,
    player1Signer:  Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ): Promise<string> {
    // Build from player2's perspective so simulation succeeds
    const buildClient = new PoisonGameClient({
      contractId:        this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl:            RPC_URL,
      publicKey:         player2,
    });

    const tx = await buildClient.start_game({
      session_id:     sessionId,
      player1,
      player2,
      player1_points: player1Points,
      player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    if (!tx.simulationData?.result?.auth) {
      throw new Error('No auth entries found in simulation');
    }

    const authEntries = tx.simulationData.result.auth;

    let player1AuthEntry: xdr.SorobanAuthorizationEntry | null = null;
    for (let i = 0; i < authEntries.length; i++) {
      try {
        const addr = Address.fromScAddress(
          authEntries[i].credentials().address().address()
        ).toString();
        if (addr === player1) {
          player1AuthEntry = authEntries[i];
          break;
        }
      } catch { /* not address-based, skip */ }
    }

    if (!player1AuthEntry) {
      throw new Error(`No auth entry found for Player 1 (${player1})`);
    }

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? MULTI_SIG_AUTH_TTL_MINUTES,
    );

    if (!player1Signer.signAuthEntry) {
      throw new Error('signAuthEntry not available on Player 1 signer');
    }

    const signedAuthEntry = await authorizeEntry(
      player1AuthEntry,
      async (preimage) => {
        const signResult = await player1Signer.signAuthEntry!(
          preimage.toXDR('base64'),
          { networkPassphrase: NETWORK_PASSPHRASE, address: player1 },
        );
        if (signResult.error) {
          throw new Error(`Failed to sign auth entry: ${signResult.error.message}`);
        }
        return Buffer.from(signResult.signedAuthEntry, 'base64');
      },
      validUntilLedgerSeq,
      NETWORK_PASSPHRASE,
    );

    return signedAuthEntry.toXDR('base64');
  }

  // Parse Player 1's signed auth entry to extract session params
  parseAuthEntry(authEntryXdr: string): {
    sessionId:     number;
    player1:       string;
    player1Points: bigint;
    functionName:  string;
  } {
    try {
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');
      const player1 = Address.fromScAddress(
        authEntry.credentials().address().address()
      ).toString();

      const contractFn = authEntry.rootInvocation().function().contractFn();
      const functionName = contractFn.functionName().toString();
      if (functionName !== 'start_game') {
        throw new Error(`Unexpected function in auth entry: ${functionName}`);
      }

      const args = contractFn.args();
      if (args.length !== 2) {
        throw new Error(`Expected 2 args in auth entry, got ${args.length}`);
      }

      const sessionId     = args[0].u32();
      const player1Points = args[1].i128().lo().toBigInt();

      return { sessionId, player1, player1Points, functionName };
    } catch (err: any) {
      throw new Error(`Failed to parse auth entry: ${err.message}`);
    }
  }

  async importAndSignAuthEntry(
    player1SignedAuthEntryXdr: string,
    player2Address:            string,
    player2Points:             bigint,
    player2Signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ): Promise<string> {
    const gameParams = this.parseAuthEntry(player1SignedAuthEntryXdr);

    if (player2Address === gameParams.player1) {
      throw new Error('Cannot play against yourself');
    }

    const buildClient = new PoisonGameClient({
      contractId:        this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl:            RPC_URL,
      publicKey:         player2Address,
    });

    const tx = await buildClient.start_game({
      session_id:     gameParams.sessionId,
      player1:        gameParams.player1,
      player2:        player2Address,
      player1_points: gameParams.player1Points,
      player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? MULTI_SIG_AUTH_TTL_MINUTES,
    );

    const txWithInjectedAuth = await injectSignedAuthEntry(
      tx,
      player1SignedAuthEntryXdr,
      player2Address,
      player2Signer,
      validUntilLedgerSeq,
    );

    const player2Client = this.createSigningClient(player2Address, player2Signer);
    const player2Tx = player2Client.txFromXDR(txWithInjectedAuth.toXDR());

    const needsSigning = await player2Tx.needsNonInvokerSigningBy();
    if (needsSigning.includes(player2Address)) {
      await player2Tx.signAuthEntries({ expiration: validUntilLedgerSeq });
    }

    return player2Tx.toXDR();
  }

  async finalizeStartGame(
    txXdr:         string,
    signerAddress: string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    const client = this.createSigningClient(signerAddress, signer);
    const tx = client.txFromXDR(txXdr);
    await tx.simulate();

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
    );

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq,
    );

    // ✅ FIXED: use sendTransactionResponse.hash (always present and correctly typed)
    console.log('[PoisonGameService] start_game submitted, hash:', sentTx.sendTransactionResponse?.hash);
    return sentTx.result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Game actions
  // ══════════════════════════════════════════════════════════════════════════

  async commitBoard(
    sessionId:  number,
    player:     string,
    boardHash:  Buffer,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ): Promise<string> {
    if (boardHash.length !== 32) {
      throw new Error(`boardHash must be 32 bytes, got ${boardHash.length}`);
    }

    const client = this.createSigningClient(player, signer);
    const tx = await client.commit_board({
      session_id: sessionId,
      player,
      board_hash: boardHash,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
    );

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq,
    );

    const txHash = sentTx.sendTransactionResponse?.hash;
    if (!txHash) throw new Error('No transaction hash from commitBoard');

    // Poll for on-chain confirmation
    const server = new Server(RPC_URL);
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const txResponse = await server.getTransaction(txHash);
      if (txResponse.status === 'SUCCESS') {
        console.log('[PoisonGameService] Board committed, hash:', txHash);
        return txHash;
      }
      if (txResponse.status === 'FAILED') {
        throw new Error(`commitBoard failed: ${this.extractError(txResponse)}`);
      }
    }
    throw new Error('commitBoard not confirmed after polling');
  }

  async attack(
    sessionId:  number,
    attacker:   string,
    tileIndex:  number,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    if (tileIndex < 0 || tileIndex > 14) {
      throw new Error(`tileIndex must be 0–14, got ${tileIndex}`);
    }

    const client = this.createSigningClient(attacker, signer);
    const tx = await client.attack({
      session_id: sessionId,
      attacker,
      tile_index: tileIndex,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
    );

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq,
    );

    if (sentTx.getTransactionResponse?.status === 'FAILED') {
      throw new Error(`attack failed: ${this.extractError(sentTx.getTransactionResponse)}`);
    }

    console.log('[PoisonGameService] Attack submitted, hash:', sentTx.sendTransactionResponse?.hash);
    return sentTx.result;
  }

  async respondToAttack(
    sessionId:  number,
    defender:   string,
    tileType:   0 | 1 | 2,
    proofBlob:  Uint8Array,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    if (proofBlob.length !== 14592) {
      throw new Error(`Proof must be 14592 bytes, got ${proofBlob.length}`);
    }

    const client = this.createSigningClient(defender, signer);
    const tx = await client.respond_to_attack({
      session_id: sessionId,
      defender,
      tile_type:  tileType,
      proof_blob: Buffer.from(proofBlob),
    }, ZK_METHOD_OPTIONS); // ✅ now uses string fee

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
    );

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      ZK_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq,
    );

    if (sentTx.getTransactionResponse?.status === 'FAILED') {
      throw new Error(`respondToAttack failed: ${this.extractError(sentTx.getTransactionResponse)}`);
    }

    // ✅ FIXED: use sendTransactionResponse.hash
    console.log('[PoisonGameService] ZK proof verified on-chain, hash:', sentTx.sendTransactionResponse?.hash);
    return sentTx.result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Admin
  // ══════════════════════════════════════════════════════════════════════════

  async initVk(
    caller:  string,
    vkBytes: Buffer,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    const client = this.createSigningClient(caller, signer);
    const tx = await client.init_vk({ caller, vk_bytes: vkBytes }, DEFAULT_METHOD_OPTIONS);
    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL, authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES
    );
    const sentTx = await signAndSendViaLaunchtube(
      tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds, validUntilLedgerSeq
    );
    return sentTx.result;
  }

  async hasVk(): Promise<boolean> {
    try {
      const tx = await this.baseClient.has_vk();
      const result = await tx.simulate();
      return result.result as unknown as boolean;
    } catch {
      return false;
    }
  }

  async setHub(
    callerAddress: string,
    newHub:        string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    const client = this.createSigningClient(callerAddress, signer);
    const tx = await client.set_hub({ new_hub: newHub }, DEFAULT_METHOD_OPTIONS);
    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL, authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES
    );
    const sentTx = await signAndSendViaLaunchtube(
      tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds, validUntilLedgerSeq
    );

    // ✅ FIXED: if a log existed here, it would use sendTransactionResponse.hash
    // (No log in the current snippet, but included for completeness)
    console.log('[PoisonGameService] setHub executed, hash:', sentTx.sendTransactionResponse?.hash);
    return sentTx.result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Error extraction
  // ══════════════════════════════════════════════════════════════════════════

  private extractError(txResponse: any): string {
    try {
      const events =
        txResponse?.diagnosticEventsXdr ||
        txResponse?.diagnostic_events || [];

      for (const event of events) {
        if (!event?.topics) continue;
        const topics = Array.isArray(event.topics) ? event.topics : [];
        const hasError = topics.some((t: any) => t?.symbol === 'error' || t?.error);
        if (hasError && event.data) {
          if (typeof event.data === 'string') return event.data;
          if (event.data.vec) {
            const msgs = event.data.vec
              .filter((i: any) => i?.string)
              .map((i: any) => i.string);
            if (msgs.length) return msgs.join(': ');
          }
        }
      }
      return `Transaction ${txResponse?.status ?? 'FAILED'}`;
    } catch {
      return 'Transaction failed';
    }
  }
}

export const poisonGameService = new PoisonGameService(POISON_GAME_CONTRACT);