import { BrowserRouter, Routes, Route } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import type { User as AppUser } from '../../types/index.js';
import { useAuth } from './hooks/useAuth.js';
import { PrivateRoute } from './components/PrivateRoute.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { Calls } from './pages/Calls.js';
import { CallDetail } from './pages/CallDetail.js';
import { Dial } from './pages/Dial.js';
import { Users } from './pages/Users.js';
import { Settings } from './pages/Settings.js';
import { Hours } from './pages/Hours.js';
import { IVRBuilder } from './pages/IVRBuilder.js';
import { Queues } from './pages/Queues.js';
import { Voicemails } from './pages/Voicemails.js';
import { Analytics } from './pages/Analytics.js';
import { Messages } from './pages/Messages.js';
import { Blacklist } from './pages/Blacklist.js';
import { Dnc } from './pages/Dnc.js';
import { Templates } from './pages/Templates.js';
import { SpamSettings } from './pages/SpamSettings.js';
import { Partners } from './pages/Partners.js';
import { EmailTemplates } from './pages/EmailTemplates.js';
import { NotificationSettings } from './pages/NotificationSettings.js';
import { Integrations } from './pages/Integrations.js';
import { Profile } from './pages/Profile.js';
import { AcceptInvite } from './pages/AcceptInvite.js';
import { AiAssistants } from './pages/AiAssistants.js';
import { AiCampaigns } from './pages/AiCampaigns.js';
import { AiSessions } from './pages/AiSessions.js';

export interface AuthState {
  session: Session | null;
  profile: AppUser | null;
  loading: boolean;
}

export default function App() {
  const auth = useAuth();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />

        <Route path="/" element={<PrivateRoute auth={auth}><Dashboard /></PrivateRoute>} />
        <Route path="/calls" element={<PrivateRoute auth={auth}><Calls /></PrivateRoute>} />
        <Route path="/calls/:id" element={<PrivateRoute auth={auth}><CallDetail profile={auth.profile} /></PrivateRoute>} />
        <Route path="/dial" element={<PrivateRoute auth={auth}><Dial /></PrivateRoute>} />
        <Route path="/voicemails" element={<PrivateRoute auth={auth}><Voicemails /></PrivateRoute>} />
        <Route path="/messages" element={<PrivateRoute auth={auth}><Messages /></PrivateRoute>} />
        <Route path="/analytics" element={<PrivateRoute auth={auth}><Analytics profile={auth.profile} /></PrivateRoute>} />

        {/* Owner-only admin */}
        <Route path="/admin/hours"     element={<PrivateRoute auth={auth} ownerOnly><Hours /></PrivateRoute>} />
        <Route path="/admin/ivr"       element={<PrivateRoute auth={auth} ownerOnly><IVRBuilder /></PrivateRoute>} />
        <Route path="/admin/queues"    element={<PrivateRoute auth={auth} ownerOnly><Queues /></PrivateRoute>} />
        <Route path="/admin/templates" element={<PrivateRoute auth={auth} ownerOnly><Templates /></PrivateRoute>} />
        <Route path="/admin/blacklist" element={<PrivateRoute auth={auth} ownerOnly><Blacklist /></PrivateRoute>} />
        <Route path="/admin/dnc"       element={<PrivateRoute auth={auth} ownerOnly><Dnc /></PrivateRoute>} />
        <Route path="/admin/spam"      element={<PrivateRoute auth={auth} ownerOnly><SpamSettings /></PrivateRoute>} />
        <Route path="/users"             element={<PrivateRoute auth={auth} ownerOnly><Users /></PrivateRoute>} />
        <Route path="/admin/partners"    element={<PrivateRoute auth={auth} ownerOnly><Partners /></PrivateRoute>} />
        <Route path="/admin/email-templates" element={<PrivateRoute auth={auth} ownerOnly><EmailTemplates /></PrivateRoute>} />
        <Route path="/admin/integrations" element={<PrivateRoute auth={auth} ownerOnly><Integrations /></PrivateRoute>} />
        <Route path="/admin/ai/assistants" element={<PrivateRoute auth={auth} ownerOnly><AiAssistants /></PrivateRoute>} />
        <Route path="/admin/ai/campaigns" element={<PrivateRoute auth={auth} ownerOnly><AiCampaigns /></PrivateRoute>} />
        <Route path="/ai/sessions" element={<PrivateRoute auth={auth}><AiSessions /></PrivateRoute>} />

        <Route path="/notifications" element={<PrivateRoute auth={auth}><NotificationSettings /></PrivateRoute>} />
        <Route path="/profile"       element={<PrivateRoute auth={auth}><Profile profile={auth.profile} /></PrivateRoute>} />
        <Route path="/settings"      element={<PrivateRoute auth={auth}><Settings profile={auth.profile} /></PrivateRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
