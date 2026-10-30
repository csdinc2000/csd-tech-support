import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '../lib/supabase.js';

export function Login() {
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate('/');
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) navigate('/');
    });

    return () => listener.subscription.unsubscribe();
  }, [navigate]);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-white">CSD Call Manager</h1>
          <p className="text-sm text-gray-500 mt-1">Computer Systems Depot — Internal Tool</p>
        </div>

        <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
          <Auth
            supabaseClient={supabase}
            appearance={{
              theme: ThemeSupa,
              variables: {
                default: {
                  colors: {
                    brand: '#2563eb',
                    brandAccent: '#1d4ed8',
                    inputBackground: '#111827',
                    inputBorder: '#374151',
                    inputText: '#f9fafb',
                    inputPlaceholder: '#6b7280',
                  },
                },
              },
              style: {
                container: { color: '#f9fafb' },
                label: { color: '#d1d5db', fontSize: '13px' },
                anchor: { color: '#60a5fa' },
                message: { color: '#f87171' },
              },
            }}
            providers={[]}
            view="sign_in"
            showLinks
            redirectTo={window.location.origin}
          />
        </div>
      </div>
    </div>
  );
}
