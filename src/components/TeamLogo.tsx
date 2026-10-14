import { teamLogoAsset, teamLogoGlyph } from '../../shared/types';

/** Both newly selected SVG logos and existing team records use this renderer. */
export function TeamLogo({
  logo,
  label = '',
}: {
  logo: string | null | undefined;
  label?: string;
}) {
  const source = teamLogoAsset(logo);
  return source ? (
    <img className="team-logo-art" src={source} alt={label} width="160" height="160" />
  ) : (
    <span
      className="team-logo-art team-logo-art--legacy"
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      {teamLogoGlyph(logo)}
    </span>
  );
}
