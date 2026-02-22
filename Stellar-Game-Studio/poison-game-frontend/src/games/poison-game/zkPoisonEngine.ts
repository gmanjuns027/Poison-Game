/**
 * zkPoisonEngine.ts – production‑ready ZK engine for Poison Game
 * Based on working battleship example.
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, Barretenberg, Fr, type ProofData } from '@aztec/bb.js';
import type { CompiledCircuit } from '@noir-lang/noir_js';
import { Buffer } from 'buffer';

export type TileType = 0 | 1 | 2;

export interface ZkProofEngineStatus {
  initialized: boolean;
  circuitLoaded: boolean;
  backendReady: boolean;
  error: string | null;
}

class ZkProofEngine {
  private noir: Noir | null = null;
  private backend: UltraHonkBackend | null = null;
  private bb: Barretenberg | null = null;
  private circuit: CompiledCircuit | null = null;
  private _initialized = false;
  private _initializing: Promise<void> | null = null;
  private _error: string | null = null;

  get initialized(): boolean {
    return this._initialized;
  }

  get status(): ZkProofEngineStatus {
    return {
      initialized: this._initialized,
      circuitLoaded: this.circuit !== null,
      backendReady: this.backend !== null,
      error: this._error,
    };
  }

  /**
   * Initialise the ZK engine (load circuit, Noir, backend, Barretenberg).
   * Safe to call multiple times – only runs once.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    if (this._initializing) return this._initializing;

    this._initializing = this._doInit();
    return this._initializing;
  }

  private async _doInit(): Promise<void> {
    try {
      console.log('[ZkProofEngine] Initialising...');

      // 1. Load circuit JSON from public folder
      console.log('[ZkProofEngine] Loading circuit...');
      const resp = await fetch('/circuit/poison_game.json');
      if (!resp.ok) {
        throw new Error(`Failed to load circuit: ${resp.status} ${resp.statusText}`);
      }
      this.circuit = (await resp.json()) as CompiledCircuit;
      console.log('[ZkProofEngine] Circuit loaded, bytecode length:', this.circuit.bytecode.length);

      // 2. Create Noir instance for witness generation
      this.noir = new Noir(this.circuit);
      await this.noir.init();
      console.log('[ZkProofEngine] Noir instance ready');

      // 3. Create UltraHonk backend for proof generation (single thread)
      this.backend = new UltraHonkBackend(this.circuit.bytecode, { threads: 1 });
      console.log('[ZkProofEngine] UltraHonk backend ready');

      // 4. Create Barretenberg instance for pedersen hash (single thread)
      this.bb = await Barretenberg.new({ threads: 1 });
      console.log('[ZkProofEngine] Barretenberg instance ready');

      this._initialized = true;
      this._error = null;
      console.log('[ZkProofEngine] ✅ Fully initialised');
    } catch (err: any) {
      this._error = err.message || String(err);
      console.error('[ZkProofEngine] ❌ Init failed:', err);
      throw err;
    }
  }

  /**
   * Compute pedersen_hash([tiles..., salt]) – must match Noir's std::hash::pedersen_hash.
   * @returns 32‑byte Buffer for commit_board()
   */
  async computeBoardHash(tiles: TileType[], salt: bigint): Promise<Buffer> {
    await this.init();
    if (!this.bb) throw new Error('Barretenberg not initialised');

    if (tiles.length !== 15) {
      throw new Error(`Expected 15 tiles, got ${tiles.length}`);
    }

    // Build Fr array: [tile0, tile1, ..., tile14, salt]
    const inputs: Fr[] = tiles.map(t => new Fr(BigInt(t)));
    inputs.push(new Fr(salt));

    const hashFr = await this.bb.pedersenHash(inputs, 0);
    const hashBytes = hashFr.toBuffer();
    console.log('[ZkProofEngine] Board hash computed:', Buffer.from(hashBytes).toString('hex'));
    return Buffer.from(hashBytes);
  }

  /**
   * Generate UltraHonk proof that tiles[tileIndex] === tileType.
   * @returns 14592‑byte Uint8Array for respond_to_attack()
   */
  async generateTileProof(
    tiles: TileType[],
    salt: bigint,
    commitment: Buffer,
    tileIndex: number,
    tileType: TileType,
  ): Promise<Uint8Array> {
    await this.init();
    if (!this.noir || !this.backend) throw new Error('Engine not initialised');

    if (tiles.length !== 15) throw new Error('Need 15 tiles');
    if (tileIndex < 0 || tileIndex > 14) throw new Error('Invalid tile index');
    if (tiles[tileIndex] !== tileType) throw new Error('Tile type mismatch');

    console.log('[ZkProofEngine] Generating proof for tile', tileIndex, 'type', tileType);

    // Prepare circuit inputs (must match main.nr exactly)
    const inputs = {
      board_layout: tiles.map(t => `0x${BigInt(t).toString(16).padStart(64, '0')}`),
      salt: `0x${salt.toString(16).padStart(64, '0')}`,
      commitment: '0x' + commitment.toString('hex'),
      tile_index: tileIndex,
      tile_type_result: tileType, // Changed from tile_type to tile_type_result
    };

    console.log('[ZkProofEngine] Input map:', JSON.stringify(inputs, null, 2));

    // 1. Generate witness
    const startWitness = performance.now();
    const { witness } = await this.noir.execute(inputs);
    const witnessTime = performance.now() - startWitness;
    console.log('[ZkProofEngine] Witness generated in %dms, size: %d bytes', witnessTime.toFixed(0), witness.length);

    // 2. Generate proof (UltraHonk, keccak oracle)
    const startProof = performance.now();
    const proofData = await this.backend.generateProof(witness, { keccak: true });
    const proofTime = performance.now() - startProof;
    console.log(
      '[ZkProofEngine] Proof generated in %dms, proof size: %d bytes, public inputs: %d',
      proofTime.toFixed(0),
      proofData.proof.length,
      proofData.publicInputs.length,
    );

    if (proofData.proof.length !== 14592) {
      console.warn(`Unexpected proof size: ${proofData.proof.length} (expected 14592)`);
    }

    return proofData.proof;
  }

  /**
   * Clean up resources (optional).
   */
  async destroy(): Promise<void> {
    try {
      await this.backend?.destroy();
      await this.bb?.destroy();
    } catch { /* ignore */ }
    this.backend = null;
    this.bb = null;
    this.noir = null;
    this.circuit = null;
    this._initialized = false;
  }
}

// Singleton instance
export const zkProofEngine = new ZkProofEngine();

// Re‑export helper functions for compatibility with existing code
export const computeBoardHash = (tiles: TileType[], salt: bigint) => zkProofEngine.computeBoardHash(tiles, salt);
export const generateTileProof = (tiles: TileType[], salt: bigint, commitment: Buffer, tileIndex: number, tileType: TileType) =>
  zkProofEngine.generateTileProof(tiles, salt, commitment, tileIndex, tileType);
export const generateSalt = (): bigint => {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
};
export const validateBoard = (tiles: TileType[]): { valid: boolean; error?: string } => {
  if (tiles.length !== 15) return { valid: false, error: `Need 15 tiles, got ${tiles.length}` };
  if (tiles.some(t => t !== 0 && t !== 1 && t !== 2))
    return { valid: false, error: 'Invalid tile values' };
  const poisons = tiles.filter(t => t === 1).length;
  const shields = tiles.filter(t => t === 2).length;
  if (poisons !== 2) return { valid: false, error: `Need 2 poison, got ${poisons}` };
  if (shields !== 1) return { valid: false, error: `Need 1 shield, got ${shields}` };
  return { valid: true };
};