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
// Re-export types needed by the UI component
export type { GameState };
export { Phase };

type ClientOptions = contract.ClientOptions;

// Higher fee + longer timeout for on-chain UltraHonk ZK verification.
const ZK_METHOD_OPTIONS = {
  ...DEFAULT_METHOD_OPTIONS,
  fee: 10_000_000,        // 1 XLM cap
  timeoutInSeconds: 120,  // 2 min
};

export class PoisonGameService {
  static finalizeStartGame(signedXdr: void, myAddress: string, signer: ContractSigner) {
      throw new Error('Method not implemented.');
  }
  static importAndSignAuthEntry(xdrInput: string, myAddress: string, FIXED_WAGER: bigint, signer: ContractSigner) {
      throw new Error('Method not implemented.');
  }
  static prepareStartGame(sessionId: number, myAddress: string, opponentAddress: string, FIXED_WAGER: bigint, FIXED_WAGER1: bigint, signer: ContractSigner) {
      throw new Error('Method not implemented.');
  }
  private baseClient: PoisonGameClient;
  private contractId: string;

  constructor(contractId: string) {
    console.log('[PoisonGameService] constructor called with contractId:', contractId);
    this.contractId = contractId;
    this.baseClient = new PoisonGameClient({
      contractId:        this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl:            RPC_URL,
    });
    console.log('[PoisonGameService] baseClient initialized');
  }

  /** Create a client with signing capabilities */
  private createSigningClient(
    publicKey: string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ): PoisonGameClient {
    console.log('[createSigningClient] publicKey:', publicKey);
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
    console.log('[getGame] sessionId:', sessionId);
    try {
      const tx = await this.baseClient.get_game({ session_id: sessionId });
      console.log('[getGame] transaction built');
      const result = await tx.simulate();
      if (result.result.isOk()) {
        const game = result.result.unwrap();
        console.log('[getGame] game found:', game);
        return game;
      } else {
        console.log('[getGame] game not found for session:', sessionId);
        return null;
      }
    } catch (err) {
      console.log('[getGame] error:', err);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Multi-party start_game handshake
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
    console.log('[prepareStartGame] started', { sessionId, player1, player2, player1Points: player1Points.toString(), player2Points: player2Points.toString() });
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
    console.log('[prepareStartGame] transaction built and simulated');

    if (!tx.simulationData?.result?.auth) {
      throw new Error('[prepareStartGame] No auth entries found in simulation');
    }

    const authEntries = tx.simulationData.result.auth;
    console.log('[prepareStartGame] found', authEntries.length, 'auth entries');

    let player1AuthEntry: xdr.SorobanAuthorizationEntry | null = null;
    for (let i = 0; i < authEntries.length; i++) {
      try {
        const addr = Address.fromScAddress(authEntries[i].credentials().address().address()).toString();
        console.log(`[prepareStartGame] auth entry ${i} address:`, addr);
        if (addr === player1) {
          player1AuthEntry = authEntries[i];
          console.log(`[prepareStartGame] found Player 1 auth entry at index ${i}`);
          break;
        }
      } catch (err) {
        console.log(`[prepareStartGame] auth entry ${i} is not address-based`);
      }
    }

    if (!player1AuthEntry) {
      throw new Error(`[prepareStartGame] No auth entry found for Player 1 (${player1})`);
    }

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? MULTI_SIG_AUTH_TTL_MINUTES,
    );
    console.log('[prepareStartGame] validUntilLedgerSeq:', validUntilLedgerSeq);

    if (!player1Signer.signAuthEntry) {
      throw new Error('[prepareStartGame] signAuthEntry not available');
    }

    const signedAuthEntry = await authorizeEntry(
      player1AuthEntry,
      async (preimage) => {
        console.log('[prepareStartGame] signing preimage');
        const signResult = await player1Signer.signAuthEntry!(
          preimage.toXDR('base64'),
          { networkPassphrase: NETWORK_PASSPHRASE, address: player1 },
        );
        if (signResult.error) {
          throw new Error(`Failed to sign auth entry: ${signResult.error.message}`);
        }
        console.log('[prepareStartGame] preimage signed');
        return Buffer.from(signResult.signedAuthEntry, 'base64');
      },
      validUntilLedgerSeq,
      NETWORK_PASSPHRASE,
    );

    const signedXdr = signedAuthEntry.toXDR('base64');
    console.log('[prepareStartGame] signed Player 1 auth entry, length:', signedXdr.length);
    return signedXdr;
  }

  parseAuthEntry(authEntryXdr: string): {
    sessionId:     number;
    player1:       string;
    player1Points: bigint;
    functionName:  string;
  } {
    console.log('[parseAuthEntry] parsing XDR');
    try {
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');
      const credentials = authEntry.credentials();
      console.log('[parseAuthEntry] credentials type:', credentials.switch().name);
      const player1 = Address.fromScAddress(credentials.address().address()).toString();
      console.log('[parseAuthEntry] player1 address:', player1);

      const contractFn = authEntry.rootInvocation().function().contractFn();
      const functionName = contractFn.functionName().toString();
      console.log('[parseAuthEntry] functionName:', functionName);
      if (functionName !== 'start_game') {
        throw new Error(`Unexpected function: ${functionName}`);
      }

      const args = contractFn.args();
      console.log('[parseAuthEntry] args count:', args.length);
      if (args.length !== 2) {
        throw new Error(`Expected 2 args, got ${args.length}`);
      }

      const sessionId = args[0].u32();
      const player1Points = args[1].i128().lo().toBigInt();
      console.log('[parseAuthEntry] extracted:', { sessionId, player1, player1Points: player1Points.toString() });
      return { sessionId, player1, player1Points, functionName };
    } catch (err: any) {
      console.error('[parseAuthEntry] error:', err);
      throw new Error(`Failed to parse auth entry: ${err.message}`);
    }
  }

  async importAndSignAuthEntry(
    player1SignedAuthEntryXdr: string,
    player2Address:             string,
    player2Points:              bigint,
    player2Signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ): Promise<string> {
    console.log('[importAndSignAuthEntry] started', { player2Address, player2Points: player2Points.toString() });
    const gameParams = this.parseAuthEntry(player1SignedAuthEntryXdr);
    console.log('[importAndSignAuthEntry] parsed gameParams:', gameParams);

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
    console.log('[importAndSignAuthEntry] transaction rebuilt and simulated');

    if (tx.simulationData?.result?.auth) {
      console.log('[importAndSignAuthEntry] auth entries:');
      tx.simulationData.result.auth.forEach((entry, i) => {
        try {
          const credType = entry.credentials().switch().name;
          if (credType === 'sorobanCredentialsAddress') {
            const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
            console.log(`  [${i}] ${addr} (address-based)`);
          } else {
            console.log(`  [${i}] ${credType}`);
          }
        } catch { console.log(`  [${i}] (unreadable)`); }
      });
    } else {
      console.log('[importAndSignAuthEntry] no auth entries in simulation');
    }

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? MULTI_SIG_AUTH_TTL_MINUTES,
    );
    console.log('[importAndSignAuthEntry] validUntilLedgerSeq:', validUntilLedgerSeq);

    const txWithInjectedAuth = await injectSignedAuthEntry(
      tx,
      player1SignedAuthEntryXdr,
      player2Address,
      player2Signer,
      validUntilLedgerSeq,
    );
    console.log('[importAndSignAuthEntry] injected Player 1 auth entry');

    const player2Client = this.createSigningClient(player2Address, player2Signer);
    const player2Tx = player2Client.txFromXDR(txWithInjectedAuth.toXDR());

    const needsSigning = await player2Tx.needsNonInvokerSigningBy();
    console.log('[importAndSignAuthEntry] accounts needing signing:', needsSigning);

    if (needsSigning.includes(player2Address)) {
      console.log('[importAndSignAuthEntry] signing Player 2 auth entry');
      await player2Tx.signAuthEntries({ expiration: validUntilLedgerSeq });
    }

    const finalXdr = player2Tx.toXDR();
    console.log('[importAndSignAuthEntry] returning final XDR, length:', finalXdr.length);
    return finalXdr;
  }

  async finalizeStartGame(
    txXdr:          string,
    signerAddress:  string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    console.log('[finalizeStartGame] started', { signerAddress });
    const client = this.createSigningClient(signerAddress, signer);
    const tx = client.txFromXDR(txXdr);
    console.log('[finalizeStartGame] rebuilt transaction from XDR');

    await tx.simulate();
    console.log('[finalizeStartGame] re-simulated');

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
    );
    console.log('[finalizeStartGame] validUntilLedgerSeq:', validUntilLedgerSeq);

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq,
    );
    console.log('[finalizeStartGame] transaction sent, result:', sentTx);
    return sentTx.result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Game actions
  // ══════════════════════════════════════════════════════════════════════════

  async commitBoard(
  sessionId: number,
  player: string,
  boardHash: Buffer,
  signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  authTtlMinutes?: number,
): Promise<string> {
  console.log('[commitBoard] started', { sessionId, player, boardHashLength: boardHash.length });
  if (boardHash.length !== 32) {
    throw new Error(`[commitBoard] boardHash must be 32 bytes, got ${boardHash.length}`);
  }

  const client = this.createSigningClient(player, signer);
  console.log('[commitBoard] signing client created');

  const tx = await client.commit_board({
    session_id: sessionId,
    player,
    board_hash: boardHash,
  }, DEFAULT_METHOD_OPTIONS);
  console.log('[commitBoard] commit_board built and simulated');

  const validUntilLedgerSeq = await calculateValidUntilLedger(
    RPC_URL,
    authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
  );
  console.log('[commitBoard] validUntilLedgerSeq:', validUntilLedgerSeq);

  try {
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq,
    );
    console.log('[commitBoard] signAndSendViaLaunchtube returned', sentTx);

    // Get transaction hash from the initial submission response
    const txHash = sentTx.sendTransactionResponse?.hash;
    if (!txHash) {
      throw new Error('No transaction hash from submission');
    }
    console.log('[commitBoard] submitted with hash:', txHash);

    // Create a new Server instance to poll for status
    const server = new Server(RPC_URL);
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const txResponse = await server.getTransaction(txHash);
      if (txResponse.status === 'SUCCESS') {
        console.log('[commitBoard] transaction confirmed, hash:', txHash);
        return txHash;
      }
      if (txResponse.status === 'FAILED') {
        const errorMsg = this.extractErrorFromDiagnostics(txResponse);
        throw new Error(`Commit failed: ${errorMsg}`);
      }
      // else still pending, continue polling
    }
    throw new Error('Transaction not confirmed after polling');
  } catch (err) {
    console.error('[commitBoard] caught error:', err);
    throw err;
  }
}

  async attack(
    sessionId:      number,
    attacker:       string,
    tileIndex:      number,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    console.log('[attack] started', { sessionId, attacker, tileIndex });
    if (tileIndex < 0 || tileIndex > 14) {
      throw new Error(`[attack] tileIndex must be 0–14, got ${tileIndex}`);
    }

    const client = this.createSigningClient(attacker, signer);
    const tx = await client.attack({
      session_id: sessionId,
      attacker,
      tile_index: tileIndex,
    }, DEFAULT_METHOD_OPTIONS);
    console.log('[attack] attack built and simulated');

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
    );
    console.log('[attack] validUntilLedgerSeq:', validUntilLedgerSeq);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq,
      );
      console.log('[attack] signAndSendViaLaunchtube returned', sentTx);

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMsg = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        console.error('[attack] transaction failed with diagnostics:', errorMsg);
        throw new Error(`Transaction failed: ${errorMsg}`);
      }

      console.log('[attack] transaction succeeded, hash:', sentTx.getTransactionResponse?.hash);
      return sentTx.result;
    } catch (err) {
      console.error('[attack] caught error:', err);
      throw err;
    }
  }

  async respondToAttack(
    sessionId:     number,
    defender:      string,
    tileType:      0 | 1 | 2,
    proofBlob:     Uint8Array,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    console.log('[respondToAttack] started', { sessionId, defender, tileType, proofLength: proofBlob.length });
    if (proofBlob.length !== 14592) {
      console.warn(`[respondToAttack] Expected 14592-byte proof, got ${proofBlob.length}`);
    }

    const client = this.createSigningClient(defender, signer);
    const tx = await client.respond_to_attack({
      session_id: sessionId,
      defender,
      tile_type: tileType,
      proof_blob: Buffer.from(proofBlob),
    }, ZK_METHOD_OPTIONS);
    console.log('[respondToAttack] respond_to_attack built and simulated');

    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES,
    );
    console.log('[respondToAttack] validUntilLedgerSeq:', validUntilLedgerSeq);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        ZK_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq,
      );
      console.log('[respondToAttack] signAndSendViaLaunchtube returned', sentTx);

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMsg = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        console.error('[respondToAttack] transaction failed with diagnostics:', errorMsg);
        throw new Error(`Transaction failed: ${errorMsg}`);
      }

      console.log('[respondToAttack] transaction succeeded, hash:', sentTx.getTransactionResponse?.hash);
      return sentTx.result;
    } catch (err) {
      console.error('[respondToAttack] caught error:', err);
      throw err;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Admin (fully implemented, no ellipsis)
  // ══════════════════════════════════════════════════════════════════════════

  async initVk(
    caller: string,
    vkBytes: Buffer,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    console.log('[initVk] started', { caller, vkBytesLength: vkBytes.length });
    const client = this.createSigningClient(caller, signer);
    const tx = await client.init_vk({ caller, vk_bytes: vkBytes }, DEFAULT_METHOD_OPTIONS);
    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES
    );
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq
    );
    console.log('[initVk] result:', sentTx);
    return sentTx.result;
  }

  async hasVk(): Promise<boolean> {
    console.log('[hasVk] called');
    try {
      const tx = await this.baseClient.has_vk();
      const result = await tx.simulate();
      const has = result.result as unknown as boolean;
      console.log('[hasVk] result:', has);
      return has;
    } catch (err) {
      console.log('[hasVk] error, returning false');
      return false;
    }
  }

  async setHub(
    callerAddress: string,
    newHub: string,
    signer: Pick<ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number,
  ) {
    console.log('[setHub] started', { callerAddress, newHub });
    const client = this.createSigningClient(callerAddress, signer);
    const tx = await client.set_hub({ new_hub: newHub }, DEFAULT_METHOD_OPTIONS);
    const validUntilLedgerSeq = await calculateValidUntilLedger(
      RPC_URL,
      authTtlMinutes ?? DEFAULT_AUTH_TTL_MINUTES
    );
    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq
    );
    console.log('[setHub] result:', sentTx);
    return sentTx.result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Error handling
  // ══════════════════════════════════════════════════════════════════════════

  private extractErrorFromDiagnostics(transactionResponse: any): string {
    try {
      console.error('[extractErrorFromDiagnostics] transactionResponse:', JSON.stringify(transactionResponse, null, 2));

      const diagnosticEvents =
        transactionResponse?.diagnosticEventsXdr ||
        transactionResponse?.diagnostic_events || [];

      for (const event of diagnosticEvents) {
        if (event?.topics) {
          const topics = Array.isArray(event.topics) ? event.topics : [];
          const hasError = topics.some((t: any) => t?.symbol === 'error' || t?.error);
          if (hasError && event.data) {
            if (typeof event.data === 'string') return event.data;
            if (event.data.vec && Array.isArray(event.data.vec)) {
              const msgs = event.data.vec
                .filter((item: any) => item?.string)
                .map((item: any) => item.string);
              if (msgs.length > 0) return msgs.join(': ');
            }
          }
        }
      }

      if (transactionResponse?.result_xdr) {
        console.error('[extractErrorFromDiagnostics] result XDR:', transactionResponse.result_xdr);
      }

      return `Transaction ${transactionResponse?.status ?? 'Unknown'}. Check console for details.`;
    } catch (err) {
      console.error('[extractErrorFromDiagnostics] failed to extract error:', err);
      return 'Transaction failed with unknown error';
    }
  }
}
export const poisonGameService = new PoisonGameService(POISON_GAME_CONTRACT);