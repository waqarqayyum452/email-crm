export interface ThreadMessage {
  id: string;
  account_id: string;
  direction: string;
  from_email: string;
  to_email: string;
  message_id: string;
  in_reply_to?: string | null;
  references_json?: unknown;
  received_at: Date | string;
  created_at: Date | string;
  [key: string]: any;
}

export function conversationParticipant(message: ThreadMessage) {
  return String(message.direction === 'inbound' ? message.from_email : message.to_email).trim().toLowerCase();
}

function headerIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const ids = value.match(/<[^<>\s]+>/g) || [value.trim()];
  return ids.filter(id => id.length > 0 && id.length <= 254 && !/[\s\x00-\x1f]/.test(id));
}

function references(message: ThreadMessage) {
  let refs = message.references_json;
  if (typeof refs === 'string') {
    try { refs = JSON.parse(refs); } catch { refs = []; }
  }
  return [...new Set([...headerIds(message.in_reply_to), ...(Array.isArray(refs) ? refs.slice(-100).flatMap(headerIds) : [])])];
}

const timestamp = (value: Date | string) => new Date(value).getTime() || 0;
export const chronological = (a: ThreadMessage, b: ThreadMessage) => timestamp(a.received_at) - timestamp(b.received_at) || timestamp(a.created_at) - timestamp(b.created_at) || a.id.localeCompare(b.id);

/** Header-based conversations, isolated by mailbox AND external participant.
 * A new compose has no parent references, even if its recipient/subject matches.
 * Virtual ancestors preserve threads when the original email is not in the CRM.
 */
export function groupConversations<T extends ThreadMessage>(messages: T[]) {
  const parents = new Map<string, string>(), ranks = new Map<string, number>();
  const scopes = new Map<string, string>(), knownHeaders = new Map<string, Set<string>>();
  const find = (key: string): string => {
    if (!parents.has(key)) { parents.set(key, key); ranks.set(key, 0); }
    let root = key;
    while (parents.get(root) !== root) root = parents.get(root)!;
    while (key !== root) { const next = parents.get(key)!; parents.set(key, root); key = next; }
    return root;
  };
  const join = (a: string, b: string) => {
    let left = find(a), right = find(b);
    if (left === right) return;
    if (ranks.get(left)! < ranks.get(right)!) [left, right] = [right, left];
    parents.set(right, left);
    if (ranks.get(left) === ranks.get(right)) ranks.set(left, ranks.get(left)! + 1);
  };
  for (const message of messages) {
    const participant = conversationParticipant(message);
    const scope = JSON.stringify([message.account_id, participant || message.id]);
    scopes.set(message.id, scope);
    find(message.id);
    const [own] = headerIds(message.message_id);
    if (own) {
      join(message.id, JSON.stringify([scope, own]));
      const key = JSON.stringify([message.account_id, own]);
      const owners = knownHeaders.get(key) || new Set<string>();
      owners.add(scope); knownHeaders.set(key, owners);
    }
  }
  for (const message of messages) {
    const scope = scopes.get(message.id)!;
    for (const reference of references(message)) {
      const owners = knownHeaders.get(JSON.stringify([message.account_id, reference]));
      if (owners && (owners.size !== 1 || !owners.has(scope))) continue;
      join(message.id, JSON.stringify([scope, reference]));
    }
  }
  const groups = new Map<string, T[]>();
  for (const message of messages) {
    const key = find(message.id), group = groups.get(key) || [];
    group.push(message); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    group.sort(chronological);
    // Created-at is server-owned, so a newly received backdated reply cannot
    // replace the conversation's existing navigation anchor.
    const root = [...group].sort((a,b) => timestamp(a.created_at) - timestamp(b.created_at) || chronological(a,b))[0];
    return { root, latest: group[group.length - 1], messages: group };
  }).sort((a,b) => chronological(b.latest, a.latest));
}
