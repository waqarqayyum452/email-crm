'use client';
import {Field} from './ui';
import type {Row} from './api';
const units={seconds:1,minutes:60,hours:3600,days:86400};
export function campaignDelayLabel(step:Row){const seconds=step.delay_seconds;return seconds==null?step.delay_days+' days':seconds%3600===0?seconds/3600+' hours':seconds%60===0?seconds/60+' minutes':seconds+' seconds';}
export function CampaignDelay({step,index,onChange}:{step:Row;index:number;onChange:(change:Row)=>void}){
  const seconds=step.delay_seconds;
  const unit: keyof typeof units=step.delay_unit||(seconds==null?'days':seconds>0&&seconds%3600===0?'hours':seconds>0&&seconds%60===0?'minutes':'seconds');
  const amount=seconds==null?Number(step.delay_days)||3:seconds/units[unit];
  const set=(value:number,next: keyof typeof units)=>onChange(next==='days'?{delay_unit:next,delay_days:value,delay_seconds:null}:{delay_unit:next,delay_seconds:value*units[next],delay_days:0});
  return <div className="campaign-delay"><Field label={'Delay before email '+(index+1)}><input type="number" min={1} max={unit==='days'?365:Math.floor(31536000/units[unit])} value={amount} onChange={e=>set(Number(e.target.value),unit)}/></Field><Field label={'Delay unit for email '+(index+1)}><select value={unit} onChange={e=>{const next=e.target.value as keyof typeof units;set(Math.max(1,Math.min(next==='days'?365:Math.floor(31536000/units[next]),Math.ceil(amount*units[unit]/units[next]))),next);}}>{Object.keys(units).map(value=><option key={value} value={value}>{value}</option>)}</select></Field></div>;
}
