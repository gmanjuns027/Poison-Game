pub fn validate_board(board_layout: [Field; 15]) {
    let mut poison_count: u32 = 0;
    let mut shield_count: u32 = 0;

    for i in 0..15 {
        let tile = board_layout[i] as u32;
        assert(tile <= 2, "Invalid tile value: must be 0, 1, or 2");
        if tile == 1 { poison_count += 1; }
        if tile == 2 { shield_count += 1; }
    }

    assert(poison_count == 2, "Board must have exactly 2 poison tiles");
    assert(shield_count == 1, "Board must have exactly 1 shield tile");
}