import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui';

export function PracticeHelpPage() {
  const { t } = useTranslation();

  return (
    <>
      <PageHeader
        title={t('practiceHelp.title')}
        subtitle={t('practiceHelp.subtitle')}
        actions={
          <Link className="button button--primary" to="/student/practice">
            {t('practiceHelp.startPractice')}
          </Link>
        }
      />
      <div className="practice-help">
        <Card className="practice-help__intro">
          <div>
            <h2>{t('practiceHelp.goalTitle')}</h2>
            <p>{t('practiceHelp.goal')}</p>
          </div>
          <div className="practice-help__example" aria-hidden="true">
            <span>2</span>
            <b>+</b>
            <span>2</span>
            <b>→</b>
            <span>4</span>
          </div>
        </Card>
        <div className="practice-help__grid">
          <Card className="practice-help__card">
            <h2>{t('practiceHelp.controlsTitle')}</h2>
            <p>{t('practiceHelp.controls')}</p>
          </Card>
          <Card className="practice-help__card">
            <h2>{t('practiceHelp.movementTitle')}</h2>
            <p>{t('practiceHelp.movement')}</p>
          </Card>
          <Card className="practice-help__card">
            <h2>{t('practiceHelp.scoreTitle')}</h2>
            <p>{t('practiceHelp.score')}</p>
          </Card>
          <Card className="practice-help__card">
            <h2>{t('practiceHelp.finishTitle')}</h2>
            <p>{t('practiceHelp.finish')}</p>
          </Card>
        </div>
        <p className="practice-help__return">{t('practiceHelp.returnToGame')}</p>
      </div>
    </>
  );
}
