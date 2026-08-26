import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function LoadingBlock() {
  const { t } = useTranslation();
  return (
    <div className="state-block" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{t('common.loading')}</span>
    </div>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="state-block state-block--empty">
      <span className="empty-mark" aria-hidden="true">
        2048
      </span>
      <p>{title}</p>
      {action}
    </div>
  );
}

export function Alert({
  message,
  tone = 'error',
}: {
  message: string;
  tone?: 'error' | 'success' | 'info';
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {message}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal ${wide ? 'modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id="modal-title">{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t('a11y.closeDialog')}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  );
}

export function Pagination({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label={t('common.pageOf', { page, pages })}>
      <button
        type="button"
        className="button button--ghost"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        {t('common.previous')}
      </button>
      <span>{t('common.pageOf', { page, pages })}</span>
      <button
        type="button"
        className="button button--ghost"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        {t('common.next')}
      </button>
    </nav>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <span className={`status-badge status-badge--${status}`}>{t(`status.${status}`)}</span>;
}
