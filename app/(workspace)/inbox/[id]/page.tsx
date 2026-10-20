import { InboxPage } from '../../../../client/pages/Inbox';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InboxPage messageId={id} />;
}
