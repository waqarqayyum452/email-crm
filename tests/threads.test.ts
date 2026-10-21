import { describe, expect, it } from 'vitest';
import { groupConversations, type ThreadMessage } from '../server/engine/threads.js';

function message(id:string, extra:Partial<ThreadMessage>={}):ThreadMessage {
  return {id,account_id:'mailbox-a',direction:'inbound',from_email:'person@example.test',to_email:'agency@example.test',
    message_id:`<${id}@example.test>`,subject:'Website project',references_json:[],received_at:'2026-10-21T10:00:00Z',created_at:'2026-10-21T10:00:00Z',...extra};
}
describe('email conversations',()=>{
  it('groups replies and subsequent replies into one conversation despite changed reply subjects',()=>{
    const root=message('root'),reply=message('reply',{direction:'outbound',from_email:'agency@example.test',to_email:'PERSON@example.test',in_reply_to:root.message_id,subject:'Re: Website project',created_at:'2026-10-21T10:01:00Z',received_at:'2026-10-21T10:01:00Z'});
    const latest=message('latest',{references_json:JSON.stringify([root.message_id,reply.message_id]),subject:'Updated project details',created_at:'2026-10-21T10:02:00Z',received_at:'2026-10-21T10:02:00Z'});
    const groups=groupConversations([latest,root,reply]);expect(groups).toHaveLength(1);expect(groups[0].root.id).toBe('root');expect(groups[0].latest.id).toBe('latest');expect(groups[0].messages.map(row=>row.id)).toEqual(['root','reply','latest']);
  });
  it('keeps new compose separate even with the same recipient and identical subject',()=>{
    expect(groupConversations([message('first'),message('new-compose'),message('other-subject',{subject:'A separate request'})])).toHaveLength(3);
  });
  it('never joins different participants or mailboxes using shared or forged references',()=>{
    const root=message('root');
    const other=message('other',{from_email:'someone-else@example.test',in_reply_to:root.message_id});
    const otherMailbox=message('other-mailbox',{account_id:'mailbox-b',in_reply_to:root.message_id});
    const groups=groupConversations([root,other,otherMailbox]);expect(groups).toHaveLength(3);
  });
  it('connects a shared missing ancestor without guessing from subjects',()=>{
    const groups=groupConversations([message('a',{references_json:['<missing@example.test>']}),message('b',{in_reply_to:'<missing@example.test>'}),message('separate')]);
    expect(groups.map(group=>group.messages.length).sort()).toEqual([1,2]);
  });
  it('rejects ambiguous and cross-participant known ancestors consistently',()=>{
    const foreign=message('foreign',{from_email:'foreign@example.test'});
    const groups=groupConversations([foreign,message('one',{in_reply_to:foreign.message_id}),message('two',{in_reply_to:foreign.message_id})]);
    expect(groups).toHaveLength(3);
  });
  it('handles malformed reference metadata, cycles and long reply chains without recursion',()=>{
    const rows=Array.from({length:500},(_,i)=>message(`chain-${i}`,{in_reply_to:i?`<chain-${i-1}@example.test>`:null,created_at:new Date(Date.UTC(2026,9,21,10,0,i)),received_at:new Date(Date.UTC(2026,9,21,10,0,i))}));
    rows[0].references_json='not-json';rows[0].in_reply_to=rows.at(-1)!.message_id;
    const groups=groupConversations(rows);expect(groups).toHaveLength(1);expect(groups[0].root.id).toBe('chain-0');expect(groups[0].messages).toHaveLength(500);
  });
  it('does not switch the navigation anchor for a newly received backdated reply',()=>{
    const root=message('root'),reply=message('reply',{in_reply_to:root.message_id,received_at:'2020-01-01T00:00:00Z',created_at:'2026-10-21T11:00:00Z'});
    expect(groupConversations([reply,root])[0].root.id).toBe(root.id);
  });
});
