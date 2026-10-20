import { Analytics } from '../../../../client/pages/Reporting';

export default async function CampaignAnalyticsPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  return <Analytics campaignId={campaignId} />;
}
