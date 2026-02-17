import { useState, useEffect } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { Login } from './components/Login';
import { FileUpload } from './components/FileUpload';
import { Dashboard } from './components/Dashboard';
import { FileHistory } from './components/FileHistory';
import { Guide } from './components/Guide';

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history' | 'guide'>('dashboard');
  const [refreshKey, setRefreshKey] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleUploadComplete = () => {
    setRefreshKey(prev => prev + 1);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  if (!session) {
    return <Login onLoginSuccess={() => { }} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b border-gray-200 mb-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <h1 className="text-xl font-bold text-gray-900 mr-8">Hotel Accounting</h1>
              </div>
              <div className="flex sm:ml-6 sm:space-x-8">
                <button
                  onClick={() => setActiveTab('dashboard')}
                  className={`${activeTab === 'dashboard'
                    ? 'border-blue-500 text-gray-900'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium`}
                >
                  Dashboard
                </button>
                <button
                  onClick={() => setActiveTab('history')}
                  className={`${activeTab === 'history'
                    ? 'border-blue-500 text-gray-900'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium`}
                >
                  File History
                </button>
                <button
                  onClick={() => setActiveTab('guide')}
                  className={`${activeTab === 'guide'
                    ? 'border-blue-500 text-gray-900'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium`}
                >
                  Anleitung
                </button>
              </div>
            </div>
            <div className="flex items-center">
              <span className="text-sm text-gray-500 mr-4">{session.user.email}</span>
              <button
                onClick={handleLogout}
                className="text-gray-500 hover:text-gray-700 text-sm font-medium"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <FileUpload onUploadComplete={handleUploadComplete} />
            <Dashboard />
          </div>
        )}
        {activeTab === 'history' && <FileHistory key={refreshKey} />}
        {activeTab === 'guide' && <Guide />}
      </main>
    </div>
  );
}

export default App;
