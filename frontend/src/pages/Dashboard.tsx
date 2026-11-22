import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';
import Layout from '../components/Layout.js';
import ConnectionCard from '../components/ConnectionCard.js';
import ConnectionsManager from '../components/ConnectionsManager.js';
import NewConnectionModal from '../components/NewConnectionModal.js';
import ConnectionDetailModal from '../components/ConnectionDetailModal.js';
import LogViewer from '../components/LogViewer.js';
import type { AuthStatus, SyncConfig } from '../types/index.js';

export default function Dashboard() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [configs, setConfigs] = useState<SyncConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'connections' | 'logs'>('connections');

  // Modals state
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [selectedConfigForModal, setSelectedConfigForModal] = useState<SyncConfig | null>(null);
  const [logsInitialConfigId, setLogsInitialConfigId] = useState<string>('');

  const loadData = useCallback(async () => {
    try {
      const [auth, configsData] = await Promise.all([
        api.getAuthStatus(),
        api.getSyncConfigs().catch(() => ({ configs: [] })),
      ]);
      setAuthStatus(auth);
      setConfigs(configsData.configs || []);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('auth') || p.get('error')) {
      window.history.replaceState({}, '', '/');
      loadData();
    }
  }, [loadData]);

  const handleConnectionCreated = (newConfig: SyncConfig) => {
    setConfigs((prev) => [newConfig, ...prev]);
    loadData();
  };

  const handleConnectionUpdated = (updatedConfig: SyncConfig) => {
    setConfigs((prev) =>
      prev.map((c) => (c.id === updatedConfig.id ? { ...c, ...updatedConfig } : c))
    );
    if (selectedConfigForModal?.id === updatedConfig.id) {
      setSelectedConfigForModal((prev) => (prev ? { ...prev, ...updatedConfig } : null));
    }
  };

  const handleConnectionDeleted = (deletedId: string) => {
    setConfigs((prev) => prev.filter((c) => c.id !== deletedId));
    if (selectedConfigForModal?.id === deletedId) {
      setSelectedConfigForModal(null);
    }
  };

  const handleViewLogsForProject = (configId: string) => {
    setLogsInitialConfigId(configId);
    setActiveTab('logs');
  };

  if (loading) {
    return (
      <Layout authStatus={null}>
        <div className="loading-screen">
          <div className="spinner spinner-lg" />
          <p>Loading your project connections & sync engines…</p>
        </div>
      </Layout>
    );
  }

  const bothConnected = authStatus?.google && authStatus?.smartsheet;
  const activeCount = configs.filter((c) => c.isEnabled).length;

  return (
    <Layout authStatus={authStatus}>
      {/* ── Section 1: Account Connections ───────────────────── */}
      <section className="dashboard-section">
        <div className="section-header-row">
          <h2 className="section-title">
            <span className="section-number">1</span>Connected Accounts & Authorizations
          </h2>
          {bothConnected && (
            <span className="badge-connected-all">
              ✓ Both Google Calendar & Smartsheet Connected
            </span>
          )}
        </div>
        <div className="connections-grid">
          <ConnectionCard
            provider="google"
            connected={authStatus?.google || false}
            label="Google Calendar"
            description="Manage and synchronize project events to target calendars"
            expiry={authStatus?.googleExpiry}
            onDisconnected={loadData}
          />
          <ConnectionCard
            provider="smartsheet"
            connected={authStatus?.smartsheet || false}
            label="Smartsheet"
            description="Access sheets, extract schedules, and receive live webhooks"
            expiry={authStatus?.smartsheetExpiry}
            onDisconnected={loadData}
          />
        </div>
      </section>

      {/* ── Section 2: Multi-Project & Activity Hub ───────────── */}
      {bothConnected ? (
        <section className="dashboard-section">
          {/* Main Hub Tabs */}
          <div className="hub-tabs-container">
            <div className="hub-tabs">
              <button
                className={`hub-tab-btn ${activeTab === 'connections' ? 'active' : ''}`}
                onClick={() => setActiveTab('connections')}
              >
                <span>🔗 Project Connections</span>
                <span className="hub-tab-count">{configs.length}</span>
                {activeCount > 0 && <span className="hub-tab-dot" title={`${activeCount} active`} />}
              </button>
              <button
                className={`hub-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
                onClick={() => {
                  setLogsInitialConfigId('');
                  setActiveTab('logs');
                }}
              >
                <span>📜 System & Sync Logs</span>
                <span className="live-indicator-pill">Live Feed</span>
              </button>
            </div>

            <div className="hub-tab-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setIsNewModalOpen(true)}
              >
                ➕ Link New Project
              </button>
            </div>
          </div>

          {/* ── Tab Content: Connections Manager ────────────── */}
          {activeTab === 'connections' && (
            <ConnectionsManager
              configs={configs}
              onOpenNewModal={() => setIsNewModalOpen(true)}
              onSelectConfig={(config) => setSelectedConfigForModal(config)}
              onRefresh={loadData}
              onViewLogs={handleViewLogsForProject}
              onUpdated={handleConnectionUpdated}
              onDeleted={handleConnectionDeleted}
            />
          )}

          {/* ── Tab Content: Live Logs & Monitor ────────────── */}
          {activeTab === 'logs' && (
            <div className="logs-tab-wrapper">
              <div className="logs-tab-header">
                <div>
                  <h3 className="section-subtitle">Real-Time Sync Logs & System Events</h3>
                  <p className="section-subtext">
                    Monitor live Smartsheet webhooks, reconciliation runs, and event updates.
                  </p>
                </div>
              </div>
              <LogViewer configs={configs} initialConfigId={logsInitialConfigId} />
            </div>
          )}
        </section>
      ) : (
        <div className="auth-required-box">
          <div className="auth-required-icon">🔒</div>
          <h3>Connect Both Accounts to Manage Project Syncs</h3>
          <p>
            Please authorize both your <strong>Google Calendar</strong> and <strong>Smartsheet</strong>{' '}
            accounts in Step 1 above to begin linking projects and monitoring live sync activity.
          </p>
        </div>
      )}

      {/* ── Modals ───────────────────────────────────────────── */}
      <NewConnectionModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        onCreated={handleConnectionCreated}
      />

      <ConnectionDetailModal
        config={selectedConfigForModal}
        isOpen={Boolean(selectedConfigForModal)}
        onClose={() => setSelectedConfigForModal(null)}
        onUpdated={handleConnectionUpdated}
        onDeleted={handleConnectionDeleted}
      />
    </Layout>
  );
}
