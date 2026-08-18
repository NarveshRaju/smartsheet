import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';
import Layout from '../components/Layout.js';
import ConnectionCard from '../components/ConnectionCard.js';
import SheetSelector from '../components/SheetSelector.js';
import CalendarSelector from '../components/CalendarSelector.js';
import ColumnMapping from '../components/ColumnMapping.js';
import SyncControls from '../components/SyncControls.js';
import SyncStats from '../components/SyncStats.js';
import ErrorList from '../components/ErrorList.js';
import type { AuthStatus, SyncConfig, SyncStatus, ColumnMapping as CMType, Sheet, Calendar } from '../types/index.js';

export default function Dashboard() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [selectedSheetId, setSelectedSheetId] = useState('');
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [selectedCalendarId, setSelectedCalendarId] = useState('');
  const [selectedCalendarName, setSelectedCalendarName] = useState('');
  const [columnMapping, setColumnMapping] = useState<CMType>({});

  const loadData = useCallback(async () => {
    try {
      const [auth, config, status] = await Promise.all([
        api.getAuthStatus(),
        api.getSyncConfig().catch(() => ({ config: null })),
        api.getSyncStatus().catch(() => null),
      ]);
      setAuthStatus(auth);
      setSyncConfig(config.config);
      setSyncStatus(status);
      if (config.config) {
        setSelectedSheetId(config.config.smartsheetSheetId);
        setSelectedSheetName(config.config.sheetName || '');
        setSelectedCalendarId(config.config.googleCalendarId);
        setSelectedCalendarName(config.config.calendarName || '');
        setColumnMapping(config.config.columnMapping);
      }
    } catch (err) { console.error('Failed to load:', err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('auth') || p.get('error')) { window.history.replaceState({}, '', '/'); loadData(); }
  }, [loadData]);

  const handleSave = async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const data = { smartsheetSheetId: selectedSheetId, sheetName: selectedSheetName,
        googleCalendarId: selectedCalendarId, calendarName: selectedCalendarName, columnMapping };
      const { config } = syncConfig ? await api.updateSyncConfig(data) : await api.createSyncConfig(data);
      setSyncConfig(config);
      setSaveMsg('Configuration saved!'); setTimeout(() => setSaveMsg(null), 3000);
    } catch (err: any) { setSaveMsg('Error: ' + err.message); }
    finally { setSaving(false); }
  };

  const handleResetSync = async () => {
    if (!confirm('Are you sure you want to unsync and reset your configuration? This will remove existing sync mappings and allow you to configure a fresh sync between a new sheet and calendar.')) {
      return;
    }
    setSaving(true); setSaveMsg(null);
    try {
      await api.resetSyncConfig();
      setSyncConfig(null);
      setSelectedSheetId('');
      setSelectedSheetName('');
      setSelectedCalendarId('');
      setSelectedCalendarName('');
      setColumnMapping({});
      setSyncStatus(null);
      setSaveMsg('Sync configuration reset successfully. You can now configure a new sync!');
      setTimeout(() => setSaveMsg(null), 4000);
    } catch (err: any) {
      setSaveMsg('Error resetting sync: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (enabled: boolean) => {
    try { const { config } = await api.updateSyncConfig({ isEnabled: enabled }); setSyncConfig(config); }
    catch (err: any) { console.error('Toggle failed:', err); }
  };

  const handleSheetSelect = (s: Sheet) => { setSelectedSheetId(s.id); setSelectedSheetName(s.name); setColumnMapping({}); };
  const handleCalSelect = (c: Calendar) => { setSelectedCalendarId(c.id!); setSelectedCalendarName(c.summary!); };
  const refreshStatus = async () => { try { setSyncStatus(await api.getSyncStatus()); } catch {} };

  if (loading) return (
    <Layout authStatus={null}><div className="loading-screen"><div className="spinner spinner-lg" /><p>Loading dashboard...</p></div></Layout>
  );

  const both = authStatus?.google && authStatus?.smartsheet;
  const hasSheet = Boolean(selectedSheetId);
  const hasCalendar = Boolean(selectedCalendarId);
  const hasTitle = Boolean(columnMapping.title);
  const hasStartDate = Boolean(columnMapping.startDate);
  const canSave = hasSheet && hasCalendar && hasTitle && hasStartDate;

  return (
    <Layout authStatus={authStatus}>
      <section className="dashboard-section">
        <h2 className="section-title"><span className="section-number">1</span>Connect Your Accounts</h2>
        <div className="connections-grid">
          <ConnectionCard
            provider="google"
            connected={authStatus?.google || false}
            label="Google Calendar"
            description="Connect to create and manage calendar events"
            expiry={authStatus?.googleExpiry}
            onDisconnected={loadData}
          />
          <ConnectionCard
            provider="smartsheet"
            connected={authStatus?.smartsheet || false}
            label="Smartsheet"
            description="Connect to read sheets and receive webhooks"
            expiry={authStatus?.smartsheetExpiry}
            onDisconnected={loadData}
          />
        </div>
      </section>

      {both && (
        <section className="dashboard-section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
            <h2 className="section-title" style={{ marginBottom: 0 }}>
              <span className="section-number">2</span>Configure Sync
            </h2>
            {syncConfig && (
              <button
                className="btn btn-outline-danger btn-sm"
                onClick={handleResetSync}
                disabled={saving}
                title="Clear current sync mapping and start fresh with a new sheet/calendar"
              >
                🔄 Unsync & Reset Configuration
              </button>
            )}
          </div>
          <div className="config-grid">
            <SheetSelector selectedSheetId={selectedSheetId} onSelect={handleSheetSelect} />
            <CalendarSelector selectedCalendarId={selectedCalendarId} onSelect={handleCalSelect} />
          </div>
          <ColumnMapping sheetId={selectedSheetId} mapping={columnMapping} onChange={setColumnMapping} />
          <div className="config-actions">
            <button className="btn btn-primary btn-lg" onClick={handleSave} disabled={saving || !canSave}>
              {saving ? 'Saving...' : syncConfig ? 'Update Configuration' : 'Save Configuration'}
            </button>
            {syncConfig && (
              <button
                className="btn btn-ghost btn-lg"
                onClick={handleResetSync}
                disabled={saving}
              >
                Reset & Re-establish New Sync
              </button>
            )}
            {saveMsg && <span className={'save-message ' + (saveMsg.startsWith('Error') ? 'error' : 'success')}>{saveMsg}</span>}
            
            <div className="validation-checklist">
              <span className={'check-badge ' + (hasSheet ? 'valid' : 'invalid')}>
                {hasSheet ? `✓ Sheet: ${selectedSheetName || selectedSheetId}` : '✗ Select a Smartsheet'}
              </span>
              <span className={'check-badge ' + (hasCalendar ? 'valid' : 'invalid')}>
                {hasCalendar ? `✓ Calendar: ${selectedCalendarName || selectedCalendarId}` : '✗ Select a Google Calendar'}
              </span>
              <span className={'check-badge ' + (hasTitle ? 'valid' : 'invalid')}>
                {hasTitle ? '✓ Event Title Mapped' : '✗ Map Event Title Column'}
              </span>
              <span className={'check-badge ' + (hasStartDate ? 'valid' : 'invalid')}>
                {hasStartDate ? '✓ Start Date Mapped' : '✗ Map Start Date Column'}
              </span>
            </div>
          </div>
        </section>
      )}

      {syncConfig && (
        <section className="dashboard-section">
          <h2 className="section-title"><span className="section-number">3</span>Synchronize</h2>
          <SyncControls isEnabled={syncConfig.isEnabled} hasConfig={!!syncConfig} onToggleSync={handleToggle} onSyncComplete={refreshStatus} />
        </section>
      )}

      {syncStatus && (
        <section className="dashboard-section">
          <h2 className="section-title"><span className="section-number">4</span>Sync Status</h2>
          <SyncStats stats={syncStatus.stats} lastFullSyncAt={syncStatus.config?.lastFullSyncAt} />
          <ErrorList records={syncStatus.failedRecords} onRetryComplete={refreshStatus} />
        </section>
      )}
    </Layout>
  );
}
