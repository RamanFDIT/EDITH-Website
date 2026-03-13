import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import Logo from '../../assets/EDITH.svg?react';
import styles from './Login.module.css';

const Login = () => {
  const { signInWithGoogle } = useAuth();
  const navigate = useNavigate();

  const handleGoogleSignIn = async () => {
    try {
      await signInWithGoogle();
      navigate('/onboarding');
    } catch (err) {
      console.error('Sign-in failed:', err);
    }
  };

  return (
    <section className={styles.mainSection}>
      <div className={styles.container}>
        <Logo className={styles.logo} />
        <h1 className={styles.header}>Welcome to E.D.I.T.H.</h1>
        <p className={styles.subheading}>Sign in to get started</p>
        <button onClick={handleGoogleSignIn} className={styles.googleButton}>
          Sign in with Google
        </button>
      </div>
    </section>
  );
};

export default Login;
