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
    contractId: "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG",
  }
} as const



export interface Client {
  /**
   * Construct and simulate a end_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * End a game session and declare winner
   * 
   * # Arguments
   * * `session_id` - The game session being ended
   * * `player1_won` - True if player1 won, false if player2 won
   */
  end_game: ({session_id, player1_won}: {session_id: u32, player1_won: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Start a game session
   * 
   * # Arguments
   * * `game_id` - Address of the game contract calling this method
   * * `session_id` - Unique identifier for this game session
   * * `player1` - Address of first player
   * * `player2` - Address of second player
   * * `player1_points` - Points amount for player 1 (ignored in mock)
   * * `player2_points` - Points amount for player 2 (ignored in mock)
   */
  start_game: ({game_id, session_id, player1, player2, player1_points, player2_points}: {game_id: string, session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
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
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABQAAAAAAAAAAAAAACUdhbWVFbmRlZAAAAAAAAAEAAAAKZ2FtZV9lbmRlZAAAAAAAAgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAAAAAAC3BsYXllcjFfd29uAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAC0dhbWVTdGFydGVkAAAAAAEAAAAMZ2FtZV9zdGFydGVkAAAABgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAAAAAAB2dhbWVfaWQAAAAAEwAAAAAAAAAAAAAAB3BsYXllcjEAAAAAEwAAAAAAAAAAAAAAB3BsYXllcjIAAAAAEwAAAAAAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAAAAAAAOcGxheWVyMl9wb2ludHMAAAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAAJxFbmQgYSBnYW1lIHNlc3Npb24gYW5kIGRlY2xhcmUgd2lubmVyCgojIEFyZ3VtZW50cwoqIGBzZXNzaW9uX2lkYCAtIFRoZSBnYW1lIHNlc3Npb24gYmVpbmcgZW5kZWQKKiBgcGxheWVyMV93b25gIC0gVHJ1ZSBpZiBwbGF5ZXIxIHdvbiwgZmFsc2UgaWYgcGxheWVyMiB3b24AAAAIZW5kX2dhbWUAAAACAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAtwbGF5ZXIxX3dvbgAAAAABAAAAAA==",
        "AAAAAAAAAWpTdGFydCBhIGdhbWUgc2Vzc2lvbgoKIyBBcmd1bWVudHMKKiBgZ2FtZV9pZGAgLSBBZGRyZXNzIG9mIHRoZSBnYW1lIGNvbnRyYWN0IGNhbGxpbmcgdGhpcyBtZXRob2QKKiBgc2Vzc2lvbl9pZGAgLSBVbmlxdWUgaWRlbnRpZmllciBmb3IgdGhpcyBnYW1lIHNlc3Npb24KKiBgcGxheWVyMWAgLSBBZGRyZXNzIG9mIGZpcnN0IHBsYXllcgoqIGBwbGF5ZXIyYCAtIEFkZHJlc3Mgb2Ygc2Vjb25kIHBsYXllcgoqIGBwbGF5ZXIxX3BvaW50c2AgLSBQb2ludHMgYW1vdW50IGZvciBwbGF5ZXIgMSAoaWdub3JlZCBpbiBtb2NrKQoqIGBwbGF5ZXIyX3BvaW50c2AgLSBQb2ludHMgYW1vdW50IGZvciBwbGF5ZXIgMiAoaWdub3JlZCBpbiBtb2NrKQAAAAAACnN0YXJ0X2dhbWUAAAAAAAYAAAAAAAAAB2dhbWVfaWQAAAAAEwAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    end_game: this.txFromJSON<null>,
        start_game: this.txFromJSON<null>
  }
}