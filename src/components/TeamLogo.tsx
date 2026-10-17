import { teamLogoAsset } from '../../shared/types';

/** Both newly selected SVG logos and existing team records use this renderer. */
export function TeamLogo({
  logo,
  label = '',
}: {
  logo: string | null | undefined;
  label?: string;
}) {
  return (
    <img className="team-logo-art" src={teamLogoAsset(logo)} alt={label} width="160" height="160" />
  );
}
