use std::hash::pedersen_hash;

pub fn verify_commitment(
    board_layout: [Field; 15],
    salt: Field,
    expected_commitment: Field,
) {
    let hash_inputs: [Field; 16] = [
        board_layout[0],  board_layout[1],  board_layout[2],
        board_layout[3],  board_layout[4],  board_layout[5],
        board_layout[6],  board_layout[7],  board_layout[8],
        board_layout[9],  board_layout[10], board_layout[11],
        board_layout[12], board_layout[13], board_layout[14],
        salt,
    ];
    let computed = pedersen_hash(hash_inputs);
    assert(computed == expected_commitment, "Commitment mismatch");
}