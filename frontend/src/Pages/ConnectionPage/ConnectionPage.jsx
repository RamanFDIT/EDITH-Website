import Logo from '../../assets/EDITH.svg?react';
import Button from '../../components/Button/Button.jsx';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Github, Calendar, MessageSquare, CheckCircle2, Plug, Wifi, AlertCircle } from 'lucide-react';
import { oauthConnect, oauthStatus } from '../../services/api.js';
import styles from './ConnectionPage.module.css';

const cardInfo = [
    { id: 1, cardHead: 'Google', oauth: 'google', description: 'Calendar, Gmail & Vertex AI', icon: Calendar },
    { id: 2, cardHead: 'GitHub', oauth: 'github', description: 'Repos, PRs, commits, issues', icon: Github },
    { id: 3, cardHead: 'Jira', oauth: 'jira', description: 'Tickets, epics, sprints, projects', icon: CheckCircle2 },
    { id: 4, cardHead: 'Slack', oauth: 'slack', description: 'Send messages, post announcements', icon: MessageSquare },
];

const ConnectionPage = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const selectedTools = location.state?.selectedTools || [];
    const [connectionStatus, setConnectionStatus] = useState({});

    const toolsToShow = cardInfo.filter(card =>
        card.cardHead === 'Google' || selectedTools.includes(card.cardHead)
    );

    // Check for OAuth callback results and load current status
    useEffect(() => {
        const success = searchParams.get('oauth_success');
        if (success) {
            setConnectionStatus(prev => ({ ...prev, [success]: 'connected' }));
        }

        // Load current OAuth status
        oauthStatus().then(status => {
            const updated = {};
            for (const [provider, info] of Object.entries(status)) {
                if (info.connected) updated[provider] = 'connected';
            }
            setConnectionStatus(prev => ({ ...prev, ...updated }));
        }).catch(() => {});
    }, [searchParams]);

    const handleConnection = async (providerKey) => {
        if (!providerKey) return;

        setConnectionStatus(prev => ({ ...prev, [providerKey]: 'connecting' }));

        try {
            await oauthConnect(providerKey);
            // oauthConnect redirects the browser, so we won't reach here
        } catch (err) {
            console.error(`OAuth error for "${providerKey}":`, err);
            setConnectionStatus(prev => ({ ...prev, [providerKey]: 'failed' }));
        }
    };

    const allConnected = toolsToShow.every(card => connectionStatus[card.oauth] === 'connected');

    return (
        <section className={styles.mainSection}>
            <div className={styles.container}>
                <Logo className={styles.logo} />
                <h1 className={styles.header}>Connections</h1>
                <p className={styles.subheading}>Connect your tools to get started</p>

                <h2 className={styles.sectionTitle}>
                    <Plug size={20} className={styles.sectionIcon} />
                    Integrations
                </h2>

                <div className={styles.cardGrid}>
                    {toolsToShow.map(({ id, cardHead, oauth, description, icon }) => {
                        const ProviderIcon = icon;
                        const status = connectionStatus[oauth] || 'idle';

                        const cardClass =
                            status === 'connected' ? styles.oauthCardConnected :
                            status === 'failed' ? styles.oauthCardFailed :
                            styles.oauthCard;

                        const iconClass =
                            status === 'connected' ? styles.cardIconConnected :
                            status === 'failed' ? styles.cardIconFailed :
                            styles.cardIcon;

                        return (
                            <div key={id} className={cardClass}>
                                <div className={styles.cardInfo}>
                                    <ProviderIcon size={24} className={iconClass} />
                                    <div>
                                        <p className={styles.cardLabel}>{cardHead}</p>
                                        <p className={styles.cardDescription}>{description}</p>
                                    </div>
                                </div>
                                <div className={styles.cardActions}>
                                    {status === 'connected' && (
                                        <span className={styles.connectedBadge}>
                                            <Wifi size={12} /> Connected
                                        </span>
                                    )}
                                    {status === 'failed' && (
                                        <span className={styles.failedBadge}>
                                            <AlertCircle size={12} /> Failed
                                        </span>
                                    )}
                                    {status === 'connected' ? (
                                        <button className={styles.connectedButton}>
                                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                                <Wifi size={14} /> Connected
                                            </span>
                                        </button>
                                    ) : status === 'failed' ? (
                                        <button onClick={() => handleConnection(oauth)} className={styles.failedButton}>
                                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                                <AlertCircle size={14} /> Retry
                                            </span>
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => handleConnection(oauth)}
                                            disabled={status === 'connecting'}
                                            className={styles.connectButton}
                                        >
                                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                                <Plug size={14} /> {status === 'connecting' ? 'Connecting...' : 'Connect'}
                                            </span>
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className={styles.nextButton}>
                    <Button disabled={!allConnected} onClick={() => navigate('/home')} label="Next" />
                </div>
            </div>
        </section>
    );
};

export default ConnectionPage;
