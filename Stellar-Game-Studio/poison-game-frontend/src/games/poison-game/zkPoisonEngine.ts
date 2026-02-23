/**
 * zkPoisonEngine.ts — ZK engine for Poison Game
 * Circuit: poison_game (15 tiles, 2 poison + 1 shield)
 * Backend: UltraHonk, keccak oracle, bb v0.87.0
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, Barretenberg, Fr } from '@aztec/bb.js';
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

  get initialized(): boolean { return this._initialized; }

  get status(): ZkProofEngineStatus {
    return {
      initialized: this._initialized,
      circuitLoaded: this.circuit !== null,
      backendReady: this.backend !== null,
      error: this._error,
    };
  }

  // Safe to call multiple times — only initialises once
  async init(): Promise<void> {
    if (this._initialized) return;
    if (this._initializing) return this._initializing;
    this._initializing = this._doInit();
    return this._initializing;
  }

  private async _doInit(): Promise<void> {
    try {
      console.log('[ZkPoison] Initialising engine...');

      const resp = await fetch('/circuit/poison_game.json');
      if (!resp.ok) throw new Error(`Circuit load failed: ${resp.status} ${resp.statusText}`);
      this.circuit = (await resp.json()) as CompiledCircuit;

      this.noir = new Noir(this.circuit);
      await this.noir.init();

      this.backend = new UltraHonkBackend(this.circuit.bytecode, { threads: 1 });

      this.bb = await Barretenberg.new({ threads: 1 });

      this._initialized = true;
      this._error = null;
      console.log('[ZkPoison] ✅ Ready');
    } catch (err: any) {
      this._error = err.message || String(err);
      console.error('[ZkPoison] ❌ Init failed:', err);
      throw err;
    }
  }

  /**
   * Compute pedersen_hash([tile0..tile14, salt]).
   * Must match exactly what Noir's std::hash::pedersen_hash produces.
   * Returns 32-byte Buffer — pass directly to commit_board().
   */
  async computeBoardHash(tiles: TileType[], salt: bigint): Promise<Buffer> {
    await this.init();
    if (!this.bb) throw new Error('Barretenberg not initialised');
    if (tiles.length !== 15) throw new Error(`Need 15 tiles, got ${tiles.length}`);

    const inputs: Fr[] = tiles.map(t => new Fr(BigInt(t)));
    inputs.push(new Fr(salt));

    const hashFr = await this.bb.pedersenHash(inputs, 0);
    return Buffer.from(hashFr.toBuffer());
  }

  /**
   * Generate UltraHonk ZK proof that tiles[tileIndex] === tileType,
   * given the committed board hash.
   *
   * Private inputs (never leave the browser):
   *   board_layout — full 15-tile layout
   *   salt         — random value used in commitment
   *
   * Public inputs (verified on-chain):
   *   commitment       — pedersen hash stored at commit_board time
   *   tile_index       — which tile was attacked
   *   tile_type_result — what type that tile is (0=Normal, 1=Poison, 2=Shield)
   *
   * Returns 14592-byte Uint8Array — pass directly to respond_to_attack().
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
    if (tiles[tileIndex] !== tileType) throw new Error('Tile type mismatch — check board data');

   
    const inputs = {
      board_layout: tiles.map(t => `0x${BigInt(t).toString(16).padStart(64, '0')}`),
      salt: `0x${salt.toString(16).padStart(64, '0')}`,
      commitment: '0x' + commitment.toString('hex'),
      tile_index: tileIndex,
      tile_type_result: tileType,
    };

    const t0 = performance.now();

    const { witness } = await this.noir.execute(inputs);

    const t1 = performance.now();
    console.log(`[ZkPoison] Witness generated in ${(t1 - t0).toFixed(0)}ms`);

    // keccak: true must match what bb used when writing the VK
    const proofData = await this.backend.generateProof(witness, { keccak: true });

    const t2 = performance.now();
    console.log(`[ZkPoison] Proof generated in ${(t2 - t1).toFixed(0)}ms — ${proofData.proof.length} bytes`);

    if (proofData.proof.length !== 14592) {
      throw new Error(`Wrong proof size: ${proofData.proof.length} (expected 14592). Check bb version matches contract.`);
    }

    return proofData.proof;
  }

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
    this._initializing = null;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
export const zkProofEngine = new ZkProofEngine();

// ── Exported helpers ─────────────────────────
export const computeBoardHash = (tiles: TileType[], salt: bigint) =>
  zkProofEngine.computeBoardHash(tiles, salt);

export const generateTileProof = (
  tiles: TileType[],
  salt: bigint,
  commitment: Buffer,
  tileIndex: number,
  tileType: TileType,
) => zkProofEngine.generateTileProof(tiles, salt, commitment, tileIndex, tileType);

export const generateSalt = (): bigint => {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
};

export const validateBoard = (tiles: TileType[]): { valid: boolean; error?: string } => {
  if (tiles.length !== 15) return { valid: false, error: `Need 15 tiles, got ${tiles.length}` };
  if (tiles.some(t => t !== 0 && t !== 1 && t !== 2)) return { valid: false, error: 'Invalid tile values' };
  const poisons = tiles.filter(t => t === 1).length;
  const shields = tiles.filter(t => t === 2).length;
  if (poisons !== 2) return { valid: false, error: `Need exactly 2 poison tiles, got ${poisons}` };
  if (shields !== 1) return { valid: false, error: `Need exactly 1 shield tile, got ${shields}` };
  return { valid: true };
};