import React from 'react';
import type { AuthStatus } from '../types/index.js';

interface LayoutProps { children: React.ReactNode; authStatus: AuthStatus | null; }

export default function Layout({ children, authStatus }: LayoutProps) {
  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-content">
          <div className="header-brand">
            <div className="brand-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
              </svg>
            </div>
            <div>
              <h1>Smartsheet → Calendar Sync</h1>
              <p className="header-subtitle">One-way synchronization engine</p>
            </div>
          </div>
          <div className="header-status">
            {authStatus?.authenticated && (
              <>
                <span className="status-badge" data-active={authStatus.google}>
                  <span className="status-dot" />Google
                </span>
                <span className="status-badge" data-active={authStatus.smartsheet}>
                  <span className="status-dot" />Smartsheet
                </span>
                {authStatus.user?.email && <span className="user-email">{authStatus.user.email}</span>}
              </>
            )}
          </div>
        </div>
      </header>
      <main className="app-main">
        <div className="main-container">{children}</div>
      </main>
    </div>
  );
}
