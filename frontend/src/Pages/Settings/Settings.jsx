import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Github, Figma, Calendar, MessageSquare, CheckCircle2, Plug, Unplug, Wifi } from 'lucide-react';
import { oauthConnect, oauthDisconnect, oauthStatus } from '../../services/api.js';
import styles from './Settings.module.css';
import { useNavBar } from '../../components/NavBar/NavBarContext.jsx';

const providers = [
  { key: 'google', label: 'Google', description: 'Calendar, Gmail & Vertex AI', icon: Calendar, },
  { key: 'github', label: 'GitHub', description: 'Repos, PRs, commits, issues', icon: Github },
  { key: 'slack', label: 'Slack', description: 'Send messages, post announcements', icon: MessageSquare },
  { key: 'figma', label: 'Figma', description: 'Read designs, post comments', icon: Figma },
  { key: 'jira', label: 'Jira', description: 'Tickets, epics, sprints, projects', icon: CheckCircle2 },
];

const Settings = () => {
  const { expanded } = useNavBar();
  const [searchParams] = useSearchParams();
  const [oauthStatusState, setOauthStatusState] = useState({
    google: { connected: false },
    github: { connected: false },
    slack: { connected: false },
    figma: { connected: false },
    jira: { connected: false },
  });

  const [status, setStatus] = useState({ type: '', message: '' });
  const [connecting, setConnecting] = useState('');

  useEffect(() => {
    // Check for OAuth callback results
    const success = searchParams.get('oauth_success');
    const error = searchParams.get('oauth_error');
    if (success) {
      setStatus({ type: 'success', message: `Connected to ${success}!` });
      setTimeout(() => setStatus({ type: '', message: '' }), 5000);
    } else if (error) {
      setStatus({ type: 'error', message: `OAuth error: ${error}` });
      setTimeout(() => setStatus({ type: '', message: '' }), 5000);
    }

    // Load current status
    oauthStatus().then(setOauthStatusState).catch(() => {});
  }, [searchParams]);

  const handleConnect = async (provider) => {
    setConnecting(provider);
    try {
      await oauthConnect(provider);
      // oauthConnect redirects the browser
    } catch (err) {
      setStatus({ type: 'error', message: `OAuth error: ${err.message}` });
      setConnecting('');
      setTimeout(() => setStatus({ type: '', message: '' }), 5000);
    }
  };

  const handleDisconnect = async (provider) => {
    try {
      await oauthDisconnect(provider);
      setOauthStatusState(prev => ({
        ...prev,
        [provider]: { connected: false, expired: true, hasRefreshToken: false },
      }));
      setStatus({ type: 'info', message: `Disconnected from ${provider}.` });
      setTimeout(() => setStatus({ type: '', message: '' }), 3000);
    } catch (err) {
      setStatus({ type: 'error', message: `Error disconnecting: ${err.message}` });
      setTimeout(() => setStatus({ type: '', message: '' }), 5000);
    }
  };

  return (
    <section className={styles.mainSection}>
      <div className={expanded ? styles.container : styles.containerCompact}>
        <h1 className={styles.header}>Settings</h1>
        <p className={styles.subheading}>Manage your connected integrations</p>

        {status.message && (
          <div className={`${styles.statusBar} ${
            status.type === 'success' ? styles.statusSuccess :
            status.type === 'error' ? styles.statusError : styles.statusInfo
          }`}>
            {status.type === 'success' && <CheckCircle2 size={16} />}
            {status.message}
          </div>
        )}

        <h2 className={styles.sectionTitle}>
          <Plug size={20} className={styles.sectionIcon} />
          Integrations
        </h2>

        <div className={styles.cardGrid}>
          {providers.map(({ key, label, description, icon: Icon }) => {
            const isConnected = oauthStatusState[key]?.connected;
            const isConnecting = connecting === key;

            return (
              <div key={key} className={isConnected ? styles.oauthCardConnected : styles.oauthCard}>
                <div className={styles.cardInfo}>
                  <Icon size={24} className={isConnected ? styles.cardIconConnected : styles.cardIcon} />
                  <div>
                    <p className={styles.cardLabel}>{label}</p>
                    <p className={styles.cardDescription}>{description}</p>
                  </div>
                </div>
                <div className={styles.cardActions}>
                  {isConnected && (
                    <span className={styles.connectedBadge}>
                      <Wifi size={12} /> Connected
                    </span>
                  )}
                  {isConnected ? (
                    <button onClick={() => handleDisconnect(key)} className={styles.disconnectButton}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <Unplug size={14} /> Disconnect
                      </span>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(key)}
                      disabled={isConnecting}
                      className={styles.connectButton}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <Plug size={14} /> {isConnecting ? 'Connecting...' : 'Connect'}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default Settings;
