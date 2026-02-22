#![no_std]

//! # ZK Poison Game Contract
//!
//! Two-player tile-selection game with ZK proof enforcement.
//! Each player commits a board of 15 tiles (2 Poison + 1 Shield hidden among 12 Normal).
//! Players take turns attacking tiles on each other's board.
//! The defender must prove their tile type with a real UltraHonk ZK proof.
//! On-chain verification uses the ultrahonk_soroban_verifier crate (bb v0.87.0, --oracle_hash keccak).

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
    GameNotFound       = 1,
    NotPlayer          = 2,
    WrongPhase         = 3,
    AlreadyCommitted   = 4,
    NotYourTurn        = 5,
    TileAlreadyRevealed = 6,
    InvalidTileIndex   = 7,
    InvalidProof       = 8,
    GameAlreadyEnded   = 9,
    SelfPlay           = 10,
    VkNotSet           = 11,
    VkParseError       = 12,
    NotAdmin           = 13,
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
    pub tile_type:  u32, // 0=Normal, 1=Poison, 2=Shield
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameState {
    pub player1:         Address,
    pub player2:         Address,
    pub player1_points:  i128,
    pub player2_points:  i128,
    // Board commitments (pedersen hash stored as 32 bytes)
    pub player1_commitment: BytesN<32>,
    pub player2_commitment: BytesN<32>,
    pub player1_committed: bool,
    pub player2_committed: bool,
    // Turn state
    pub phase:              Phase,
    pub current_turn:       u32,    // 1 = player1, 2 = player2
    pub player1_score:      i64,
    pub player2_score:      i64,
    // Pending attack
    pub pending_attack_tile: u32,
    pub has_pending_attack:  bool,
    // Revealed tiles per board
    pub p1_revealed: Vec<RevealedTile>, // tiles revealed ON player1's board
    pub p2_revealed: Vec<RevealedTile>, // tiles revealed ON player2's board
    // Shield mechanic
    pub skip_next_turn: bool,
    // Winner: 0=none, 1=player1, 2=player2
    pub winner: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    GameHubAddress,
    Admin,
    Vk,          // Stored verification key bytes (1760 bytes from bb)
}

const GAME_TTL_LEDGERS: u32 = 518_400; // 30 days
const TOTAL_TILES: u32 = 15;
// 3 public inputs × 32 bytes each
const PUB_INPUT_BYTES: u32 = 96;

// ============================================================================
// Contract
// ============================================================================

#[contract]
pub struct PoisonGameContract;

#[contractimpl]
impl PoisonGameContract {

    /// Deploy with admin and GameHub addresses.
    /// After deploy, call init_vk() with the VK bytes from target/vk.
    pub fn __constructor(env: Env, admin: Address, game_hub: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GameHubAddress, &game_hub);
    }

    // ========================================================================
    // VK Management
    // ========================================================================

    /// Store the verification key once after deploy.
    /// Call with the raw binary contents of `circuits/poison_game/target/vk`
    /// (generated with `bb write_vk --oracle_hash keccak`).
    /// This function can only be called by admin, and can be called multiple
    /// times to upgrade the VK if the circuit changes.
    pub fn init_vk(env: Env, caller: Address, vk_bytes: Bytes) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin).expect("Admin not set");
        if caller != admin {
            return Err(Error::NotAdmin);
        }
        env.storage().instance().set(&DataKey::Vk, &vk_bytes);
        Ok(())
    }

    /// Check if VK has been stored.
    pub fn has_vk(env: Env) -> bool {
        env.storage().instance().has(&DataKey::Vk)
    }

    // ========================================================================
    // Game Lifecycle
    // ========================================================================

    /// Both players sign to start a game. Calls GameHub to lock points.
    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        if player1 == player2 {
            return Err(Error::SelfPlay);
        }

        player1.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player1_points.into_val(&env)]
        );
        player2.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player2_points.into_val(&env)]
        );

        let game_hub_addr: Address = env.storage().instance()
            .get(&DataKey::GameHubAddress).expect("GameHub not set");
        let game_hub = GameHubClient::new(&env, &game_hub_addr);
        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let zero_bytes = BytesN::from_array(&env, &[0u8; 32]);
        let game = GameState {
            player1: player1.clone(),
            player2: player2.clone(),
            player1_points,
            player2_points,
            player1_commitment: zero_bytes.clone(),
            player2_commitment: zero_bytes,
            player1_committed: false,
            player2_committed: false,
            phase: Phase::WaitingForCommits,
            current_turn: 1,
            player1_score: 0,
            player2_score: 0,
            pending_attack_tile: 0,
            has_pending_attack: false,
            p1_revealed: vec![&env],
            p2_revealed: vec![&env],
            skip_next_turn: false,
            winner: 0,
        };

        let key = DataKey::Game(session_id);
        env.storage().temporary().set(&key, &game);
        env.storage().temporary().extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Each player commits their board hash before seeing any tiles.
    /// `board_hash` = pedersen_hash([tile0..tile14, salt]) from the browser ZK engine.
    pub fn commit_board(
        env: Env,
        session_id: u32,
        player: Address,
        board_hash: BytesN<32>,
    ) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::WaitingForCommits {
            return Err(Error::WrongPhase);
        }

        if player == game.player1 {
            if game.player1_committed { return Err(Error::AlreadyCommitted); }
            game.player1_commitment = board_hash;
            game.player1_committed = true;
        } else if player == game.player2 {
            if game.player2_committed { return Err(Error::AlreadyCommitted); }
            game.player2_commitment = board_hash;
            game.player2_committed = true;
        } else {
            return Err(Error::NotPlayer);
        }

        if game.player1_committed && game.player2_committed {
            game.phase = Phase::Playing;
        }

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    /// Current turn player picks a tile index (0-14) on the OPPONENT'S board.
    pub fn attack(
        env: Env,
        session_id: u32,
        attacker: Address,
        tile_index: u32,
    ) -> Result<(), Error> {
        attacker.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::Playing       { return Err(Error::WrongPhase); }
        if game.winner != 0                    { return Err(Error::GameAlreadyEnded); }
        if game.has_pending_attack             { return Err(Error::WrongPhase); }
        if tile_index >= TOTAL_TILES           { return Err(Error::InvalidTileIndex); }

        let attacker_num = if attacker == game.player1 { 1u32 }
                           else if attacker == game.player2 { 2u32 }
                           else { return Err(Error::NotPlayer); };

        if attacker_num != game.current_turn   { return Err(Error::NotYourTurn); }

        // Check tile not already revealed on defender's board
        let defender_revealed = if attacker_num == 1 { &game.p2_revealed } else { &game.p1_revealed };
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

    /// Defender responds with the tile type and a UltraHonk ZK proof.
    ///
    /// # Proof blob format (from browser zkPoisonEngine):
    ///   Exactly PROOF_BYTES (14592) raw bytes from `bb prove --oracle_hash keccak`.
    ///
    /// # Public inputs (reconstructed on-chain from stored state):
    ///   [commitment: 32B][tile_index: 32B][tile_type: 32B] = 96 bytes
    ///   The contract builds these from its own storage — defender cannot tamper.
    ///
    /// # Verification:
    ///   Uses `UltraHonkVerifier::new(&env, &vk_bytes).verify(&proof, &pub_inputs)`.
    pub fn respond_to_attack(
        env: Env,
        session_id: u32,
        defender: Address,
        tile_type: u32,  // 0=Normal 1=Poison 2=Shield
        proof_blob: Bytes,
    ) -> Result<(), Error> {
        defender.require_auth();

        let key = DataKey::Game(session_id);
        let mut game: GameState = env.storage().temporary()
            .get(&key).ok_or(Error::GameNotFound)?;

        if game.phase != Phase::Playing  { return Err(Error::WrongPhase); }
        if game.winner != 0              { return Err(Error::GameAlreadyEnded); }
        if !game.has_pending_attack      { return Err(Error::WrongPhase); }
        if tile_type > 2                 { return Err(Error::InvalidProof); }

        let defender_num = if defender == game.player1 { 1u32 }
                           else if defender == game.player2 { 2u32 }
                           else { return Err(Error::NotPlayer); };

        let attacker_num = if defender_num == 1 { 2u32 } else { 1u32 };
        if attacker_num != game.current_turn { return Err(Error::NotYourTurn); }

        // Validate proof size: must be exactly PROOF_BYTES (14592 for bb v0.87.0)
        if proof_blob.len() != PROOF_BYTES as u32 {
            return Err(Error::InvalidProof);
        }

        // ── Load stored VK ────────────────────────────────────────────────
        let vk_bytes: Bytes = env.storage().instance()
            .get(&DataKey::Vk).ok_or(Error::VkNotSet)?;

        // ── Build public inputs from on-chain state (defender cannot lie) ─
        // Format: 3 field elements × 32 bytes each = 96 bytes, big-endian
        //   [0..32]  = commitment (defender's board hash stored at commit_board)
        //   [32..64] = tile_index (padded to 32 bytes BE)
        //   [64..96] = tile_type  (padded to 32 bytes BE, value claimed by defender)
        let defender_commitment = if defender_num == 1 {
            game.player1_commitment.clone()
        } else {
            game.player2_commitment.clone()
        };

        let mut pub_inputs = Bytes::new(&env);

        // commitment: 32 bytes
        pub_inputs.append(&Bytes::from(defender_commitment.clone()));

        // tile_index: 32 bytes BE (value 0-14, first 31 bytes = 0)
        let mut tile_idx_bytes = [0u8; 32];
        let tile_index = game.pending_attack_tile;
        tile_idx_bytes[31] = tile_index as u8;
        pub_inputs.append(&Bytes::from_array(&env, &tile_idx_bytes));

        // tile_type: 32 bytes BE (value 0-2, first 31 bytes = 0)
        let mut tile_type_bytes = [0u8; 32];
        tile_type_bytes[31] = tile_type as u8;
        pub_inputs.append(&Bytes::from_array(&env, &tile_type_bytes));

        // Sanity check
        assert!(pub_inputs.len() == PUB_INPUT_BYTES);

        // ── Real UltraHonk Proof Verification ─────────────────────────────
        let verifier = UltraHonkVerifier::new(&env, &vk_bytes)
            .map_err(|_| Error::VkParseError)?;
        verifier.verify(&proof_blob, &pub_inputs)
            .map_err(|_| Error::InvalidProof)?;

        // ── ZK proof verified — record the revealed tile ──────────────────
        let revealed = RevealedTile { tile_index, tile_type };
        if defender_num == 1 {
            game.p1_revealed.push_back(revealed);
        } else {
            game.p2_revealed.push_back(revealed);
        }

        // ── Apply score ───────────────────────────────────────────────────
        match tile_type {
            0 => { // Normal — attacker gains 1
                if attacker_num == 1 { game.player1_score += 1; }
                else                 { game.player2_score += 1; }
            }
            1 => { // Poison — attacker loses 3
                if attacker_num == 1 { game.player1_score -= 3; }
                else                 { game.player2_score -= 3; }
            }
            2 => { // Shield — attacker's NEXT turn is skipped
                game.skip_next_turn = true;
            }
            _ => { return Err(Error::InvalidProof); }
        }

        game.has_pending_attack = false;

        // ── Check if game is over (all tiles revealed on both boards) ─────
        let p1_done = game.p1_revealed.len() >= TOTAL_TILES;
        let p2_done = game.p2_revealed.len() >= TOTAL_TILES;

        if p1_done && p2_done {
            Self::finish_game(&env, session_id, &mut game)?;
        } else {
            // Switch turn
            if game.skip_next_turn {
                game.skip_next_turn = false;
                // Shield: defender gets to attack next (attacker's turn is skipped)
                game.current_turn = defender_num;  // ← ADD THIS LINE
            } else {
                game.current_turn = if game.current_turn == 1 { 2 } else { 1 };
            }
        }

        env.storage().temporary().set(&key, &game);
        Ok(())
    }

    /// Poll game state.
    pub fn get_game(env: Env, session_id: u32) -> Result<GameState, Error> {
        env.storage().temporary()
            .get(&DataKey::Game(session_id)).ok_or(Error::GameNotFound)
    }

    // ========================================================================
    // Internal
    // ========================================================================

    fn finish_game(env: &Env, session_id: u32, game: &mut GameState) -> Result<(), Error> {
        let player1_won = game.player1_score >= game.player2_score; // tie → player1

        let game_hub_addr: Address = env.storage().instance()
            .get(&DataKey::GameHubAddress).expect("GameHub not set");
        GameHubClient::new(env, &game_hub_addr).end_game(&session_id, &player1_won);

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

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn get_hub(env: Env) -> Address {
        env.storage().instance().get(&DataKey::GameHubAddress).expect("GameHub not set")
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}