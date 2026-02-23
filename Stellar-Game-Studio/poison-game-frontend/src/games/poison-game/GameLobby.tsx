import { useState, useEffect, useRef } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { devWalletService, DevWalletService } from '@/services/devWalletService';
import { PoisonGameService } from './poisonGameService';
import { POISON_GAME_CONTRACT } from '@/utils/constants';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';
import { getLocationSearch } from '@/utils/location';
import './GameLobby.css';

const svc = new PoisonGameService(POISON_GAME_CONTRACT);

const createRandomSessionId = (): number => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    let value = 0;
    const buffer = new Uint32Array(1);
    while (value === 0) { crypto.getRandomValues(buffer); value = buffer[0]; }
    return value;
  }
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
};

const POINTS_DECIMALS = 7;
const parsePoints = (value: string): bigint | null => {
  try {
    const cleaned = value.replace(/[^\d.]/g, '');
    if (!cleaned || cleaned === '.') return null;
    const [whole = '0', fraction = ''] = cleaned.split('.');
    const padded = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
    return BigInt(whole + padded);
  } catch { return null; }
};

// Strip share URL down to raw auth XDR or session ID string
function extractRaw(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const auth = url.searchParams.get('auth');
    const sid  = url.searchParams.get('session-id');
    if (auth) return auth.trim();
    if (sid)  return sid.trim();
  } catch { /* not a URL */ }
  return trimmed;
}

export interface GameLobbyProps {
  initialXDR?:       string | null;
  initialSessionId?: number | null;
  /**
   * Called when game is confirmed on-chain and ready to play.
   * PoisonGameGame uses these to know who the current player is
   * without re-deriving from on-chain state.
   *
   * quickStart = true for quick‑start games, false for all others.
   */
  onGameReady: (
    sessionId:   number,
    myAddress:   string,
    myPlayerNum: 1 | 2,
    myDevWallet: 1 | 2,
    quickStart:  boolean,          // ← new parameter
  ) => void;
  onStandingsRefresh?: () => void;
}

export function GameLobby({
  initialXDR,
  initialSessionId,
  onGameReady,
  onStandingsRefresh,
}: GameLobbyProps) {
  const { walletType, getContractSigner, publicKey } = useWallet();
  const currentAddress = publicKey ?? '';

  const [card, setCard] = useState<'create' | 'existing' | 'quickstart'>('create');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ── CREATE ─────────────────────────────────────────────────────────────
  const [createPoints, setCreatePoints] = useState('0.1');
  const [createdAuthXDR, setCreatedAuthXDR] = useState<string | null>(null);
  const [waitingForOpponent, setWaitingForOpponent] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);

  // ── EXISTING / JOIN ────────────────────────────────────────────────────
  const [existingInput, setExistingInput] = useState('');
  const [existingCleanedRaw, setExistingCleanedRaw] = useState('');
  const [existingPoints, setExistingPoints] = useState('0.1');
  const [existingParseStatus, setExistingParseStatus] = useState<
    'idle' | 'parsing' | 'ok-xdr' | 'ok-sid' | 'error'
  >('idle');
  const [existingParseError, setExistingParseError] = useState<string | null>(null);
  const [existingParsed, setExistingParsed] = useState<{
    sessionId:     number;
    player1:       string;
    player1Points: string;
    isXDR:         boolean;
  } | null>(null);

  // ── QUICKSTART ─────────────────────────────────────────────────────────
  const [qsPoints, setQsPoints] = useState('0.1');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const quickstartAvailable =
    walletType === 'dev' &&
    DevWalletService.isDevModeAvailable() &&
    DevWalletService.isPlayerAvailable(1) &&
    DevWalletService.isPlayerAvailable(2);

  // Map an address to dev wallet slot (defaults to 1 if unknown)
  const getDevWalletNum = (addr: string): 1 | 2 => {
    const p2 = import.meta.env.VITE_DEV_PLAYER2_ADDRESS;
    return addr === p2 ? 2 : 1;
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // Deep link / prop on mount
  useEffect(() => {
    const params = new URLSearchParams(getLocationSearch());
    const auth = initialXDR ?? params.get('auth');
    const sid  = initialSessionId != null ? String(initialSessionId) : params.get('session-id');
    if (auth) { setCard('existing'); setExistingInput(auth); }
    else if (sid) { setCard('existing'); setExistingInput(sid); }
  }, [initialXDR, initialSessionId]);

  // Auto-parse existing input with debounce
  useEffect(() => {
    if (card !== 'existing' || !existingInput.trim()) {
      setExistingParseStatus('idle');
      setExistingParsed(null);
      setExistingCleanedRaw('');
      setExistingParseError(null);
      return;
    }

    const timer = setTimeout(async () => {
      setExistingParseStatus('parsing');
      setExistingParseError(null);

      const raw = extractRaw(existingInput);
      setExistingCleanedRaw(raw);

      // Plain session ID — digits only
      const asNum = Number(raw);
      if (/^\d+$/.test(raw) && Number.isInteger(asNum) && asNum > 0) {
        try {
          const game = await svc.getGame(asNum);
          if (game) {
            setExistingParsed({
              sessionId:     asNum,
              player1:       game.player1,
              player1Points: (Number(game.player1_points) / 10_000_000).toString(),
              isXDR:         false,
            });
            setExistingParseStatus('ok-sid');
          } else {
            setExistingParseStatus('error');
            setExistingParseError(
              'Game not found. If just created, share the auth URL with your opponent first — they must join before the game exists on-chain.'
            );
          }
        } catch {
          setExistingParseStatus('error');
          setExistingParseError('Could not check game. Try again.');
        }
        return;
      }

      // Auth entry XDR
      try {
        const parsed = svc.parseAuthEntry(raw);
        setExistingParsed({
          sessionId:     parsed.sessionId,
          player1:       parsed.player1,
          player1Points: (Number(parsed.player1Points) / 10_000_000).toString(),
          isXDR:         true,
        });
        setExistingParseStatus('ok-xdr');
      } catch {
        setExistingParseStatus('error');
        setExistingParseError('Invalid — paste a share URL, auth entry XDR, or a Session ID.');
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [existingInput, card]);

  // Poll for opponent joining after Create
  const startPolling = (sid: number, myAddr: string) => {
    setWaitingForOpponent(true);
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const game = await svc.getGame(sid);
        if (game) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setWaitingForOpponent(false);
          onStandingsRefresh?.();
          onGameReady(sid, myAddr, 1, getDevWalletNum(myAddr), false);  // ← added false
        }
      } catch { /* game not confirmed yet */ }
    }, 3000);

    // Stop after 10 minutes
    setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setWaitingForOpponent(false);
        setError('Timed out waiting for opponent. Share the URL again.');
      }
    }, 600_000);
  };

  // ════════════════════════════════════════════════════════════════════════
  // CREATE — creator always becomes Player 1 in the contract
  // ════════════════════════════════════════════════════════════════════════
  const handleCreate = async () => {
    if (!currentAddress) { setError('No wallet connected. Use the header switcher.'); return; }
    const pts = parsePoints(createPoints);
    if (!pts || pts <= 0n) { setError('Enter a valid wager amount.'); return; }

    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const signer      = getContractSigner();
      const myAddress   = currentAddress;
      const sid         = createRandomSessionId();
      const placeholder = await getFundedSimulationSourceAddress([myAddress]);

      const authXDR = await svc.prepareStartGame(sid, myAddress, placeholder, pts, pts, signer);

      setCreatedAuthXDR(authXDR);
      setSuccess('Game prepared! Share the URL with your opponent.');
      startPolling(sid, myAddress);
    } catch (err: any) {
      setError(err.message || 'Failed to prepare game.');
    } finally {
      setLoading(false);
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // JOIN / LOAD — joiner always becomes Player 2 when joining via XDR
  // ════════════════════════════════════════════════════════════════════════
  const handleJoinOrLoad = async () => {
    if (!existingParsed) return;
    if (!currentAddress) { setError('No wallet connected. Use the header switcher.'); return; }

    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const { sessionId, player1, isXDR } = existingParsed;
      const cleanXDR  = existingCleanedRaw || extractRaw(existingInput);
      const myAddress = currentAddress;

      // Load existing game by session ID
      if (!isXDR) {
        const game = await svc.getGame(sessionId);
        if (!game) throw new Error('Game not found on-chain.');
        if (game.player1 !== myAddress && game.player2 !== myAddress) {
          throw new Error(
            `Wallet ${myAddress.slice(0, 8)}… is not in this game.\n` +
            `Player 1: ${game.player1.slice(0, 8)}…\n` +
            `Player 2: ${game.player2.slice(0, 8)}…\n` +
            `Switch to the correct wallet using the header switcher.`
          );
        }
        const playerNum: 1 | 2 = game.player1 === myAddress ? 1 : 2;
        onStandingsRefresh?.();
        onGameReady(sessionId, myAddress, playerNum, getDevWalletNum(myAddress), false);  // ← added false
        return;
      }

      // Join via auth entry — joiner is always Player 2
      if (myAddress === player1) {
        throw new Error(
          'This auth entry was created by your wallet. ' +
          'Switch to your other wallet (Player 2) using the header switcher.'
        );
      }

      const pts = parsePoints(existingPoints);
      if (!pts || pts <= 0n) throw new Error('Enter your wager amount.');

      const signer = getContractSigner();
      setSuccess('Finalizing transaction...');

      const signedXDR = await svc.importAndSignAuthEntry(cleanXDR, myAddress, pts, signer);
      await svc.finalizeStartGame(signedXDR, myAddress, signer);

      // Wait for on-chain confirmation
      let game = null;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 2000));
        game = await svc.getGame(sessionId).catch(() => null);
        if (game) break;
      }
      if (!game) throw new Error('Submitted but game not visible yet. Try loading by Session ID in a moment.');

      onStandingsRefresh?.();
      onGameReady(sessionId, myAddress, 2, getDevWalletNum(myAddress), false);  // ← added false
    } catch (err: any) {
      setError(err.message || 'Failed to join game.');
    } finally {
      setLoading(false);
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // QUICKSTART — both dev wallets, enters as Player 1
  // ════════════════════════════════════════════════════════════════════════
  const handleQuickstart = async () => {
    const pts = parsePoints(qsPoints);
    if (!pts || pts <= 0n) { setError('Enter a valid wager amount.'); return; }

    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const original = devWalletService.getCurrentPlayer();

      await devWalletService.initPlayer(1);
      const p1Addr   = devWalletService.getPublicKey();
      const p1Signer = devWalletService.getSigner();

      await devWalletService.initPlayer(2);
      const p2Addr   = devWalletService.getPublicKey();
      const p2Signer = devWalletService.getSigner();

      if (original) await devWalletService.initPlayer(original);

      const sid         = createRandomSessionId();
      const placeholder = await getFundedSimulationSourceAddress([p1Addr, p2Addr]);

      setSuccess('Creating game on-chain...');
      const authXDR   = await svc.prepareStartGame(sid, p1Addr, placeholder, pts, pts, p1Signer);
      const signedXDR = await svc.importAndSignAuthEntry(authXDR, p2Addr, pts, p2Signer);
      await svc.finalizeStartGame(signedXDR, p2Addr, p2Signer);

      let game = null;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 2000));
        game = await svc.getGame(sid).catch(() => null);
        if (game) break;
      }
      if (!game) throw new Error('Game not confirmed after quickstart. Try again.');

      onStandingsRefresh?.();
      onGameReady(sid, p1Addr, 1, 1, true);  // ← quickStart = true
    } catch (err: any) {
      setError(err.message || 'Quickstart failed.');
    } finally {
      setLoading(false);
    }
  };

  const copyShareURL = async () => {
    if (!createdAuthXDR) return;
    const params = new URLSearchParams({ auth: createdAuthXDR });
    const url = `${window.location.origin}${window.location.pathname}?${params}`;
    await navigator.clipboard.writeText(url);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 2000);
  };

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="lobby">

      {/* Card selector */}
      <div className="lobby__cards">
        <button
          className={`lobby__card ${card === 'create' ? 'lobby__card--active' : ''}`}
          onClick={() => { setCard('create'); setError(null); setSuccess(null); }}
        >
          <span className="lobby__card-icon">⚔️</span>
          <span className="lobby__card-title">Create Game</span>
          <span className="lobby__card-hint">You will be Player 1</span>
        </button>

        <button
          className={`lobby__card ${card === 'existing' ? 'lobby__card--active' : ''}`}
          onClick={() => { setCard('existing'); setError(null); setSuccess(null); }}
        >
          <span className="lobby__card-icon">🔗</span>
          <span className="lobby__card-title">Join / Load</span>
          <span className="lobby__card-hint">Paste link or Session ID</span>
        </button>

        <button
          className={`lobby__card ${card === 'quickstart' ? 'lobby__card--active' : ''} ${!quickstartAvailable ? 'lobby__card--disabled' : ''}`}
          onClick={() => quickstartAvailable && setCard('quickstart')}
          title={!quickstartAvailable ? 'Dev wallets not configured' : ''}
        >
          <span className="lobby__card-icon">⚡</span>
          <span className="lobby__card-title">Quickstart</span>
          <span className="lobby__card-hint">One-click dev test</span>
        </button>
      </div>

      {error   && <div className="lobby__msg lobby__msg--error" style={{ whiteSpace: 'pre-line' }}>{error}</div>}
      {success && <div className="lobby__msg lobby__msg--success">{success}</div>}
      {waitingForOpponent && (
        <div className="lobby__msg lobby__msg--info">
          ⏳ Waiting for opponent to join... this page advances automatically.
        </div>
      )}

      {/* CREATE — before preparing */}
      {card === 'create' && !createdAuthXDR && (
        <div className="lobby__panel">
          <p className="lobby__panel-title">Create Game</p>
          <p className="lobby__hint">
            You will be <strong>Player 1</strong>.
            The wallet shown in the header is your address.
            Your opponent joins as Player 2 via the share URL.
          </p>
          <label className="lobby__label">
            Wager (Points)
            <input
              className="lobby__input"
              type="text"
              value={createPoints}
              onChange={e => setCreatePoints(e.target.value)}
              placeholder="0.1"
            />
          </label>
          <button
            className="lobby__action-btn"
            onClick={handleCreate}
            disabled={loading || !currentAddress}
          >
            {loading ? 'Preparing...' : 'Create & Export Auth'}
          </button>
        </div>
      )}

      {/* CREATE — after preparing, show share button */}
      {card === 'create' && createdAuthXDR && (
        <div className="lobby__panel">
          <p className="lobby__panel-title">Share with Opponent</p>
          <p className="lobby__hint">
            Send this URL to your opponent. They paste it in <strong>Join / Load</strong>
            and join as Player 2. This page advances automatically when they join.
          </p>
          <button className="lobby__action-btn" onClick={copyShareURL}>
            {urlCopied ? '✓ URL Copied!' : '🔗 Copy Share URL'}
          </button>
          <button
            className="lobby__ghost-btn"
            onClick={() => {
              setCreatedAuthXDR(null);
              setWaitingForOpponent(false);
              setSuccess(null);
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            }}
          >
            ← Start Over
          </button>
        </div>
      )}

      {/* JOIN / LOAD */}
      {card === 'existing' && (
        <div className="lobby__panel">
          <p className="lobby__panel-title">Join or Load Game</p>

          <div className={existingParsed ? 'lobby__split-layout' : ''}>
            <div className="lobby__column-main">
              <label className="lobby__label">
                Share URL, Auth Entry XDR, or Session ID
                {existingParseStatus === 'parsing' && (
                  <span className="lobby__parse-badge lobby__parse-badge--loading"> Checking...</span>
                )}
                {existingParseStatus === 'ok-xdr' && (
                  <span className="lobby__parse-badge lobby__parse-badge--ok"> ✓ Auth valid</span>
                )}
                {existingParseStatus === 'ok-sid' && (
                  <span className="lobby__parse-badge lobby__parse-badge--ok"> ✓ Game found</span>
                )}
                {existingParseStatus === 'error' && (
                  <span className="lobby__parse-badge lobby__parse-badge--error"> ✗ {existingParseError}</span>
                )}
                <textarea
                  className={`lobby__textarea
                    ${existingParseStatus === 'error'  ? 'lobby__textarea--error' : ''}
                    ${existingParseStatus === 'ok-xdr' || existingParseStatus === 'ok-sid' ? 'lobby__textarea--ok' : ''}
                  `}
                  rows={existingParsed ? 3 : 4}
                  value={existingInput}
                  onChange={e => setExistingInput(e.target.value)}
                  placeholder="Paste share URL, auth entry XDR, or type a Session ID..."
                />
              </label>

              {existingParsed && (
                <div className="lobby__parsed-info">
                  <div className="lobby__parsed-row">
                    <span className="lobby__parsed-label">Session ID</span>
                    <span className="lobby__parsed-value">{existingParsed.sessionId}</span>
                  </div>
                  {existingParsed.isXDR && (
                    <>
                      <div className="lobby__parsed-row">
                        <span className="lobby__parsed-label">Player 1</span>
                        <span className="lobby__parsed-value lobby__parsed-value--mono">
                          {existingParsed.player1.slice(0, 8)}…{existingParsed.player1.slice(-4)}
                        </span>
                      </div>
                      <div className="lobby__parsed-row">
                        <span className="lobby__parsed-label">Their Wager</span>
                        <span className="lobby__parsed-value">{existingParsed.player1Points} pts</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {existingParsed && (
              <div className="lobby__column-side">
                <p className="lobby__hint" style={{ fontSize: '0.8rem', marginBottom: '0.5rem', textAlign: 'left' }}>
                  {existingParseStatus === 'ok-xdr' ? 'Join as Player 2:' : 'Load with current wallet:'}
                </p>

                <div className="lobby__parsed-row" style={{ marginBottom: '0.5rem' }}>
                  <span className="lobby__parsed-label">Your wallet</span>
                  <span className="lobby__parsed-value lobby__parsed-value--mono">
                    {currentAddress
                      ? `${currentAddress.slice(0, 8)}…${currentAddress.slice(-4)}`
                      : 'Not connected'}
                  </span>
                </div>

                {existingParseStatus === 'ok-xdr' && (
                  <label className="lobby__label">
                    Your Wager (Points)
                    <input
                      className="lobby__input"
                      type="text"
                      value={existingPoints}
                      onChange={e => setExistingPoints(e.target.value)}
                      placeholder="0.1"
                    />
                  </label>
                )}

                <button
                  className="lobby__action-btn"
                  onClick={handleJoinOrLoad}
                  disabled={
                    loading ||
                    !currentAddress ||
                    existingParseStatus === 'idle' ||
                    existingParseStatus === 'parsing' ||
                    existingParseStatus === 'error'
                  }
                >
                  {loading
                    ? '...'
                    : existingParseStatus === 'ok-sid'
                    ? 'Load Game'
                    : 'Join & Pay'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* QUICKSTART */}
      {card === 'quickstart' && (
        <div className="lobby__panel">
          <p className="lobby__panel-title">⚡ Quickstart</p>
          <p className="lobby__hint">
            Creates a full game using both dev wallets instantly.
            Enters as Dev Wallet 1 (Player 1 in contract).
          </p>
          <label className="lobby__label">
            Wager (each player)
            <input
              className="lobby__input"
              type="text"
              value={qsPoints}
              onChange={e => setQsPoints(e.target.value)}
              placeholder="0.1"
            />
          </label>
          <button
            className="lobby__action-btn lobby__action-btn--quickstart"
            onClick={handleQuickstart}
            disabled={loading || !quickstartAvailable}
          >
            {loading ? 'Creating...' : '⚡ Start Quick Game'}
          </button>
          {!quickstartAvailable && (
            <p className="lobby__hint lobby__hint--warn">
              Dev wallets not found. Run <code>bun run setup</code> first.
            </p>
          )}
        </div>
      )}
    </div>
  );
}