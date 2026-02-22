import { useState, useEffect, useRef } from 'react';
import { GameLobby } from './GameLobby'; // import the lobby
import { poisonGameService } from './poisonGameService'; // import singleton
import { useWallet } from '@/hooks/useWallet';
import { POISON_GAME_CONTRACT } from '@/utils/constants';
import { devWalletService, DevWalletService } from '@/services/devWalletService';
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

// ─── Session ID helper ───────────────────────────────────────────────────────
const createRandomSessionId = (): number => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    let value = 0;
    const buffer = new Uint32Array(1);
    while (value === 0) {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    }
    return value;
  }
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
};

// REMOVE: const poisonGameService = new PoisonGameService(POISON_GAME_CONTRACT);

const TILE_EMOJI: Record<number, string> = { 0: '⬜', 1: '☠️', 2: '🛡️' };
const TILE_LABEL: Record<number, string> = { 0: 'Normal', 1: 'Poison', 2: 'Shield' };

// ─── Board localStorage ───────────────────────────────────────────────────────
interface StoredBoard {
  tiles: TileType[];
  salt: string;
  commitment: string;
}

const boardStorageKey = (sessionId: number, addr: string) =>
  `poison-board-${sessionId}-${addr}`;

function saveBoard(
  sessionId: number, addr: string,
  tiles: TileType[], salt: bigint, commitment: Buffer,
) {
  try {
    localStorage.setItem(boardStorageKey(sessionId, addr), JSON.stringify({
      tiles,
      salt: salt.toString(),
      commitment: commitment.toString('hex'),
    } satisfies StoredBoard));
  } catch { /* storage unavailable */ }
}

function loadBoard(sessionId: number, addr: string): {
  tiles: TileType[]; salt: bigint; commitment: Buffer;
} | null {
  try {
    const raw = localStorage.getItem(boardStorageKey(sessionId, addr));
    if (!raw) return null;
    const d: StoredBoard = JSON.parse(raw);
    return {
      tiles: d.tiles,
      salt: BigInt(d.salt),
      commitment: Buffer.from(d.commitment, 'hex'),
    };
  } catch { return null; }
}

interface PoisonGameGameProps {
  userAddress: string;
  currentEpoch: number;
  availablePoints: bigint;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
}

export function PoisonGameGame({
  userAddress,
  availablePoints,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete,
}: PoisonGameGameProps) {
  const DEFAULT_POINTS = '0.1';
  const POINTS_DECIMALS = 7;
  const { getContractSigner, walletType } = useWallet();

  const [screen, setScreen] = useState<'lobby' | 'game'>('lobby'); // new state
  const [sessionId, setSessionId] = useState<number>(() => createRandomSessionId());
  const [player1Address, setPlayer1Address] = useState(userAddress);
  const [player1Points, setPlayer1Points] = useState(DEFAULT_POINTS);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [quickstartLoading, setQuickstartLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [gamePhase, setGamePhase] = useState<'create' | 'commit' | 'play' | 'complete'>('create');
  
  const [myBoard, setMyBoard] = useState<TileType[]>(() => Array(15).fill(0) as TileType[]);
  const [activeTool, setActiveTool] = useState<TileType>(1);
  const [boardCommitted, setBoardCommitted] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [zkProgress, setZkProgress] = useState<string | null>(null);
  const [selectedAttackTile, setSelectedAttackTile] = useState<number | null>(null);
  const [savedBoardData, setSavedBoardData] = useState<{
    tiles: TileType[]; salt: bigint; commitment: Buffer;
  } | null>(null);

  const isBusy = loading || quickstartLoading || isCommitting || isResponding;
  const actionLock = useRef(false);
  const quickstartAvailable = walletType === 'dev'
    && DevWalletService.isDevModeAvailable()
    && DevWalletService.isPlayerAvailable(1)
    && DevWalletService.isPlayerAvailable(2);

  const poisonCount = myBoard.filter(t => t === 1).length;
  const shieldCount = myBoard.filter(t => t === 2).length;
  const boardValid = validateBoard(myBoard).valid;

  const winnerNum = gameState?.winner ?? 0;
  const iAmPlayer1 = gameState?.player1 === userAddress;
  const iAmPlayer2 = gameState?.player2 === userAddress;
  const myPlayerNum = iAmPlayer1 ? 1 : iAmPlayer2 ? 2 : 0;
  const iWon = winnerNum !== 0 && winnerNum === myPlayerNum;

  const isMyAttackTurn = myPlayerNum !== 0
    && !gameState?.has_pending_attack
    && gameState?.current_turn === myPlayerNum;
  const isMyDefenseTurn = myPlayerNum !== 0
    && gameState?.has_pending_attack === true
    && gameState?.current_turn !== myPlayerNum;
  const pendingTile = gameState?.pending_attack_tile ?? 0;

  const oppRevealedTiles = myPlayerNum === 1
    ? (gameState?.p2_revealed ?? [])
    : (gameState?.p1_revealed ?? []);

  useEffect(() => {
    setPlayer1Address(userAddress);
  }, [userAddress]);

  // Load saved board for this player/session, or reset to empty if none.
  useEffect(() => {
    if (screen === 'game' && (gamePhase === 'commit' || gamePhase === 'play') && userAddress && sessionId) {
      const saved = loadBoard(sessionId, userAddress);
      if (saved) {
        setSavedBoardData(saved);
        setMyBoard(saved.tiles);
      } else {
        setSavedBoardData(null);
        setMyBoard(Array(15).fill(0) as TileType[]);
      }
    }
  }, [sessionId, gamePhase, userAddress, screen]);

  // Sync boardCommitted with on‑chain game state.
  useEffect(() => {
    if (gameState) {
      if (userAddress === gameState.player1) {
        setBoardCommitted(gameState.player1_committed);
      } else if (userAddress === gameState.player2) {
        setBoardCommitted(gameState.player2_committed);
      } else {
        setBoardCommitted(false);
      }
    } else {
      setBoardCommitted(false);
    }
  }, [gameState, userAddress]);

  const runAction = async (action: () => Promise<void>) => {
    if (actionLock.current || isBusy) return;
    actionLock.current = true;
    try {
      await action();
    } finally {
      actionLock.current = false;
    }
  };

  const parsePoints = (value: string): bigint | null => {
    try {
      const cleaned = value.replace(/[^\d.]/g, '');
      if (!cleaned || cleaned === '.') return null;
      const [whole = '0', fraction = ''] = cleaned.split('.');
      const paddedFraction = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
      return BigInt(whole + paddedFraction);
    } catch {
      return null;
    }
  };

  const handleStartNewGame = () => {
    if (winnerNum !== 0) {
      onGameComplete();
    }
    actionLock.current = false;
    setScreen('lobby'); // go back to lobby
    setGamePhase('create');
    setSessionId(createRandomSessionId());
    setGameState(null);
    setLoading(false);
    setQuickstartLoading(false);
    setError(null);
    setSuccess(null);
    setPlayer1Address(userAddress);
    setPlayer1Points(DEFAULT_POINTS);
    setMyBoard(Array(15).fill(0) as TileType[]);
    setBoardCommitted(false);
    setIsCommitting(false);
    setIsResponding(false);
    setZkProgress(null);
    setSelectedAttackTile(null);
    setSavedBoardData(null);
  };

  const loadGameState = async () => {
    try {
      const game = await poisonGameService.getGame(sessionId);
      setGameState(game);
      if (game) {
        if (game.phase === Phase.Finished) setGamePhase('complete');
        else if (game.phase === Phase.Playing) setGamePhase('play');
        else setGamePhase('commit');
      }
    } catch (err) {
      setGameState(null);
    }
  };

  useEffect(() => {
    if (screen === 'game' && gamePhase !== 'create') {
      loadGameState();
      const interval = setInterval(loadGameState, 5000);
      return () => clearInterval(interval);
    }
  }, [sessionId, gamePhase, screen]);

  const handleQuickStart = async () => {
    await runAction(async () => {
      try {
        setQuickstartLoading(true);
        setError(null);
        setSuccess(null);

        if (walletType !== 'dev') {
          throw new Error('Quickstart only works with dev wallets.');
        }

        const p1Points = parsePoints(player1Points);
        if (!p1Points || p1Points <= 0n) throw new Error('Enter valid points');

        const originalPlayer = devWalletService.getCurrentPlayer();
        let p1Addr = '', p2Addr = '';
        let p1Signer, p2Signer;

        try {
          await devWalletService.initPlayer(1);
          p1Addr = devWalletService.getPublicKey();
          p1Signer = devWalletService.getSigner();
          await devWalletService.initPlayer(2);
          p2Addr = devWalletService.getPublicKey();
          p2Signer = devWalletService.getSigner();
        } finally {
          if (originalPlayer) await devWalletService.initPlayer(originalPlayer);
        }

        if (!p1Signer || !p2Signer) throw new Error('Signers failed');

        const qsId = createRandomSessionId();
        setSessionId(qsId);

        setSuccess('Creating game...');
        const authXDR = await poisonGameService.prepareStartGame(
          qsId, p1Addr, p2Addr, p1Points, p1Points, p1Signer
        );
        const signedXDR = await poisonGameService.importAndSignAuthEntry(
          authXDR, p2Addr, p1Points, p2Signer
        );
        await poisonGameService.finalizeStartGame(signedXDR, p2Addr, p2Signer);

        let gameExists = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const g = await poisonGameService.getGame(qsId);
          if (g) {
            gameExists = true;
            break;
          }
        }
        if (!gameExists) throw new Error('Game not found after creation');

        setGamePhase('commit');
        setScreen('game'); // switch to game screen
        onStandingsRefresh();
        setSuccess('Game created! Now place your tiles and commit.');
        setTimeout(() => setSuccess(null), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Quickstart failed');
      } finally {
        setQuickstartLoading(false);
      }
    });
  };

  const handleCommitBoard = async () => {
    if (!boardValid) return;
    setIsCommitting(true);
    try {
      const salt = generateSalt();
      const commitment = await computeBoardHash(myBoard, salt);
      const signer = getContractSigner();
      saveBoard(sessionId, userAddress, myBoard, salt, commitment);
      setSavedBoardData({ tiles: myBoard, salt, commitment });

      await poisonGameService.commitBoard(sessionId, userAddress, commitment, signer);

      setBoardCommitted(true);
      await loadGameState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit');
      setBoardCommitted(false);
    } finally {
      setIsCommitting(false);
    }
  };

  const handleAttack = async () => {
    if (selectedAttackTile === null) return;
    await runAction(async () => {
      try {
        setLoading(true);
        const signer = getContractSigner();
        await poisonGameService.attack(sessionId, userAddress, selectedAttackTile, signer);
        setSelectedAttackTile(null);
        await loadGameState();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Attack failed');
      } finally {
        setLoading(false);
      }
    });
  };

  const handleRespondToAttack = async () => {
    await runAction(async () => {
      setIsResponding(true);
      try {
        const boardData = savedBoardData ?? loadBoard(sessionId, userAddress);
        if (!boardData) throw new Error('Board data lost');
        const tileType = boardData.tiles[pendingTile] as TileType;
        const signer = getContractSigner();
        setZkProgress('Generating ZK proof...');
        const proof = await generateTileProof(boardData.tiles, boardData.salt, boardData.commitment, pendingTile, tileType);
        await poisonGameService.respondToAttack(sessionId, userAddress, tileType, proof, signer);
        setZkProgress(null);
        await loadGameState();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Response failed');
      } finally {
        setIsResponding(false);
        setZkProgress(null);
      }
    });
  };

  const handleGameReady = (newSessionId: number) => {
    setSessionId(newSessionId);
    setScreen('game');
    // The polling will pick up the game state and set the phase
  };

  // Render lobby if screen is lobby
  if (screen === 'lobby') {
    return (
      <div className="poison-game">
        <div className="poison-game__header">
          <h2 className="poison-game__title">
            Poison Game ☠️
          </h2>
          <p className="poison-game__subtitle">
            Hide your poison tiles. Last one standing wins!
          </p>
        </div>
        {error && <div className="poison-game__message poison-game__message--error">{error}</div>}
        {success && <div className="poison-game__message poison-game__message--success">{success}</div>}
        <GameLobby onGameReady={handleGameReady} />
        {/* Optionally keep quickstart for dev */}
        {walletType === 'dev' && (
          <div style={{ marginTop: '2rem', textAlign: 'center' }}>
            <hr />
            <p>Dev quickstart (for testing):</p>
            <button onClick={handleQuickStart} disabled={quickstartLoading}>
              {quickstartLoading ? 'Creating...' : 'Quickstart Game'}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Render game board if screen is game
  return (
    <div className="poison-game">
      <div className="poison-game__header">
        <h2 className="poison-game__title">
          Poison Game ☠️
        </h2>
        <p className="poison-game__subtitle">
          Hide your poison tiles. Last one standing wins!
        </p>
        <button className="back-to-lobby" onClick={() => setScreen('lobby')}>← Back to Lobby</button>
      </div>

      {error && <div className="poison-game__message poison-game__message--error">{error}</div>}
      {success && <div className="poison-game__message poison-game__message--success">{success}</div>}

      {gamePhase === 'commit' && (
        <div className="commit-phase">
          <div className="board-grid">
            {myBoard.map((tile, idx) => (
              <button
                key={idx}
                onClick={() => {
                  if (boardCommitted) return;
                  const newBoard = [...myBoard] as TileType[];
                  if (newBoard[idx] === activeTool) newBoard[idx] = 0;
                  else {
                    if (activeTool === 1 && poisonCount >= 2) return;
                    if (activeTool === 2 && shieldCount >= 1) return;
                    newBoard[idx] = activeTool;
                  }
                  setMyBoard(newBoard);
                }}
                className={`tile ${tile === 1 ? 'tile--poison' : tile === 2 ? 'tile--shield' : ''}`}
                disabled={boardCommitted}
              >
                {TILE_EMOJI[tile]}
              </button>
            ))}
          </div>
          <div className="tool-selector">
            {[1, 2].map((t) => (
              <button
                key={t}
                onClick={() => setActiveTool(t as TileType)}
                className={`tool-button ${activeTool === t ? 'tool-button--active' : ''}`}
              >
                {TILE_EMOJI[t]} {TILE_LABEL[t]}
              </button>
            ))}
          </div>
          <button
            onClick={handleCommitBoard}
            disabled={!boardValid || isCommitting || boardCommitted}
            className="action-button"
          >
            {boardCommitted ? 'Waiting for Opponent...' : 'Lock Board & Start'}
          </button>
        </div>
      )}

      {gamePhase === 'play' && (
        <div className="play-phase">
          <div className="attack-grid">
            {Array.from({ length: 15 }, (_, idx) => {
              const revealed = oppRevealedTiles.find(r => r.tile_index === idx);
              return (
                <button
                  key={idx}
                  onClick={() => !revealed && setSelectedAttackTile(idx)}
                  className={`attack-tile ${revealed ? 'attack-tile--revealed' : ''} ${selectedAttackTile === idx ? 'attack-tile--selected' : ''}`}
                  disabled={!!revealed}
                >
                  {revealed ? TILE_EMOJI[revealed.tile_type] : selectedAttackTile === idx ? '🎯' : '❓'}
                </button>
              );
            })}
          </div>
          {isMyAttackTurn && (
            <button
              onClick={handleAttack}
              disabled={selectedAttackTile === null}
              className="attack-button"
            >
              Attack Selected Tile
            </button>
          )}
          {isMyDefenseTurn && (
            <button
              onClick={handleRespondToAttack}
              className="defense-button"
            >
              {isResponding ? zkProgress : `Reveal Tile ${pendingTile}`}
            </button>
          )}
        </div>
      )}

      {gamePhase === 'complete' && (
        <div className="complete-container">
          <div className="complete-emoji">{iWon ? '🏆' : '☠️'}</div>
          <h3 className="complete-title">{iWon ? 'You Won!' : 'Game Over'}</h3>
          <button onClick={handleStartNewGame} className="play-again-button">Play Again</button>
        </div>
      )}
    </div>
  );
}