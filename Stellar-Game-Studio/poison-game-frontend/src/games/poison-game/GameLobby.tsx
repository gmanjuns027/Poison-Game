import { useState, useEffect, useRef } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { devWalletService } from '@/services/devWalletService';
import { poisonGameService } from './poisonGameService';
import { FIXED_WAGER } from '@/utils/constants';
import './GameLobby.css';

interface GameLobbyProps {
  onGameReady: (sessionId: number) => void;
}

export function GameLobby({ onGameReady }: GameLobbyProps) {
  const { walletType, getContractSigner } = useWallet();
  const [role, setRole] = useState<'player1' | 'player2' | null>(null);
  const [opponentAddress, setOpponentAddress] = useState('');
  const [sessionIdInput, setSessionIdInput] = useState('');
  const [xdrInput, setXdrInput] = useState('');
  const [createdSessionId, setCreatedSessionId] = useState<number | null>(null);
  const [createdXdr, setCreatedXdr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [waitingForOpponent, setWaitingForOpponent] = useState(false);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const ensureDevPlayer = async (player: 1 | 2) => {
    if (walletType === 'dev') {
      await devWalletService.initPlayer(player);
    }
  };

  const startPollingForGame = (sessionId: number) => {
    setWaitingForOpponent(true);
    pollIntervalRef.current = setInterval(async () => {
      try {
        const game = await poisonGameService.getGame(sessionId);
        if (game) {
          // Game found – opponent has joined
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setWaitingForOpponent(false);
          onGameReady(sessionId);
        }
      } catch (err) {
        // Ignore errors – game not found yet
      }
    }, 3000); // poll every 3 seconds
  };

  const handleCreateGame = async () => {
    if (!role || role !== 'player1') return;
    if (!opponentAddress) {
      setError('Please enter opponent’s Stellar address');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await ensureDevPlayer(1);
      const signer = getContractSigner();
      const myAddress = devWalletService.getPublicKey();
      const sessionId = Math.floor(Math.random() * 1000000000);

      const authXdr = await poisonGameService.prepareStartGame(
        sessionId,
        myAddress,
        opponentAddress,
        FIXED_WAGER,
        FIXED_WAGER,
        signer
      );

      setCreatedSessionId(sessionId);
      setCreatedXdr(authXdr);
      setSuccess('Game prepared! Copy the Session ID and Auth Code and send them to Player 2.');
      
      // Start polling for the game to appear (after Player 2 joins)
      startPollingForGame(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinGame = async () => {
    if (!role || role !== 'player2') return;
    if (!sessionIdInput || !xdrInput) {
      setError('Please enter Session ID and Auth Code');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await ensureDevPlayer(2);
      const signer = getContractSigner();
      const myAddress = devWalletService.getPublicKey();

      const signedXdr = await poisonGameService.importAndSignAuthEntry(
        xdrInput,
        myAddress,
        FIXED_WAGER,
        signer
      );

      await poisonGameService.finalizeStartGame(signedXdr, myAddress, signer);

      const sessionIdNum = parseInt(sessionIdInput, 10);
      if (isNaN(sessionIdNum)) throw new Error('Invalid Session ID');

      // Game is now on‑chain – proceed immediately
      onGameReady(sessionIdNum);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join game');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setSuccess('Copied to clipboard!');
    setTimeout(() => setSuccess(null), 2000);
  };

  return (
    <div className="game-lobby">
      
      <div className="role-selector">
        <label className={role === 'player1' ? 'selected' : ''}>
          <input
            type="radio"
            name="role"
            value="player1"
            checked={role === 'player1'}
            onChange={() => setRole('player1')}
          />
          I am Player 1 (Creator)
        </label>
        <label className={role === 'player2' ? 'selected' : ''}>
          <input
            type="radio"
            name="role"
            value="player2"
            checked={role === 'player2'}
            onChange={() => setRole('player2')}
          />
          I am Player 2 (Joiner)
        </label>
      </div>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}
      {waitingForOpponent && (
        <div className="info-message">⏳ Waiting for opponent to join...</div>
      )}

      {role === 'player1' && (
        <div className="creator-panel">
          <input
            type="text"
            placeholder="Opponent's Stellar Address"
            value={opponentAddress}
            onChange={(e) => setOpponentAddress(e.target.value)}
          />
          <button onClick={handleCreateGame} disabled={loading || waitingForOpponent}>
            {loading ? 'Preparing...' : 'Prepare Game'}
          </button>
          {createdSessionId && !waitingForOpponent && (
            <div className="game-info">
              <p>Session ID: <strong>{createdSessionId}</strong></p>
              <button onClick={() => handleCopy(createdSessionId.toString())}>Copy Session ID</button>
              <p>Auth Code (signed XDR):</p>
              <textarea readOnly rows={4} value={createdXdr || ''} />
              <button onClick={() => createdXdr && handleCopy(createdXdr)}>Copy Auth Code</button>
              <p className="hint">Send both to Player 2. After they join, the game will start automatically.</p>
            </div>
          )}
        </div>
      )}

      {role === 'player2' && (
        <div className="joiner-panel">
          <input
            type="text"
            placeholder="Session ID"
            value={sessionIdInput}
            onChange={(e) => setSessionIdInput(e.target.value)}
          />
          <textarea
            placeholder="Paste Auth Code here"
            rows={4}
            value={xdrInput}
            onChange={(e) => setXdrInput(e.target.value)}
          />
          <button onClick={handleJoinGame} disabled={loading}>
            {loading ? 'Joining...' : 'Join Game'}
          </button>
        </div>
      )}
    </div>
  );
}