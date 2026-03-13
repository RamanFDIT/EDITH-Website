import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import NavBar from './components/NavBar/NavBar.jsx';
import { NavBarProvider } from './components/NavBar/NavBarContext.jsx';
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import Settings from './Pages/Settings/Settings.jsx';
import Intro from './Pages/Intro/Intro.jsx';
import Onboarding from './Pages/Onboarding/Onboarding.jsx';
import ConnectionPage from './Pages/ConnectionPage/ConnectionPage.jsx';
import Home from './Pages/Home/Home.jsx';
import Login from './Pages/Login/Login.jsx';
import OAuthCallback from './Pages/OAuthCallback/OAuthCallback.jsx';

const hideNavBarRoutes = ['/', '/login', '/onboarding', '/connectionPage', '/oauth/callback'];

function ProtectedRoute({ children }) {
  const { currentUser, loading } = useAuth();
  if (loading) return null;
  if (!currentUser) return <Navigate to="/login" />;
  return children;
}

function AppContent() {
  const location = useLocation();
  const showNavBar = !hideNavBarRoutes.includes(location.pathname);

  return (
    <NavBarProvider>
      <div className="min-h-screen bg-[#0a0a0a]">
        {showNavBar && <NavBar />}
        <Routes>
          <Route path="/" element={<Intro />} />
          <Route path="/login" element={<Login />} />
          <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
          <Route path="/connectionPage" element={<ProtectedRoute><ConnectionPage /></ProtectedRoute>} />
          <Route path="/home" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
          <Route path="/oauth/callback" element={<OAuthCallback />} />
        </Routes>
      </div>
    </NavBarProvider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
