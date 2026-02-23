import './Layout.css';
import { WalletSwitcher } from './WalletSwitcher';

interface LayoutProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  showWalletSwitcher?: boolean;
}

export function Layout({ title, subtitle, children, showWalletSwitcher }: LayoutProps) {
  const resolvedTitle = title || import.meta.env.VITE_GAME_TITLE || 'POISON GAME';
  const resolvedSubtitle = subtitle || import.meta.env.VITE_GAME_TAGLINE || 'Hide your poison. Survive the night.';

  return (
    <div className="studio">
      <div className="studio-background" aria-hidden="true">
        <div className="studio-orb orb-1" />
        <div className="studio-orb orb-2" />
        <div className="studio-orb orb-3" />
        <div className="studio-grid" />
      </div>

      <header className="studio-header">
        <div className="brand">
          <div className="brand-title">{resolvedTitle}</div>
          <p className="brand-subtitle">{resolvedSubtitle}</p>
        </div>
        {showWalletSwitcher && (
          <div className="header-actions">
            <WalletSwitcher />
          </div>
        )}
      </header>

      <main className="studio-main">{children}</main>
    </div>
  );
}