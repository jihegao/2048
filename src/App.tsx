import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import type { Role } from '../shared/types';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { LoadingBlock } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { MatchPage } from './pages/student/MatchPage';
import { PracticePage } from './pages/student/PracticePage';
import { RoomLobbyPage } from './pages/student/RoomLobbyPage';
import { StudentHomePage } from './pages/student/StudentHomePage';
import { StudentResultsPage } from './pages/student/StudentResultsPage';
import { StudentRoomsPage } from './pages/student/StudentRoomsPage';
import { StudentTeamPage } from './pages/student/StudentTeamPage';
import { TeacherHomePage } from './pages/teacher/TeacherHomePage';
import { TeacherLivePage } from './pages/teacher/TeacherLivePage';
import { TeacherResultsPage } from './pages/teacher/TeacherResultsPage';
import { TeacherRoomsPage } from './pages/teacher/TeacherRoomsPage';
import { TeacherTeamsPage } from './pages/teacher/TeacherTeamsPage';
import { TeacherUsersPage } from './pages/teacher/TeacherUsersPage';

function ProtectedRoute({ role }: { role?: Role }) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="app-loading">
        <LoadingBlock />
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role)
    return <Navigate to={user.role === 'teacher' ? '/teacher' : '/student'} replace />;
  return <Outlet />;
}

function StartRoute() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="app-loading">
        <LoadingBlock />
      </div>
    );
  return (
    <Navigate to={user ? (user.role === 'teacher' ? '/teacher' : '/student') : '/login'} replace />
  );
}

function NotFoundRoute() {
  const { t } = useTranslation();
  return <Navigate to="/" replace aria-label={t('common.back')} />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<StartRoute />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path="/account/password" element={<ChangePasswordPage />} />
          </Route>
        </Route>
        <Route element={<ProtectedRoute role="teacher" />}>
          <Route element={<AppShell />}>
            <Route path="/teacher" element={<TeacherHomePage />} />
            <Route path="/teacher/rooms" element={<TeacherRoomsPage />} />
            <Route path="/teacher/rooms/:id/live" element={<TeacherLivePage />} />
            <Route path="/teacher/users" element={<TeacherUsersPage />} />
            <Route path="/teacher/teams" element={<TeacherTeamsPage />} />
            <Route path="/teacher/results" element={<TeacherResultsPage />} />
          </Route>
        </Route>
        <Route element={<ProtectedRoute role="student" />}>
          <Route element={<AppShell />}>
            <Route path="/student" element={<StudentHomePage />} />
            <Route path="/student/results" element={<StudentResultsPage />} />
            <Route path="/student/team" element={<StudentTeamPage />} />
            <Route path="/student/practice" element={<PracticePage />} />
            <Route path="/student/rooms" element={<StudentRoomsPage />} />
            <Route path="/student/rooms/:id" element={<RoomLobbyPage />} />
            <Route path="/student/rooms/:id/match" element={<MatchPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </BrowserRouter>
  );
}
