import { Campaigns } from '../../../../client/pages/Campaigns';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Campaigns campaignId={id} />;
}
