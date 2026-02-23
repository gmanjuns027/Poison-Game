mod board;
mod commitment;

use board::validate_board;
use commitment::verify_commitment;

fn main(
    // Private witness
    board_layout: [Field; 15],
    salt: Field,

    // Public inputs
    commitment:       pub Field,
    tile_index:       pub u32,
    tile_type_result: pub u32,
) {
    // 1. Verify commitment
    verify_commitment(board_layout, salt, commitment);

    // 2. Verify the claimed tile type at tile_index
    let mut actual_tile: Field = 0;
    for i in 0..15 {
        if i as u32 == tile_index {
            actual_tile = board_layout[i];
        }
    }
    assert(
        actual_tile == tile_type_result as Field,
        "Tile type mismatch"
    );

    // 3. Validate board structure (exactly 2 poison, 1 shield)
    validate_board(board_layout);
}

#[test]
fn print_commitment() {
    // Use the exact board and salt from Prover.toml
    let board = [
        1, 0, 0, 0, 0,
        1, 0, 0, 0, 0,
        2, 0, 0, 0, 0
    ];
    let salt = 123456789;

    let mut inputs: [Field; 16] = [0; 16];
    for i in 0..15 {
        inputs[i] = board[i] as Field;
    }
    inputs[15] = salt as Field;

    let commitment = std::hash::pedersen_hash(inputs);
    std::println(commitment);
    assert(true);
}