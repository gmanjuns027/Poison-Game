#![no_std]

//! # ZK Poison Game Contract
//!
//! Win condition: first player to find all 3 special tiles
//! (2 Poison + 1 Shield) on the opponent's board wins immediately.
//! Points wager is locked / paid out via GameHub.
//! ZK proof enforced via UltraHonk (bb v0.87.0, keccak oracle).

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    Address, Bytes, BytesN, Env, IntoVal, Vec, vec,
};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

// ============================================================================
// GameHub Client
// ============================================================================

#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );
    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

// ============================================================================
// Errors
// ============================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    GameNotFound        = 1,
    NotPlayer           = 2,
    WrongPhase          = 3,
    AlreadyCommitted    = 4,
    NotYourTurn         = 5,
    TileAlreadyRevealed = 6,
    InvalidTileIndex    = 7,
    InvalidProof        = 8,
    GameAlreadyEnded    = 9,
    SelfPlay            = 10,
    VkNotSet            = 11,
    VkParseError        = 12,
    NotAdmin            = 13,
}

// ============================================================================
// Data Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Phase {
    WaitingForCommits = 0,
    Playing           = 1,
    Finished          = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevealedTile {
    pub tile_index: u32,
    pub tile_type:  u32, // 0=Normal 1=Poison 2=Shield
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameState {
    pub player1:          Address,
    pub player2:          Address,
    pub player1_points:   i128,
    pub player2_points:   i128,
    // Board commitments — pedersen_hash([tiles..., salt])
    pub player1_commitment: BytesN<32>,
    pub player2_commitment: BytesN<32>,
    pub player1_committed:  bool,
    pub player2_committed:  bool,
    // Phase & turn
    pub phase:              Phase,
    pub current_turn:       u32,   // 1=player1, 2=player2
    // Pending attack
    pub pending_attack_tile: u32,
    pub has_pending_attack:  bool,
    // Revealed tiles per board
    pub p1_revealed: Vec<RevealedTile>, // tiles revealed ON player1's board (by player2)
    pub p2_revealed: Vec<RevealedTile>, // tiles revealed ON player2's board (by player1)
    // Shield skip flag
    // Winner: 0=none 1=player1 2=player2
    pub winner: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    GameHubAddress,
    Admin,
    Vk,
}

const GAME_TTL_LEDGERS: u32 = 518_400; // ~30 days
const TOTAL_TILES:      u32 = 15;
const PUB_INPUT_BYTES:  u32 = 96;      // 3 × 32-byte field elements

// ============================================================================
// Win-condition helper
// ============================================================================

/// Count how many Poison (type=1) and Shield (type=2) tiles
/// the attacker has already found in the defender's revealed list.
/// Returns (poison_found, shield_found).
fn count_specials(revealed: &Vec<RevealedTile>) -> (u32, u32) {
    let mut poison: u32 = 0;
    let mut shield: u32 = 0;
    for i in 0..revealed.len() {
        let t = revealed.get(i).unwrap().tile_type;
        if t == 1 { poison += 1; }
        if t == 2 { shield += 1; }
    }
    (poison, shield)
}

/// Did the attacker win? — found 2 Poison AND 1 Shield.
fn attacker_won(revealed: &Vec<RevealedTile>) -> bool {
    let (p, s) = count_specials(revealed);
    p >= 2 && s >= 1
}

// ============================================================================
// Contract
// ============================================================================

#[contract]
pub struct PoisonGameContract;

#[contractimpl]
impl PoisonGameContract {

    /// Deploy: set admin + GameHub address.
    /// Then call init_vk() with the UltraHonk VK bytes.
    pub fn __constructor(env: Env, admin: Address, game_hub: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GameHubAddress, &game_hub);
    }

    // ========================================================================
    // VK management
    // ========================================================================

    /// Store verification key after deploy (or when circuit changes).
    /// Only callable by admin.
    /// vk_bytes = raw bytes from `bb write_vk_ultra_honk -b target/poison_game.json`
    pub fn init_vk(env: Env, caller: Address, vk_bytes: Bytes) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin).expect("Admin not set");
        if caller != admin { return Err(Error::NotAdmin); }
        env.storage().instance().set(&DataKey::Vk, &vk_bytes);
        Ok(())
    }

    pub fn has_vk(env: Env) -> bool {
        env.storage().instance().has(&DataKey::Vk)
    }

    // ========================================================================
    // start_game — both players sign, GameHub locks points
    // ========================================================================

    pub fn start_game(
        env: Env,
        session_id:     u32,
        player1:        Address,
        player2:        Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        if player1 == player2 { return Err(Error::SelfPlay); }

        // Each player signs only their own session_id + points
        player1.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player1_points.into_val(&env)]
        );
        player2.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player2_points.into_val(&env)]
        );

        // Tell GameHub to lock both players' points into escrow
        let hub_addr: Address = env.storage().instance()
            .get(&DataKey::GameHubAddress).expect("GameHub not set");
        GameHubClient::new(&env, &hub_addr).start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let game = GameState {
            player1,
            player2,
            player1_points,
            player2_points,
            player1_commitment: zero.clone(),
            player2_commitment: zero,
            player1_committed: false,
            player2_committed: false,
            phase:              Phase::WaitingForCommits,
            current_turn:       1,
            pending_attack_tile: 0,
            has_pending_attack:  false,
            p1_revealed: vec![&env],
            p2_revealed: vec![&env],
            
            winner: 0,
        };

        let key = DataKey::Game(session_id);
        env.storage().temporary().set(&key, &game);
        env.storage().temporary().extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);
        Ok(())
    }

    // ========================================================================
    // commit_board — each player hashes their board before play begins
    // ========================================================================

    /// board_hash = pedersen_hash([tile0..tile14, salt]) computed in the browser.
    /// Once both players commit, phase moves to Playing.
    pub fn commit_board(
        env: Env,
        session_id: u32,
        player:     Address,
        board_hash: BytesN<32>,
    ) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::WaitingForCommits { return Err(Error::WrongPhase); }

        if player == game.player1 {
            if game.player1_committed { return Err(Error::AlreadyCommitted); }
            game.player1_commitment = board_hash;
            game.player1_committed  = true;
        } else if player == game.player2 {
            if game.player2_committed { return Err(Error::AlreadyCommitted); }
            game.player2_commitment = board_hash;
            game.player2_committed  = true;
        } else {
            return Err(Error::NotPlayer);
        }

        if game.player1_committed && game.player2_committed {
            game.phase = Phase::Playing;
        }

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    // ========================================================================
    // attack — current-turn player picks a tile on the opponent's board
    // ========================================================================

    pub fn attack(
        env:        Env,
        session_id: u32,
        attacker:   Address,
        tile_index: u32,
    ) -> Result<(), Error> {
        attacker.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::Playing  { return Err(Error::WrongPhase);       }
        if game.winner != 0              { return Err(Error::GameAlreadyEnded); }
        if game.has_pending_attack       { return Err(Error::WrongPhase);       }
        if tile_index >= TOTAL_TILES     { return Err(Error::InvalidTileIndex); }

        let attacker_num = if attacker == game.player1 { 1u32 }
                           else if attacker == game.player2 { 2u32 }
                           else { return Err(Error::NotPlayer); };

        if attacker_num != game.current_turn { return Err(Error::NotYourTurn); }

        // Ensure this tile has not already been revealed on defender's board
        let defender_revealed = if attacker_num == 1 { &game.p2_revealed }
                                else                  { &game.p1_revealed };
        for i in 0..defender_revealed.len() {
            if defender_revealed.get(i).unwrap().tile_index == tile_index {
                return Err(Error::TileAlreadyRevealed);
            }
        }

        game.pending_attack_tile = tile_index;
        game.has_pending_attack  = true;

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    // ========================================================================
    // respond_to_attack — defender proves their tile type with a ZK proof
    //
    // Win condition: if after recording this tile the attacker has found
    // 2 Poison + 1 Shield on the defender's board → attacker wins immediately.
    //
    // Proof format: PROOF_BYTES (14592) raw bytes from bb v0.87.0 keccak oracle.
    // Public inputs (96 bytes, built entirely from on-chain state):
    //   [0..32]  = defender's board commitment
    //   [32..64] = tile_index (u32, big-endian padded to 32 bytes)
    //   [64..96] = tile_type  (u32, big-endian padded to 32 bytes)
    // ========================================================================

    pub fn respond_to_attack(
        env:        Env,
        session_id: u32,
        defender:   Address,
        tile_type:  u32,   // 0=Normal 1=Poison 2=Shield
        proof_blob: Bytes,
    ) -> Result<(), Error> {
        defender.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::Playing { return Err(Error::WrongPhase);       }
        if game.winner != 0             { return Err(Error::GameAlreadyEnded); }
        if !game.has_pending_attack     { return Err(Error::WrongPhase);       }
        if tile_type > 2               { return Err(Error::InvalidProof);      }

        let defender_num = if defender == game.player1 { 1u32 }
                           else if defender == game.player2 { 2u32 }
                           else { return Err(Error::NotPlayer); };

        // Attacker is whoever has current_turn; defender must be the OTHER player
        let attacker_num = if defender_num == 1 { 2u32 } else { 1u32 };
        if attacker_num != game.current_turn { return Err(Error::NotYourTurn); }

        // Proof must be exactly PROOF_BYTES long
        if proof_blob.len() != PROOF_BYTES as u32 { return Err(Error::InvalidProof); }

        // ── Load VK ───────────────────────────────────────────────────────
        let vk_bytes: Bytes = env.storage().instance()
            .get(&DataKey::Vk).ok_or(Error::VkNotSet)?;

        // ── Build public inputs from on-chain state (defender cannot lie) ─
        let defender_commitment = if defender_num == 1 {
            game.player1_commitment.clone()
        } else {
            game.player2_commitment.clone()
        };

        let mut pub_inputs = Bytes::new(&env);

        // [0..32] commitment
        pub_inputs.append(&Bytes::from(defender_commitment));

        // [32..64] tile_index — big-endian u32 in 32 bytes
        let mut tile_idx_be = [0u8; 32];
        tile_idx_be[31] = game.pending_attack_tile as u8;
        // handle values > 255 properly (tile index 0-14 so u8 is fine, but be safe)
        tile_idx_be[28] = ((game.pending_attack_tile >> 24) & 0xff) as u8;
        tile_idx_be[29] = ((game.pending_attack_tile >> 16) & 0xff) as u8;
        tile_idx_be[30] = ((game.pending_attack_tile >>  8) & 0xff) as u8;
        tile_idx_be[31] = ( game.pending_attack_tile        & 0xff) as u8;
        pub_inputs.append(&Bytes::from_array(&env, &tile_idx_be));

        // [64..96] tile_type — big-endian u32 in 32 bytes
        let mut tile_type_be = [0u8; 32];
        tile_type_be[28] = ((tile_type >> 24) & 0xff) as u8;
        tile_type_be[29] = ((tile_type >> 16) & 0xff) as u8;
        tile_type_be[30] = ((tile_type >>  8) & 0xff) as u8;
        tile_type_be[31] = ( tile_type        & 0xff) as u8;
        pub_inputs.append(&Bytes::from_array(&env, &tile_type_be));

        assert!(pub_inputs.len() == PUB_INPUT_BYTES);

        // ── UltraHonk verification ────────────────────────────────────────
        let verifier = UltraHonkVerifier::new(&env, &vk_bytes)
            .map_err(|_| Error::VkParseError)?;
        verifier.verify(&proof_blob, &pub_inputs)
            .map_err(|_| Error::InvalidProof)?;

        // ── ZK verified — record the tile on the DEFENDER's revealed list ─
        let tile_index = game.pending_attack_tile;
        let revealed = RevealedTile { tile_index, tile_type };
        if defender_num == 1 {
            game.p1_revealed.push_back(revealed);
        } else {
            game.p2_revealed.push_back(revealed);
        }
        game.has_pending_attack = false;

        // ── Check win condition ───────────────────────────────────────────
        // Winner is the ATTACKER who just found the tile.
        // Check attacker's "found" list = defender's revealed board.
        let attacker_found = if attacker_num == 1 { &game.p2_revealed }
                             else                  { &game.p1_revealed };

        if attacker_won(attacker_found) {
            // Attacker found 2 Poison + 1 Shield — they win immediately
            let player1_won = attacker_num == 1;
            Self::finish_game(&env, session_id, &mut game, player1_won)?;
        } else {
    // Turn logic: shield = same player attacks again, otherwise switch
    if tile_type != 2 {
        game.current_turn = if game.current_turn == 1 { 2 } else { 1 };
    }
    // If tile_type == 2, turn stays the same – attacker gets another attack
}

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    // ========================================================================
    // get_game
    // ========================================================================

    pub fn get_game(env: Env, session_id: u32) -> Result<GameState, Error> {
        env.storage().temporary()
            .get(&DataKey::Game(session_id)).ok_or(Error::GameNotFound)
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    fn finish_game(
        env:          &Env,
        session_id:   u32,
        game:         &mut GameState,
        player1_won:  bool,
    ) -> Result<(), Error> {
        // Tell GameHub to pay out the winner from escrow
        let hub_addr: Address = env.storage().instance()
            .get(&DataKey::GameHubAddress).expect("GameHub not set");
        GameHubClient::new(env, &hub_addr).end_game(&session_id, &player1_won);

        game.winner = if player1_won { 1 } else { 2 };
        game.phase  = Phase::Finished;
        Ok(())
    }

    // ========================================================================
    // Admin
    // ========================================================================

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("Admin not set")
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn get_hub(env: Env) -> Address {
        env.storage().instance().get(&DataKey::GameHubAddress).expect("GameHub not set")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}