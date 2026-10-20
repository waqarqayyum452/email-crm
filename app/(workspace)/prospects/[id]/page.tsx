import { ContactDetail } from '../../../../client/pages/Contacts';

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactDetail key={id} id={id} />;
}
