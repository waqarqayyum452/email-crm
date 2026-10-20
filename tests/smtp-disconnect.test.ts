import { createServer, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { expect, it } from 'vitest';
import { smtpFailure } from '../server/engine/content.js';

it('holds a real Nodemailer post-DATA disconnect even when the library reports CONN',async()=>{
  // Local fake SMTP only: deliberately drop the final acceptance reply after
  // consuming DATA. No external DNS, mailbox, credentials, or live mail are used.
  const sockets=new Set<Socket>();let consumedData=false;
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');socket.write('220 local-test ESMTP\r\n');
    let buffer='',inData=false;
    socket.on('data',chunk=>{
      buffer+=chunk;
      if(inData){if(buffer.includes('\r\n.\r\n')){consumedData=true;socket.destroy();}return;}
      let end:number;
      while((end=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(/^EHLO|^HELO/i.test(line))socket.write('250-local-test\r\n250 PIPELINING\r\n');
        else if(/^MAIL FROM|^RCPT TO/i.test(line))socket.write('250 OK\r\n');
        else if(/^DATA$/i.test(line)){inData=true;socket.write('354 End with dot\r\n');break;}
        else if(/^QUIT$/i.test(line)){socket.end('221 Bye\r\n');break;}
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Fake SMTP did not bind');
  const transport=nodemailer.createTransport({host:'127.0.0.1',port:address.port,secure:false,ignoreTLS:true,connectionTimeout:1000,greetingTimeout:1000,socketTimeout:1000,logger:false,debug:false});
  try{
    const failure=await transport.sendMail({from:'sender@test.invalid',to:'recipient@test.invalid',subject:'Local fake SMTP regression',text:'Controlled test content'}).then(()=>null,error=>error);
    expect(consumedData).toBe(true);expect(failure).toBeInstanceOf(Error);
    expect(smtpFailure(failure,{submissionStarted:true})).toMatchObject({status:'unknown',retryable:false});
  }finally{transport.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},5000);
