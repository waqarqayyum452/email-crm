'use client';
import {useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {useResource} from './api';
import {Button,Field,Modal,Resource} from './ui';

const live={pollIntervalMs:10000,refreshOnFocus:true,keepPreviousData:true};
export function OpenActivity({messageId,onClose}:{messageId:string;onClose:()=>void}) {
  const resource=useResource('/inbox/'+messageId+'/opens',0,live);
  const [timeZone,setTimeZone]=useState('Asia/Karachi');
  const activity=resource.data;
  const recordedTime=(value:string|null)=>{
    if(!value)return 'Not recorded';const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))return 'Not recorded';
    return new Intl.DateTimeFormat('en-GB',{timeZone,day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true,timeZoneName:'short'}).format(parsed);
  };
  return <Modal title="Email open activity" onClose={onClose}><Resource {...resource} retry={resource.reload}>{activity&&<div className="open-tracking-summary">
    <p className="panel-note">To {activity.to_email}</p><p className="open-activity-subject">{activity.subject||'(No subject)'}</p>
    <div className="open-activity-toolbar"><Field label="Activity timezone"><select value={timeZone} onChange={e=>setTimeZone(e.target.value)}><option value="Asia/Karachi">Pakistan (UTC+5)</option><option value="UTC">UTC</option></select></Field><Button variant="secondary" busy={resource.refreshing} onClick={resource.reload}><RefreshCw size={14}/>Refresh activity</Button></div>
    <p className="panel-note" role="status">{resource.refreshError?'Could not refresh. Showing the last successful check.':'Updates every 10 seconds while this window is visible.'} Last checked: {recordedTime(activity.checked_at)}</p>
    <dl><div><dt>Recorded image loads (estimated opens)</dt><dd>{activity.open_count}</dd></div><div><dt>All recorded image requests</dt><dd>{activity.raw_open_count}</dd></div><div><dt>Excluded scanner requests</dt><dd>{activity.excluded_open_count}</dd></div><div><dt>First recorded open</dt><dd>{recordedTime(activity.first_opened_at)}</dd></div><div><dt>Last recorded open</dt><dd>{recordedTime(activity.last_opened_at)}</dd></div><div><dt>Time spent reading</dt><dd>Unavailable</dd></div></dl>
    <p className="panel-note">These are image requests, not confirmed reads. Gmail may serve cached images; Outlook and other apps may cache or block images too. Privacy services can preload images before reading. Reopening an email does not always send another request. Scanner filtering is {activity.open_filter_enabled?'on':'off'}. Events are retained for {activity.tracking_retention_days} days. Reading duration is unavailable.</p>
  </div>}</Resource><div className="form-footer"><Button variant="secondary" onClick={onClose}>Close</Button></div></Modal>;
}
