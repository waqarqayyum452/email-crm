import { notFound } from 'next/navigation';
import { SettingsPage } from '../../../../client/pages/Settings';

const sections = ['business', 'accounts', 'sending', 'tracking', 'crm', 'team'];

export default async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!sections.includes(section)) notFound();
  return <SettingsPage section={section} />;
}
