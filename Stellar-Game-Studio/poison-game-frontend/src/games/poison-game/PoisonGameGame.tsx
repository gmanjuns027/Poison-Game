import { useState, useEffect, useRef, useMemo } from 'react';
import { GameLobby } from './GameLobby';
import { PoisonGameService } from './poisonGameService';
import { useWallet } from '@/hooks/useWallet';
import { POISON_GAME_CONTRACT } from '@/utils/constants';
import { devWalletService } from '@/services/devWalletService';
import { Phase } from './bindings';
import type { GameState } from './bindings';
import {
  computeBoardHash,
  generateTileProof,
  generateSalt,
  validateBoard,
  type TileType,
} from './zkPoisonEngine';
import './PoisonGame.css';

const svc = new PoisonGameService(POISON_GAME_CONTRACT);

const TILE_EMOJI: Record<number, string> = { 0: '⬜', 1: '☠️', 2: '🛡️' };
const TILE_LABEL: Record<number, string> = { 0: 'Normal', 1: 'Poison', 2: 'Shield' };

// ─── Board localStorage helpers ───────────────────────────────────────────────
interface StoredBoard {
  tiles: TileType[];
  salt: string;
  commitment: string;
}

const boardKey = (sid: number, addr: string) => `poison-board-${sid}-${addr}`;

function saveBoard(sid: number, addr: string, tiles: TileType[], salt: bigint, commitment: Buffer) {
  try {
    localStorage.setItem(boardKey(sid, addr), JSON.stringify({
      tiles, salt: salt.toString(), commitment: commitment.toString('hex'),
    } satisfies StoredBoard));
  } catch { /**/ }
}

function loadBoard(sid: number, addr: string): { tiles: TileType[]; salt: bigint; commitment: Buffer } | null {
  try {
    const raw = localStorage.getItem(boardKey(sid, addr));
    if (!raw) return null;
    const d: StoredBoard = JSON.parse(raw);
    return { tiles: d.tiles, salt: BigInt(d.salt), commitment: Buffer.from(d.commitment, 'hex') };
  } catch { return null; }
}

function clearBoard(sid: number, addr: string) {
  try { localStorage.removeItem(boardKey(sid, addr)); } catch { /**/ }
}

// Count how many specials (poison + shield) a player has found on opponent's board
function countSpecialsFound(revealed: Array<{ tile_index: number; tile_type: number }>): { poison: number; shield: number } {
  let poison = 0;
  let shield = 0;
  for (const r of revealed) {
    if (r.tile_type === 1) poison++;
    if (r.tile_type === 2) shield++;
  }
  return { poison, shield };
}

// Map an address to dev wallet slot (defaults to 1 if unknown)
const getDevWalletNum = (addr: string): 1 | 2 => {
  const p2 = import.meta.env.VITE_DEV_PLAYER2_ADDRESS;
  return addr === p2 ? 2 : 1;
};

// ─── Props ────────────────────────────────────────────────────────────────────
interface PoisonGameGameProps {
  userAddress: string;
  currentEpoch: number;
  availablePoints: bigint;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
  onGameModeChange?: (isLobby: boolean) => void;
}

export function PoisonGameGame({
  userAddress,
  availablePoints,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete,
  onGameModeChange,
}: PoisonGameGameProps) {
  const { walletType, getContractSigner } = useWallet();

  // ── Screen ──────────────────────────────────────────────────────────────
  const [screen, setScreen] = useState<'lobby' | 'game'>('lobby');
  const [sessionId, setSessionId] = useState<number>(0);

  // Locked at lobby exit — but in quick‑start we override them reactively
  const [myAddress, setMyAddress] = useState<string>('');
  const [myPlayerNum, setMyPlayerNum] = useState<1 | 2 | 0>(0);
  const [myDevWallet, setMyDevWallet] = useState<1 | 2>(1);

  // ── Quick‑start flag ───────────────────────────────────────────────────
  const [isQuickStart, setIsQuickStart] = useState(false);

  // ── Game phase ──────────────────────────────────────────────────────────
  const [gamePhase, setGamePhase] = useState<'commit' | 'play' | 'complete'>('commit');
  const [gameState, setGameState] = useState<GameState | null>(null);

  // ── Status ──────────────────────────────────────────────────────────────
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [zkProgress, setZkProgress] = useState<string | null>(null);

  // ── Board ───────────────────────────────────────────────────────────────
  const [myBoard, setMyBoard] = useState<TileType[]>(() => Array(15).fill(0) as TileType[]);
  const [activeTool, setActiveTool] = useState<TileType>(1);
  const [boardCommitted, setBoardCommitted] = useState(false);

  // ── Play ────────────────────────────────────────────────────────────────
  const [selectedAttackTile, setSelectedAttackTile] = useState<number | null>(null);

  const actionLock = useRef(false);
  const isBusy = loading || isCommitting || isResponding;

  // Load board data for the current player from localStorage
  const currentBoardData = useMemo(() => {
    if (screen !== 'game' || !myAddress || !sessionId) return null;
    return loadBoard(sessionId, myAddress);
  }, [screen, sessionId, myAddress]);

  // Derived counts for board validation
  const poisonCount = myBoard.filter(t => t === 1).length;
  const shieldCount = myBoard.filter(t => t === 2).length;
  const boardValid  = validateBoard(myBoard).valid;

  // Derived from gameState and myPlayerNum
  const winnerNum       = gameState?.winner ?? 0;
  const iAmPlayer1      = myPlayerNum === 1;
  const iAmPlayer2      = myPlayerNum === 2;
  const iWon            = winnerNum !== 0 && winnerNum === myPlayerNum;

  const isMyAttackTurn =
    myPlayerNum !== 0 &&
    !gameState?.has_pending_attack &&
    gameState?.current_turn === myPlayerNum;

  const isMyDefenseTurn =
    myPlayerNum !== 0 &&
    gameState?.has_pending_attack === true &&
    gameState?.current_turn !== myPlayerNum;

  const pendingTile      = gameState?.pending_attack_tile ?? 0;
  const myRevealedTiles  = iAmPlayer1 ? (gameState?.p1_revealed ?? []) : (gameState?.p2_revealed ?? []);
  const oppRevealedTiles = iAmPlayer1 ? (gameState?.p2_revealed ?? []) : (gameState?.p1_revealed ?? []);

  // Specials found – used in scorebar
  const p1Found = countSpecialsFound(gameState?.p2_revealed ?? []);
  const p2Found = countSpecialsFound(gameState?.p1_revealed ?? []);
  const myFound = iAmPlayer1 ? p1Found : p2Found;

  // ── Notify parent of lobby/game mode ───────────────────────────────────
  useEffect(() => {
    // Show switcher if we are in the lobby OR it's a quick‑start game
    const shouldShow = screen === 'lobby' || isQuickStart;
    onGameModeChange?.(shouldShow);
  }, [screen, isQuickStart, onGameModeChange]);

  // ── Sync boardCommitted from on-chain ───────────────────────────────────
  useEffect(() => {
    if (!gameState || !myAddress) { setBoardCommitted(false); return; }
    if      (myAddress === gameState.player1) setBoardCommitted(gameState.player1_committed);
    else if (myAddress === gameState.player2) setBoardCommitted(gameState.player2_committed);
    else                                      setBoardCommitted(false);
  }, [gameState, myAddress]);

  // ── Load board for current player when address changes ─────────────────
  useEffect(() => {
    if (screen !== 'game' || !myAddress) return;
    const loaded = loadBoard(sessionId, myAddress);
    if (loaded) {
      setMyBoard(loaded.tiles);
    } else {
      setMyBoard(Array(15).fill(0) as TileType[]);
    }
  }, [screen, sessionId, myAddress]);

  // ── Poll game state every 5s ────────────────────────────────────────────
  useEffect(() => {
    if (screen !== 'game' || !sessionId) return;
    const poll = async () => {
      try {
        const game = await svc.getGame(sessionId);
        if (!game) return;
        setGameState(game);
        if      (game.phase === Phase.Finished) setGamePhase('complete');
        else if (game.phase === Phase.Playing)  setGamePhase('play');
        else                                    setGamePhase('commit');
      } catch { /**/ }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [screen, sessionId]);

  // ── Auto-refresh standings on complete ─────────────────────────────────
  useEffect(() => {
    if (gamePhase === 'complete' && winnerNum !== 0) onStandingsRefresh();
  }, [gamePhase, winnerNum]);

  // ── React to wallet changes in quick‑start mode ────────────────────────
  useEffect(() => {
    if (!isQuickStart || screen !== 'game' || !gameState) return;
    if (userAddress === myAddress) return; // already set

    if (userAddress === gameState.player1) {
      setMyAddress(userAddress);
      setMyPlayerNum(1);
      setMyDevWallet(getDevWalletNum(userAddress));
    } else if (userAddress === gameState.player2) {
      setMyAddress(userAddress);
      setMyPlayerNum(2);
      setMyDevWallet(getDevWalletNum(userAddress));
    } else {
      setError('Current wallet is not a participant in this game.');
    }
  }, [isQuickStart, screen, gameState, userAddress, myAddress]);

  const runAction = async (action: () => Promise<void>) => {
    if (actionLock.current || isBusy) return;
    actionLock.current = true;
    try { await action(); }
    finally { actionLock.current = false; }
  };

  // ── Lobby callback ─────────────────────────────────────────────────────
  const handleGameReady = (
    sid: number,
    lockedAddress: string,
    lockedPlayerNum: 1 | 2,
    lockedDevWallet: 1 | 2,
    quickStart: boolean,
  ) => {
    setSessionId(sid);
    setMyAddress(lockedAddress);
    setMyPlayerNum(lockedPlayerNum);
    setMyDevWallet(lockedDevWallet);
    setIsQuickStart(quickStart);
    setScreen('game');
    setError(null);
    setSuccess(null);
  };

  const handlePlayAgain = () => {
    if (winnerNum !== 0) onGameComplete();
    actionLock.current = false;
    setScreen('lobby');
    setSessionId(0);
    setMyAddress('');
    setMyPlayerNum(0);
    setMyDevWallet(1);
    setIsQuickStart(false);
    setGameState(null);
    setGamePhase('commit');
    setMyBoard(Array(15).fill(0) as TileType[]);
    setBoardCommitted(false);
    setSelectedAttackTile(null);
    setZkProgress(null);
    setError(null);
    setSuccess(null);
    setLoading(false);
    setIsCommitting(false);
    setIsResponding(false);
  };

  // ════════════════════════════════════════════════════════════════════════
  // COMMIT BOARD
  // ════════════════════════════════════════════════════════════════════════
  const handleCommitBoard = async () => {
    if (!boardValid || boardCommitted) return;
    setIsCommitting(true);
    setError(null);
    try {
      const salt       = generateSalt();
      const commitment = await computeBoardHash(myBoard, salt);
      const signer     = getContractSigner();

      saveBoard(sessionId, myAddress, myBoard, salt, commitment);

      await svc.commitBoard(sessionId, myAddress, commitment, signer);

      setSuccess('Board locked! Waiting for opponent to lock theirs...');
      setTimeout(() => setSuccess(null), 5000);
    } catch (err) {
      setBoardCommitted(false);
      clearBoard(sessionId, myAddress);
      setError(err instanceof Error ? err.message : 'Failed to commit board');
    } finally {
      setIsCommitting(false);
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // ATTACK
  // ════════════════════════════════════════════════════════════════════════
  const handleAttack = async () => {
    if (selectedAttackTile === null) return;
    await runAction(async () => {
      try {
        setLoading(true);
        setError(null);
        const signer = getContractSigner();
        await svc.attack(sessionId, myAddress, selectedAttackTile, signer);
        const t = selectedAttackTile;
        setSelectedAttackTile(null);
        setSuccess(`⚔️ Attacked tile ${t}! Waiting for opponent to reveal...`);
        setTimeout(() => setSuccess(null), 5000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Attack failed');
      } finally {
        setLoading(false);
      }
    });
  };

  // ════════════════════════════════════════════════════════════════════════
  // RESPOND TO ATTACK — ZK proof
  // ════════════════════════════════════════════════════════════════════════
  const handleRespondToAttack = async () => {
    await runAction(async () => {
      setIsResponding(true);
      setError(null);
      try {
        const boardData = currentBoardData;
        if (!boardData) throw new Error('Board data not found. Did your browser storage get cleared?');

        const tileType = boardData.tiles[pendingTile] as TileType;

        const signer = getContractSigner();

        setZkProgress('Generating ZK proof... (~5–20 seconds)');
        const proof = await generateTileProof(
          boardData.tiles, boardData.salt, boardData.commitment, pendingTile, tileType
        );

        setZkProgress('Submitting proof on-chain...');
        await svc.respondToAttack(sessionId, myAddress, tileType, proof, signer);

        setZkProgress(null);
        setSuccess(`✅ ZK proof verified! Tile ${pendingTile} — ${TILE_EMOJI[tileType]} ${TILE_LABEL[tileType]}`);
        setTimeout(() => setSuccess(null), 6000);
        onStandingsRefresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to respond');
      } finally {
        setIsResponding(false);
        setZkProgress(null);
      }
    });
  };

  // ════════════════════════════════════════════════════════════════════════
  // RENDER — LOBBY
  // ════════════════════════════════════════════════════════════════════════
  if (screen === 'lobby') {
    return (
      <div className="poison-game">
        <GameLobby
          initialXDR={initialXDR}
          initialSessionId={initialSessionId}
          onGameReady={handleGameReady}
          onStandingsRefresh={onStandingsRefresh}
        />
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // RENDER — ACTIVE GAME
  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="poison-game">

      {/* ── Progress bar ─────────────────────────────────────────────── */}
      {gameState && (
        <div className="scorebar">
          <div className={`scorebar__player ${iAmPlayer1 ? 'scorebar__player--me' : ''}`}>
            <div className="scorebar__name">Player 1 {iAmPlayer1 && <span className="scorebar__you">(You)</span>}</div>
            <div className="scorebar__found">
              ☠️ {p1Found.poison}/2 &nbsp; 🛡️ {p1Found.shield}/1
            </div>
            <div className="scorebar__status">{gameState.player1_committed ? '✓ Board set' : '⏳ Setting board...'}</div>
          </div>
          <div className="scorebar__vs">vs</div>
          <div className={`scorebar__player ${iAmPlayer2 ? 'scorebar__player--me' : ''}`}>
            <div className="scorebar__name">Player 2 {iAmPlayer2 && <span className="scorebar__you">(You)</span>}</div>
            <div className="scorebar__found">
              ☠️ {p2Found.poison}/2 &nbsp; 🛡️ {p2Found.shield}/1
            </div>
            <div className="scorebar__status">{gameState.player2_committed ? '✓ Board set' : '⏳ Setting board...'}</div>
          </div>
        </div>
      )}

      {/* Status messages */}
      {error      && <div className="poison-game__msg poison-game__msg--error">{error}</div>}
      {success    && <div className="poison-game__msg poison-game__msg--success">{success}</div>}
      {zkProgress && (
        <div className="poison-game__msg poison-game__msg--zk">
          <span className="poison-game__spinner" aria-hidden="true" />
          {zkProgress}
        </div>
      )}

      {/* ══ COMMIT PHASE ══════════════════════════════════════════════════ */}
      {gamePhase === 'commit' && (
        <div className="phase commit-phase">
          {!boardCommitted ? (
            <>
              <p className="phase__title">🗺️ Place your secret tiles</p>
              <p className="phase__hint">
                Place <strong>2 Poison ☠️</strong> and <strong>1 Shield 🛡️</strong>.
                First to find all 3 on the opponent's board wins!
              </p>

              <div className="tool-selector">
                {([1, 2] as TileType[]).map(t => (
                  <button key={t} className={`tool-btn ${activeTool === t ? 'tool-btn--active' : ''}`} onClick={() => setActiveTool(t)}>
                    {TILE_EMOJI[t]} {TILE_LABEL[t]}
                    <span className="tool-btn__count">{t === 1 ? `${poisonCount}/2` : `${shieldCount}/1`}</span>
                  </button>
                ))}
              </div>

              <div className="board-grid">
                {myBoard.map((tile, idx) => (
                  <button
                    key={idx}
                    className={`tile ${tile === 1 ? 'tile--poison' : tile === 2 ? 'tile--shield' : 'tile--normal'}`}
                    onClick={() => {
                      const next = [...myBoard] as TileType[];
                      if (next[idx] === activeTool) { next[idx] = 0; }
                      else {
                        if (activeTool === 1 && poisonCount >= 2 && next[idx] !== 1) return;
                        if (activeTool === 2 && shieldCount >= 1 && next[idx] !== 2) return;
                        next[idx] = activeTool;
                      }
                      setMyBoard(next);
                    }}
                  >
                    {TILE_EMOJI[tile]}
                  </button>
                ))}
              </div>

              {!boardValid && (
                <p className="board-error">{validateBoard(myBoard).error ?? 'Place 2 Poison + 1 Shield to continue'}</p>
              )}

              <button className="action-btn" onClick={handleCommitBoard} disabled={!boardValid || isCommitting}>
                {isCommitting ? 'Locking board...' : '🔒 Lock Board'}
              </button>
            </>
          ) : (
            <div className="waiting-state">
              <div className="waiting-state__icon">✓</div>
              <p className="waiting-state__title">Your board is locked!</p>
              <p className="waiting-state__hint">Waiting for opponent to lock their board...</p>
            </div>
          )}
        </div>
      )}

      {/* ══ PLAY PHASE ════════════════════════════════════════════════════ */}
      {gamePhase === 'play' && (
        <div className="phase play-phase">

          {/* Hunt progress for current player */}
          <div className="hunt-progress">
            <span>Your hunt: ☠️ {myFound.poison}/2 &nbsp; 🛡️ {myFound.shield}/1</span>
            <span className="hunt-progress__goal">— Find all 3 to win!</span>
          </div>

          {isMyAttackTurn && (
            <div className="attack-section">
              <p className="phase__title">⚔️ Your turn — choose a tile to attack</p>
              <div className="board-grid">
                {Array.from({ length: 15 }, (_, idx) => {
                  const revealed = oppRevealedTiles.find(r => r.tile_index === idx);
                  const selected = selectedAttackTile === idx;
                  return (
                    <button
                      key={idx}
                      className={`tile ${revealed ? 'tile--revealed' : ''} ${selected ? 'tile--selected' : ''} ${!revealed ? 'tile--unknown' : ''}`}
                      onClick={() => !revealed && setSelectedAttackTile(idx)}
                      disabled={!!revealed}
                    >
                      {revealed ? TILE_EMOJI[revealed.tile_type] : selected ? '🎯' : '❓'}
                    </button>
                  );
                })}
              </div>
              <button className="action-btn action-btn--attack" onClick={handleAttack} disabled={selectedAttackTile === null || loading}>
                {loading ? 'Attacking...' : selectedAttackTile !== null ? `⚔️ Strike Tile ${selectedAttackTile}` : '⚔️ Select a tile first'}
              </button>
            </div>
          )}

          {isMyDefenseTurn && (
            <div className="defense-section">
              <p className="phase__title">🛡️ You were attacked on tile {pendingTile}!</p>
              {currentBoardData && (
                <p className="phase__hint">
                  Your tile: <strong>{TILE_EMOJI[currentBoardData.tiles[pendingTile]]} {TILE_LABEL[currentBoardData.tiles[pendingTile]]}</strong> — prove it with a ZK proof.
                </p>
              )}
              <button className="action-btn action-btn--defend" onClick={handleRespondToAttack} disabled={isResponding}>
                {isResponding ? (zkProgress ?? 'Generating proof...') : '🔐 Reveal & Prove'}
              </button>
            </div>
          )}

          {!isMyAttackTurn && !isMyDefenseTurn && (
            <div className="waiting-state">
              <p className="waiting-state__title">
                {gameState?.has_pending_attack
                  ? `⏳ Opponent is revealing tile ${pendingTile}...`
                  : '⏳ Waiting for opponent to attack...'}
              </p>
            </div>
          )}

          {/* Both boards overview */}
          <div className="boards-overview">
            <div className="boards-overview__side">
              <p className="boards-overview__label">Your Board (P{myPlayerNum})</p>
              <div className="board-grid board-grid--small">
                {Array.from({ length: 15 }, (_, idx) => {
                  const attacked = myRevealedTiles.find(r => r.tile_index === idx);
                  const myTile   = currentBoardData?.tiles[idx] ?? 0;
                  return (
                    <div key={idx} className={`tile tile--small ${attacked ? 'tile--revealed' : ''}`}>
                      {attacked ? TILE_EMOJI[attacked.tile_type] : TILE_EMOJI[myTile]}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="boards-overview__side">
              <p className="boards-overview__label">Opponent's Board</p>
              <div className="board-grid board-grid--small">
                {Array.from({ length: 15 }, (_, idx) => {
                  const revealed = oppRevealedTiles.find(r => r.tile_index === idx);
                  return (
                    <div key={idx} className={`tile tile--small ${revealed ? 'tile--revealed' : 'tile--unknown'}`}>
                      {revealed ? TILE_EMOJI[revealed.tile_type] : '❓'}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ COMPLETE PHASE ════════════════════════════════════════════════ */}
      {gamePhase === 'complete' && gameState && (
        <div className="phase complete-phase">
          <div className="complete-phase__hero">
            <span className="complete-phase__emoji">{iWon ? '🏆' : '☠️'}</span>
            <h3 className="complete-phase__title">{iWon ? 'You Won!' : 'Game Over'}</h3>
            <p className="complete-phase__sub">
              {iWon
                ? 'You found all 3 special tiles first! 🎉'
                : 'Opponent found all 3 special tiles first.'}
            </p>
          </div>

          <div className="complete-phase__scores">
            {[
              {
                num: 1, addr: gameState.player1,
                found: p1Found, isWinner: winnerNum === 1, isMe: iAmPlayer1,
              },
              {
                num: 2, addr: gameState.player2,
                found: p2Found, isWinner: winnerNum === 2, isMe: iAmPlayer2,
              },
            ].map(p => (
              <div
                key={p.num}
                className={`score-card ${p.isWinner ? 'score-card--winner' : ''} ${p.isMe ? 'score-card--me' : ''}`}
              >
                <div className="score-card__label">
                  Player {p.num}{p.isWinner && ' 🏆'}{p.isMe && ' (You)'}
                </div>
                <div className="score-card__addr">{p.addr.slice(0, 8)}...{p.addr.slice(-4)}</div>
                <div className="score-card__found">
                  ☠️ {p.found.poison}/2 &nbsp; 🛡️ {p.found.shield}/1
                </div>
                {p.isWinner && (
                  <div className="score-card__badge">Found all specials!</div>
                )}
              </div>
            ))}
          </div>

          <button className="action-btn" onClick={handlePlayAgain}>Play Again</button>
        </div>
      )}

    </div>
  );
}