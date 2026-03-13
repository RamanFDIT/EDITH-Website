import { NavLink, useNavigate } from 'react-router-dom';
import styles from "./NavBar.module.css";
import Logo from '../../assets/EDITH.svg?react';
import settings from '../../assets/settings.svg';
import hamburger from '../../assets/hamburger.svg';
import profile from '../../assets/profile.svg';
import { useState, useEffect } from 'react';
import { Github, Figma, Calendar, MessageSquare, Plus, LogOut } from 'lucide-react';
import { useNavBar } from './NavBarContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { oauthStatus, oauthLogout } from '../../services/api.js';

const toolDisplayNames = {
  google: 'Google',
  github: 'GitHub',
  slack: 'Slack',
  figma: 'Figma',
  jira: 'Jira',
};

const toolIcons = {
  google: Calendar,
  github: Github,
  slack: MessageSquare,
  figma: Figma,
  jira: Plus,
};

const NavBar = () => {
  const { expanded: toggle, setExpanded } = useNavBar();
  const [connectedTools, setConnectedTools] = useState([]);
  const navigate = useNavigate();
  const { logout } = useAuth();

  const handleClick = () => {
    setExpanded(!toggle);
  };

  useEffect(() => {
    oauthStatus().then((status) => {
      const active = Object.entries(status)
        .filter(([, info]) => info.connected)
        .map(([provider]) => provider);
      setConnectedTools(active);
    }).catch(() => {});
  }, []);

  return (
    <nav className={toggle ? styles.navBar : styles.navBarCompact}>
      <div className = {toggle ? styles.logoContainer : styles.logoContainerCompact}>
        <Logo className = {toggle ? styles.logo : styles.displayNone} alt = "EDITH Logo">
        </Logo>
        <img onClick = {handleClick} src = {hamburger} className = {styles.hamburger} alt = "arrow"></img>
      </div>
      <div className = {styles.activeToolContainer}>
        <div className= {toggle ? styles.toolsContainer : styles.toolsContainerCompact}>
          {connectedTools.map((provider) => {
            const Icon = toolIcons[provider];
            return (
              <div key={provider} className={styles.tools}>
                <div className={styles.activeTools}></div>
                {Icon && <Icon size={18} className={styles.toolIcon} />}
                <p className={toggle ? styles.toolName : styles.displayNone}>
                  {toolDisplayNames[provider]}
                </p>
              </div>
            );
          })}
        </div>
        <div className = {styles.settingContainer}>
          <NavLink
          className = {toggle ? styles.profile : styles.profileCompact}
          to = "/settings">
            <img src = {settings} className = {styles.settings} alt = "settings"></img>
            <p className = {!toggle && styles.displayNone }>Settings</p>
          </NavLink>
          <NavLink 
          to = "/profile"
          className= {toggle ? styles.profile : styles.profileCompact}>
            <img src = {profile} className = {styles.settings} alt = "Profile"></img>
            <p className = {!toggle && styles.displayNone }>Profile</p>
          </NavLink>
          <button
            className={toggle ? styles.logoutButton : styles.logoutButtonCompact}
            onClick={async () => {
              try { await oauthLogout(); } catch (e) { /* ignore */ }
              await logout();
              navigate('/login');
            }}
          >
            <LogOut size={20} className={styles.logoutIcon} />
            <p className={!toggle ? styles.displayNone : undefined}>Log Out</p>
          </button>
       </div>
      </div>
    </nav>
  );
};

export default NavBar;