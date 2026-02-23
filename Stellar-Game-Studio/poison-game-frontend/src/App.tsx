import { useState } from 'react';
import { config } from './config';
import { Layout } from './components/Layout';
import { useWallet } from './hooks/useWallet';
import { PoisonGameGame } from './games/poison-game/PoisonGameGame';

const GAME_ID = 'poison-game';
const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'Poison Game';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'On-chain game on Stellar';

export default function App() {
  const { publicKey, isConnected, isConnecting, error, isDevModeAvailable } = useWallet();
  
  /**
   * This state now controls the visibility of the switcher.
   * It starts as 'true' so you can see it in the lobby.
   */
  const [showSwitcher, setShowSwitcher] = useState(true); 

  const userAddress = publicKey ?? '';
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';
  const devReady = isDevModeAvailable();

  return (
    <Layout 
      title={GAME_TITLE} 
      subtitle={GAME_TAGLINE} 
      // The switcher shows only if dev wallets exist AND the game logic allows it
      showWalletSwitcher={devReady && showSwitcher} 
    >
      {!hasContract ? (
        <div className="card">
          <h3 className="gradient-text">Contract Not Configured</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '1rem' }}>
            Run <code>bun run setup</code> to deploy and configure testnet contract IDs, or set
            <code>VITE_POISON_GAME_CONTRACT_ID</code> in the root <code>.env</code>.
          </p>
        </div>
      ) : !devReady ? (
        <div className="card">
          <h3 className="gradient-text">Dev Wallets Missing</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem' }}>
            Run <code>bun run setup</code> to generate dev wallets for Player 1 and Player 2.
          </p>
        </div>
      ) : !isConnected ? (
        <div className="card">
          <h3 className="gradient-text">Connecting Dev Wallet</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem' }}>
            The dev wallet switcher auto-connects Player 1. Use the switcher to toggle players.
          </p>
          {error && <div className="notice error" style={{ marginTop: '1rem' }}>{error}</div>}
          {isConnecting && <div className="notice info" style={{ marginTop: '1rem' }}>Connecting...</div>}
        </div>
      ) : (
        <PoisonGameGame
          userAddress={userAddress}
          currentEpoch={1}
          availablePoints={1000000000n}
          onStandingsRefresh={() => {}}
          onGameComplete={() => {}}
          /**
           * PoisonGameGame will call this with:
           * - true: when in the lobby
           * - true: when in a 'Quick Start' game (for testing)
           * - false: when in a real 'Player vs Player' game (with your brother)
           */
          onGameModeChange={setShowSwitcher} 
        />
      )}
    </Layout>
  );
}
