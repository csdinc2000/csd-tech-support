import { Navigate } from 'react-router-dom';
import type { AuthState } from '../App.js';
import { Layout } from './Layout.js';

interface Props {
  auth: AuthState;
  children: React.ReactNode;
  ownerOnly?: boolean;
}

export function PrivateRoute({ auth, children, ownerOnly = false }: Props) {
  if (auth.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400 text-sm">
        Loading…
      </div>
    );
  }

  if (!auth.session) {
    return <Navigate to="/login" replace />;
  }

  if (ownerOnly && auth.profile?.role !== 'owner') {
    return <Navigate to="/" replace />;
  }

  return (
    <Layout profile={auth.profile}>
      {children}
    </Layout>
  );
}
