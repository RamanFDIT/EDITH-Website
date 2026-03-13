import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const OAuthCallback = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const success = searchParams.get('oauth_success');
    const error = searchParams.get('oauth_error');

    if (success) {
      navigate('/settings?oauth_success=' + success, { replace: true });
    } else if (error) {
      navigate('/settings?oauth_error=' + encodeURIComponent(error), { replace: true });
    } else {
      navigate('/settings', { replace: true });
    }
  }, [searchParams, navigate]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: '#888' }}>
      <p>Completing connection...</p>
    </div>
  );
};

export default OAuthCallback;
