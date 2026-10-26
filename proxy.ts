import { NextResponse,type NextRequest } from 'next/server';

/** Nonce the Next bootstrap scripts without permitting arbitrary inline scripts. */
export function proxy(request:NextRequest){
  const nonce=Buffer.from(crypto.randomUUID()).toString('base64');
  const development=process.env.NODE_ENV==='development';
  const csp=[
    "default-src 'self'",`script-src 'self' 'nonce-${nonce}'${development?" 'unsafe-eval'":''}`,
    "style-src 'self' 'unsafe-inline'","img-src 'self' data: https:",
    `connect-src 'self'${development?' ws: wss:':''}`,"frame-src 'self'","frame-ancestors 'none'",
    "form-action 'self'","object-src 'none'","base-uri 'self'",
    ...(request.nextUrl.protocol==='https:'?['upgrade-insecure-requests']:[]),
  ].join('; ');
  const headers=new Headers(request.headers);headers.set('x-nonce',nonce);headers.set('Content-Security-Policy',csp);
  const response=NextResponse.next({request:{headers}});
  response.headers.set('Content-Security-Policy',csp);
  response.headers.set('Cache-Control','no-store');
  response.headers.set('Cross-Origin-Opener-Policy','same-origin');
  return response;
}
export const config={matcher:['/((?!api(?:/|$)|healthz(?:/|$)|email-images(?:/|$)|internal(?:/|$)|t(?:/|$)|unsubscribe(?:/|$)|_next/|import-template\\.csv|favicon\\.ico).*)']};
