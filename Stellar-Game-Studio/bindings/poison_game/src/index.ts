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
    contractId: "CDJ4JTCP6PB4YCA4TJKZI3PAGI556I6KW3DDAG2JNM42CK4I6JGHNPND",
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
  player2: string;
  player2_commitment: Buffer;
  player2_committed: boolean;
  player2_points: i128;
  winner: u32;
}


export interface RevealedTile {
  tile_index: u32;
  tile_type: u32;
}

export interface Client {
  /**
   * Construct and simulate a attack transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  attack: ({session_id, attacker, tile_index}: {session_id: u32, attacker: string, tile_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a has_vk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  has_vk: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_hub: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a init_vk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store verification key after deploy (or when circuit changes).
   * Only callable by admin.
   * vk_bytes = raw bytes from `bb write_vk_ultra_honk -b target/poison_game.json`
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
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_board transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * board_hash = pedersen_hash([tile0..tile14, salt]) computed in the browser.
   * Once both players commit, phase moves to Playing.
   */
  commit_board: ({session_id, player, board_hash}: {session_id: u32, player: string, board_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a respond_to_attack transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
        "AAAAAQAAAAAAAAAAAAAACUdhbWVTdGF0ZQAAAAAAAA8AAAAAAAAADGN1cnJlbnRfdHVybgAAAAQAAAAAAAAAEmhhc19wZW5kaW5nX2F0dGFjawAAAAAAAQAAAAAAAAALcDFfcmV2ZWFsZWQAAAAD6gAAB9AAAAAMUmV2ZWFsZWRUaWxlAAAAAAAAAAtwMl9yZXZlYWxlZAAAAAPqAAAH0AAAAAxSZXZlYWxlZFRpbGUAAAAAAAAAE3BlbmRpbmdfYXR0YWNrX3RpbGUAAAAABAAAAAAAAAAFcGhhc2UAAAAAAAfQAAAABVBoYXNlAAAAAAAAAAAAAAdwbGF5ZXIxAAAAABMAAAAAAAAAEnBsYXllcjFfY29tbWl0bWVudAAAAAAD7gAAACAAAAAAAAAAEXBsYXllcjFfY29tbWl0dGVkAAAAAAAAAQAAAAAAAAAOcGxheWVyMV9wb2ludHMAAAAAAAsAAAAAAAAAB3BsYXllcjIAAAAAEwAAAAAAAAAScGxheWVyMl9jb21taXRtZW50AAAAAAPuAAAAIAAAAAAAAAARcGxheWVyMl9jb21taXR0ZWQAAAAAAAABAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAAAAAAGd2lubmVyAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADFJldmVhbGVkVGlsZQAAAAIAAAAAAAAACnRpbGVfaW5kZXgAAAAAAAQAAAAAAAAACXRpbGVfdHlwZQAAAAAAAAQ=",
        "AAAAAAAAAAAAAAAGYXR0YWNrAAAAAAADAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAhhdHRhY2tlcgAAABMAAAAAAAAACnRpbGVfaW5kZXgAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAGaGFzX3ZrAAAAAAAAAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAKRTdG9yZSB2ZXJpZmljYXRpb24ga2V5IGFmdGVyIGRlcGxveSAob3Igd2hlbiBjaXJjdWl0IGNoYW5nZXMpLgpPbmx5IGNhbGxhYmxlIGJ5IGFkbWluLgp2a19ieXRlcyA9IHJhdyBieXRlcyBmcm9tIGBiYiB3cml0ZV92a191bHRyYV9ob25rIC1iIHRhcmdldC9wb2lzb25fZ2FtZS5qc29uYAAAAAdpbml0X3ZrAAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAIdmtfYnl0ZXMAAAAOAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAAAAAAAAIZ2V0X2dhbWUAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAQAAA+kAAAfQAAAACUdhbWVTdGF0ZQAAAAAAAAM=",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAAKc3RhcnRfZ2FtZQAAAAAABQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHxib2FyZF9oYXNoID0gcGVkZXJzZW5faGFzaChbdGlsZTAuLnRpbGUxNCwgc2FsdF0pIGNvbXB1dGVkIGluIHRoZSBicm93c2VyLgpPbmNlIGJvdGggcGxheWVycyBjb21taXQsIHBoYXNlIG1vdmVzIHRvIFBsYXlpbmcuAAAADGNvbW1pdF9ib2FyZAAAAAMAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABnBsYXllcgAAAAAAEwAAAAAAAAAKYm9hcmRfaGFzaAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAFVEZXBsb3k6IHNldCBhZG1pbiArIEdhbWVIdWIgYWRkcmVzcy4KVGhlbiBjYWxsIGluaXRfdmsoKSB3aXRoIHRoZSBVbHRyYUhvbmsgVksgYnl0ZXMuAAAAAAAADV9fY29uc3RydWN0b3IAAAAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAACGdhbWVfaHViAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAARcmVzcG9uZF90b19hdHRhY2sAAAAAAAAEAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAhkZWZlbmRlcgAAABMAAAAAAAAACXRpbGVfdHlwZQAAAAAAAAQAAAAAAAAACnByb29mX2Jsb2IAAAAAAA4AAAABAAAD6QAAAAIAAAAD" ]),
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