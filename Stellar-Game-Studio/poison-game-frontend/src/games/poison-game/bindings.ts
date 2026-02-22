import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CBPKAQQGWR5NNH2A645EN43UM7LORT3UJLRPACXQC4P25CKRMRY3NMLX",
  }
} as const

export const Errors = {
  1: {message:"GameNotFound"},
  2: {message:"NotPlayer"},
  3: {message:"WrongPhase"},
  4: {message:"AlreadyCommitted"},
  5: {message:"NotYourTurn"},
  6: {message:"TileAlreadyRevealed"},
  7: {message:"InvalidTileIndex"},
  8: {message:"InvalidProof"},
  9: {message:"GameAlreadyEnded"},
  10: {message:"SelfPlay"},
  11: {message:"VkNotSet"},
  12: {message:"VkParseError"},
  13: {message:"NotAdmin"}
}

export enum Phase {
  WaitingForCommits = 0,
  Playing = 1,
  Finished = 2,
}

export type DataKey = {tag: "Game", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void} | {tag: "Vk", values: void};


export interface GameState {
  current_turn: u32;
  has_pending_attack: boolean;
  p1_revealed: Array<RevealedTile>;
  p2_revealed: Array<RevealedTile>;
  pending_attack_tile: u32;
  phase: Phase;
  player1: string;
  player1_commitment: Buffer;
  player1_committed: boolean;
  player1_points: i128;
  player1_score: i64;
  player2: string;
  player2_commitment: Buffer;
  player2_committed: boolean;
  player2_points: i128;
  player2_score: i64;
  skip_next_turn: boolean;
  winner: u32;
}


export interface RevealedTile {
  tile_index: u32;
  tile_type: u32;
}

export interface Client {
  /**
   * Construct and simulate a attack transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current turn player picks a tile index (0-14) on the OPPONENT'S board.
   */
  attack: ({session_id, attacker, tile_index}: {session_id: u32, attacker: string, tile_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a has_vk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if VK has been stored.
   */
  has_vk: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_hub: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a init_vk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store the verification key once after deploy.
   * Call with the raw binary contents of `circuits/poison_game/target/vk`
   * (generated with `bb write_vk --oracle_hash keccak`).
   * This function can only be called by admin, and can be called multiple
   * times to upgrade the VK if the circuit changes.
   */
  init_vk: ({caller, vk_bytes}: {caller: string, vk_bytes: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_hub: ({new_hub}: {new_hub: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Poll game state.
   */
  get_game: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<GameState>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Both players sign to start a game. Calls GameHub to lock points.
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_board transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Each player commits their board hash before seeing any tiles.
   * `board_hash` = pedersen_hash([tile0..tile14, salt]) from the browser ZK engine.
   */
  commit_board: ({session_id, player, board_hash}: {session_id: u32, player: string, board_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a respond_to_attack transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Defender responds with the tile type and a UltraHonk ZK proof.
   * 
   * # Proof blob format (from browser zkPoisonEngine):
   * Exactly PROOF_BYTES (14592) raw bytes from `bb prove --oracle_hash keccak`.
   * 
   * # Public inputs (reconstructed on-chain from stored state):
   * [commitment: 32B][tile_index: 32B][tile_type: 32B] = 96 bytes
   * The contract builds these from its own storage — defender cannot tamper.
   * 
   * # Verification:
   * Uses `UltraHonkVerifier::new(&env, &vk_bytes).verify(&proof, &pub_inputs)`.
   */
  respond_to_attack: ({session_id, defender, tile_type, proof_blob}: {session_id: u32, defender: string, tile_type: u32, proof_blob: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub}: {admin: string, game_hub: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, game_hub}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADQAAAAAAAAAMR2FtZU5vdEZvdW5kAAAAAQAAAAAAAAAJTm90UGxheWVyAAAAAAAAAgAAAAAAAAAKV3JvbmdQaGFzZQAAAAAAAwAAAAAAAAAQQWxyZWFkeUNvbW1pdHRlZAAAAAQAAAAAAAAAC05vdFlvdXJUdXJuAAAAAAUAAAAAAAAAE1RpbGVBbHJlYWR5UmV2ZWFsZWQAAAAABgAAAAAAAAAQSW52YWxpZFRpbGVJbmRleAAAAAcAAAAAAAAADEludmFsaWRQcm9vZgAAAAgAAAAAAAAAEEdhbWVBbHJlYWR5RW5kZWQAAAAJAAAAAAAAAAhTZWxmUGxheQAAAAoAAAAAAAAACFZrTm90U2V0AAAACwAAAAAAAAAMVmtQYXJzZUVycm9yAAAADAAAAAAAAAAITm90QWRtaW4AAAAN",
        "AAAAAwAAAAAAAAAAAAAABVBoYXNlAAAAAAAAAwAAAAAAAAARV2FpdGluZ0ZvckNvbW1pdHMAAAAAAAAAAAAAAAAAAAdQbGF5aW5nAAAAAAEAAAAAAAAACEZpbmlzaGVkAAAAAg==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABAAAAAEAAAAAAAAABEdhbWUAAAABAAAABAAAAAAAAAAAAAAADkdhbWVIdWJBZGRyZXNzAAAAAAAAAAAAAAAAAAVBZG1pbgAAAAAAAAAAAAAAAAAAAlZrAAA=",
        "AAAAAQAAAAAAAAAAAAAACUdhbWVTdGF0ZQAAAAAAABIAAAAAAAAADGN1cnJlbnRfdHVybgAAAAQAAAAAAAAAEmhhc19wZW5kaW5nX2F0dGFjawAAAAAAAQAAAAAAAAALcDFfcmV2ZWFsZWQAAAAD6gAAB9AAAAAMUmV2ZWFsZWRUaWxlAAAAAAAAAAtwMl9yZXZlYWxlZAAAAAPqAAAH0AAAAAxSZXZlYWxlZFRpbGUAAAAAAAAAE3BlbmRpbmdfYXR0YWNrX3RpbGUAAAAABAAAAAAAAAAFcGhhc2UAAAAAAAfQAAAABVBoYXNlAAAAAAAAAAAAAAdwbGF5ZXIxAAAAABMAAAAAAAAAEnBsYXllcjFfY29tbWl0bWVudAAAAAAD7gAAACAAAAAAAAAAEXBsYXllcjFfY29tbWl0dGVkAAAAAAAAAQAAAAAAAAAOcGxheWVyMV9wb2ludHMAAAAAAAsAAAAAAAAADXBsYXllcjFfc2NvcmUAAAAAAAAHAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAAEnBsYXllcjJfY29tbWl0bWVudAAAAAAD7gAAACAAAAAAAAAAEXBsYXllcjJfY29tbWl0dGVkAAAAAAAAAQAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAAAAAAADXBsYXllcjJfc2NvcmUAAAAAAAAHAAAAAAAAAA5za2lwX25leHRfdHVybgAAAAAAAQAAAAAAAAAGd2lubmVyAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADFJldmVhbGVkVGlsZQAAAAIAAAAAAAAACnRpbGVfaW5kZXgAAAAAAAQAAAAAAAAACXRpbGVfdHlwZQAAAAAAAAQ=",
        "AAAAAAAAAEZDdXJyZW50IHR1cm4gcGxheWVyIHBpY2tzIGEgdGlsZSBpbmRleCAoMC0xNCkgb24gdGhlIE9QUE9ORU5UJ1MgYm9hcmQuAAAAAAAGYXR0YWNrAAAAAAADAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAhhdHRhY2tlcgAAABMAAAAAAAAACnRpbGVfaW5kZXgAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAABxDaGVjayBpZiBWSyBoYXMgYmVlbiBzdG9yZWQuAAAABmhhc192awAAAAAAAAAAAAEAAAAB",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAR5TdG9yZSB0aGUgdmVyaWZpY2F0aW9uIGtleSBvbmNlIGFmdGVyIGRlcGxveS4KQ2FsbCB3aXRoIHRoZSByYXcgYmluYXJ5IGNvbnRlbnRzIG9mIGBjaXJjdWl0cy9wb2lzb25fZ2FtZS90YXJnZXQvdmtgCihnZW5lcmF0ZWQgd2l0aCBgYmIgd3JpdGVfdmsgLS1vcmFjbGVfaGFzaCBrZWNjYWtgKS4KVGhpcyBmdW5jdGlvbiBjYW4gb25seSBiZSBjYWxsZWQgYnkgYWRtaW4sIGFuZCBjYW4gYmUgY2FsbGVkIG11bHRpcGxlCnRpbWVzIHRvIHVwZ3JhZGUgdGhlIFZLIGlmIHRoZSBjaXJjdWl0IGNoYW5nZXMuAAAAAAAHaW5pdF92awAAAAACAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAACHZrX2J5dGVzAAAADgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAABBQb2xsIGdhbWUgc3RhdGUuAAAACGdldF9nYW1lAAAAAQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAEAAAPpAAAH0AAAAAlHYW1lU3RhdGUAAAAAAAAD",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAEBCb3RoIHBsYXllcnMgc2lnbiB0byBzdGFydCBhIGdhbWUuIENhbGxzIEdhbWVIdWIgdG8gbG9jayBwb2ludHMuAAAACnN0YXJ0X2dhbWUAAAAAAAUAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAB3BsYXllcjEAAAAAEwAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAAA5wbGF5ZXIxX3BvaW50cwAAAAAACwAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAI1FYWNoIHBsYXllciBjb21taXRzIHRoZWlyIGJvYXJkIGhhc2ggYmVmb3JlIHNlZWluZyBhbnkgdGlsZXMuCmBib2FyZF9oYXNoYCA9IHBlZGVyc2VuX2hhc2goW3RpbGUwLi50aWxlMTQsIHNhbHRdKSBmcm9tIHRoZSBicm93c2VyIFpLIGVuZ2luZS4AAAAAAAAMY29tbWl0X2JvYXJkAAAAAwAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAApib2FyZF9oYXNoAAAAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAGdEZXBsb3kgd2l0aCBhZG1pbiBhbmQgR2FtZUh1YiBhZGRyZXNzZXMuCkFmdGVyIGRlcGxveSwgY2FsbCBpbml0X3ZrKCkgd2l0aCB0aGUgVksgYnl0ZXMgZnJvbSB0YXJnZXQvdmsuAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAhnYW1lX2h1YgAAABMAAAAA",
        "AAAAAAAAAeFEZWZlbmRlciByZXNwb25kcyB3aXRoIHRoZSB0aWxlIHR5cGUgYW5kIGEgVWx0cmFIb25rIFpLIHByb29mLgoKIyBQcm9vZiBibG9iIGZvcm1hdCAoZnJvbSBicm93c2VyIHprUG9pc29uRW5naW5lKToKRXhhY3RseSBQUk9PRl9CWVRFUyAoMTQ1OTIpIHJhdyBieXRlcyBmcm9tIGBiYiBwcm92ZSAtLW9yYWNsZV9oYXNoIGtlY2Nha2AuCgojIFB1YmxpYyBpbnB1dHMgKHJlY29uc3RydWN0ZWQgb24tY2hhaW4gZnJvbSBzdG9yZWQgc3RhdGUpOgpbY29tbWl0bWVudDogMzJCXVt0aWxlX2luZGV4OiAzMkJdW3RpbGVfdHlwZTogMzJCXSA9IDk2IGJ5dGVzClRoZSBjb250cmFjdCBidWlsZHMgdGhlc2UgZnJvbSBpdHMgb3duIHN0b3JhZ2Ug4oCUIGRlZmVuZGVyIGNhbm5vdCB0YW1wZXIuCgojIFZlcmlmaWNhdGlvbjoKVXNlcyBgVWx0cmFIb25rVmVyaWZpZXI6Om5ldygmZW52LCAmdmtfYnl0ZXMpLnZlcmlmeSgmcHJvb2YsICZwdWJfaW5wdXRzKWAuAAAAAAAAEXJlc3BvbmRfdG9fYXR0YWNrAAAAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAIZGVmZW5kZXIAAAATAAAAAAAAAAl0aWxlX3R5cGUAAAAAAAAEAAAAAAAAAApwcm9vZl9ibG9iAAAAAAAOAAAAAQAAA+kAAAACAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    attack: this.txFromJSON<Result<void>>,
        has_vk: this.txFromJSON<boolean>,
        get_hub: this.txFromJSON<string>,
        init_vk: this.txFromJSON<Result<void>>,
        set_hub: this.txFromJSON<null>,
        upgrade: this.txFromJSON<null>,
        get_game: this.txFromJSON<Result<GameState>>,
        get_admin: this.txFromJSON<string>,
        set_admin: this.txFromJSON<null>,
        start_game: this.txFromJSON<Result<void>>,
        commit_board: this.txFromJSON<Result<void>>,
        respond_to_attack: this.txFromJSON<Result<void>>
  }
}