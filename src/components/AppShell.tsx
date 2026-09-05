import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { LanguageSwitcher } from './LanguageSwitcher';

const teacherLinks = [
  ['/teacher', 'nav.teacherHome', 'home'],
  ['/teacher/rooms', 'nav.teacherRooms', 'rooms'],
  ['/teacher/users', 'nav.teacherUsers', 'users'],
  ['/teacher/teams', 'nav.teacherTeams', 'teams'],
  ['/teacher/results', 'nav.teacherResults', 'results'],
] as const;

const studentLinks = [
  ['/student', 'nav.studentHome', 'home'],
  ['/student/results', 'nav.studentResults', 'results'],
  ['/student/team', 'nav.studentTeam', 'teams'],
  ['/student/practice', 'nav.studentPractice', 'practice'],
  ['/student/rooms', 'nav.studentRooms', 'rooms'],
] as const;

function NavGlyph({ name }: { name: string }) {
  const glyphs: Record<string, string> = {
    home: '⌂',
    rooms: '▦',
    users: '♙',
    teams: '♟',
    results: '≡',
    practice: '◆',
  };
  return (
    <span className="nav-glyph" aria-hidden="true">
      {glyphs[name]}
    </span>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const links = user?.role === 'teacher' ? teacherLinks : studentLinks;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <span className="brand__tile">2048</span>
          <span>{t('common.appName')}</span>
        </div>
        <nav className="sidebar__nav">
          {links.map(([to, label, icon], index) => (
            <NavLink
              key={to}
              to={to}
              end={index === 0}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => (isActive ? 'is-active' : '')}
            >
              <NavGlyph name={icon} />
              <span>{t(label)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <LanguageSwitcher compact />
        </div>
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label={t('common.closeMenu')}
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="menu-button"
            aria-label={t('common.openMenu')}
            onClick={() => setMobileOpen(true)}
          >
            ☰
          </button>
          <div className="topbar__spacer" />
          <LanguageSwitcher />
          <NavLink
            to="/account/password"
            className="user-chip"
            aria-label={t('account.open')}
            title={t('account.open')}
          >
            <span className="user-chip__avatar" aria-hidden="true">
              {user?.name.slice(0, 1)}
            </span>
            <span className="user-chip__text">
              <strong>{user?.name}</strong>
              <small>{user?.role === 'student' ? user.className : user?.loginId}</small>
            </span>
          </NavLink>
          <button
            type="button"
            className="button button--ghost topbar__logout"
            onClick={() => void logout()}
          >
            {t('common.logout')}
          </button>
        </header>
        <main className="page-content">
          <Outlet />
        </main>
        <nav className="bottom-nav">
          {links.map(([to, label, icon], index) => (
            <NavLink key={to} to={to} end={index === 0}>
              <NavGlyph name={icon} />
              <span>{t(label)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
